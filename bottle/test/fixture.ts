// A real speaker in this process, a fake upstream, and bottle's parts that need no micro-VM: its agents registry over a
// stand-in VM, and the same doors a guest reaches (speakerDoor, modelDoor) served on localhost ports.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "../../speaker/node_modules/@hono/node-server/dist/index.mjs";
import { createApp, readConfig } from "../../speaker/server.ts";
import { freePort, ownerPassword } from "../../speaker/test/fixture.ts";
import { Agents } from "../src/agents.ts";
import type { Config } from "../src/config.ts";
import { Template } from "../src/grants.ts";
import { startControl } from "../src/server.ts";
import { Catalog, pi } from "../src/pi.ts";
import { modelDoor, speakerDoor, type Boot, type Guest, type Live } from "../src/sandbox.ts";

const freePorts = async () => ({ PROXY_PORT: String(await freePort()), SSH_PORT: String(await freePort()) });
const sessionCookie = (response: Response) => {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("speaker_session="));
  if (!cookie) throw new Error("No session cookie in the response");
  return cookie.split(";")[0];
};
/** Sets the owner password through the first-run form and returns the session cookie. */
const setOwnerPassword = async (call: (path: string, init?: RequestInit) => Promise<Response>) => {
  const response = await call("/admin/setup", {
    method: "POST",
    headers: { origin: "http://localhost" },
    body: new URLSearchParams({ password: ownerPassword, confirm: ownerPassword }),
    redirect: "manual",
  });
  if (response.status !== 303) throw new Error(`Setting the owner password answered ${response.status}`);
  return sessionCookie(response);
};

type Ws = typeof import("../../speaker/node_modules/@types/ws/index.d.ts");
const { WebSocketServer } = createRequire(import.meta.url)("../../speaker/node_modules/ws") as Ws;

export const port = (server: Server) => (server.address() as AddressInfo).port;
export const until = async (ok: () => boolean | Promise<boolean>, timeoutMs = 8_000) => {
  for (const start = Date.now(); !(await ok()); await sleep(20)) if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
};
export const listen = async (server: Server, at = 0) => {
  server.listen(at, "127.0.0.1");
  await once(server, "listening");
  return server;
};
const close = (server: Server) => {
  server.closeAllConnections();
  server.close();
};

/** A fake upstream that records every call it gets. */
export const upstream = async (t: TestContext) => {
  const seen: { url?: string; authorization?: string }[] = [];
  const server = await listen(
    createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      req.resume().on("end", () => res.setHeader("content-type", "text/plain").end("upstream"));
    }),
  );
  t.after(() => close(server));
  return { seen, url: `http://127.0.0.1:${port(server)}` };
};

/** A speaker the owner has set up, which can be stopped and started again on the same port and data folder (it then comes back locked). */
export async function startSpeaker(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "bottle-speaker-"));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ services: {}, groups: {} }));
  const at = await freePort();
  const url = `http://127.0.0.1:${at}`;
  let running: { app: Awaited<ReturnType<typeof createApp>>; server: Server; wss: InstanceType<Ws["WebSocketServer"]> } | undefined;
  let token: string | undefined;
  const listenOn = (app: Awaited<ReturnType<typeof createApp>>) => {
    const wss = new WebSocketServer({ noServer: true });
    const server = serve({ fetch: app.fetch, port: at, hostname: "127.0.0.1", websocket: { server: wss } }) as Server;
    running = { app, server, wss };
    return once(server, "listening");
  };
  const start = async () => void (await listenOn(await createApp(readConfig({ DATA_DIR: dataDir, PUBLIC_URL: "http://localhost", ...(await freePorts()) }))));
  /** Cuts the network to speaker without restarting it, and heals it. */
  const cut = () => {
    for (const client of running!.wss.clients) client.terminate();
    close(running!.server);
  };
  const heal = () => listenOn(running!.app);
  const stop = async () => {
    if (!running) return;
    const { app, server, wss } = running;
    running = token = undefined;
    for (const client of wss.clients) client.terminate();
    app.proxy.closeAllConnections();
    app.proxy.close();
    await app.stop();
    close(server);
  };
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();
  let cookie = await setOwnerPassword((path, init) => fetch(url + path, init));
  const post = (path: string, headers: Record<string, string>, body: string | URLSearchParams) =>
    fetch(`${url}/admin${path}`, { method: "POST", headers: { origin: "http://localhost", ...headers }, body, redirect: "manual" });
  /** Owner JSON API (what the Herdr mod uses); it signs in again after a restart. */
  const owner = async (path: string, body?: object) => {
    token ??= (
      (await (await post("/api/signin", { "content-type": "application/json" }, JSON.stringify({ password: ownerPassword }))).json()) as { token: string }
    ).token;
    const response = await fetch(`${url}/admin/api${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response.status === 204 ? undefined : response.json();
  };
  const pending = async () => ((await owner("/pending")) as { pending: { id: string; items: { item: string }[] }[] }).pending;
  const decide = async (id: string, verdict: "approve" | "deny" = "approve") => void (await owner(`/requests/${id}/${verdict}`, { duration: "1h" }));
  /** Owner forms that have no JSON route: services, secrets, host approval. */
  const form = async (path: string, fields: Record<string, string>) => {
    const response = await post(path, { cookie }, new URLSearchParams(fields));
    if (response.status !== 303) throw new Error(`${path} answered ${response.status}`);
  };
  let hostId = "";
  /** A sandbox host the owner has approved, as its token. */
  const host = async (kinds = ["site", "secret", "folder", "mcp", "ext"]) => {
    const hostToken = "host-token";
    const created = await fetch(`${url}/_speaker/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bottle", kinds, tokenHash: createHash("sha256").update(hostToken).digest("hex") }),
    });
    hostId = ((await created.json()) as { id: string }).id;
    await form(`/hosts/${hostId}/approve`, {});
    return hostToken;
  };
  /** After a restart speaker keeps the host but not its approval. */
  const approveAgain = async () => {
    cookie = sessionCookie(await post("/signin", {}, new URLSearchParams({ password: ownerPassword })));
    await form(`/hosts/${hostId}/approve`, {});
  };
  return { url, owner, pending, decide, form, host, approveAgain, start, stop, cut, heal };
}

/** Speaker with services behind a fake upstream, and bottle's agents over a stand-in VM with one hosted model. */
export async function startBottle(t: TestContext) {
  const speaker = await startSpeaker(t);
  const up = await upstream(t);
  const save = (id: string, path: string, secret?: string) =>
    speaker.form("/services/save", { id, baseUrl: `${up.url}${path}`, authType: "bearer", read: "ask", write: "ask", ...(secret ? { secret } : {}) });
  await save("plain", "/plain", "plain-key");
  await save("svc", "/svc", "svc-key");
  await save("svc:narrow", "/svc/narrow");
  await save("llm", "/llm", "llm-key");
  await speaker.form("/secrets/save", { name: "RELEASED", value: "released-value", release: "on" });
  const hostToken = await speaker.host();

  const root = await mkdtemp(join(tmpdir(), "bottle-agents-"));
  const dirs = { stateRoot: join(root, "state"), outputRoot: join(root, "output") };
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const config = {
    ...dirs,
    bindHost: "127.0.0.1",
    controlPort: await freePort(),
    guestPort: 2,
    maxAgents: 2,
    idleStopMinutes: 10,
    guestImage: "test",
    speaker: { url: speaker.url, proxyPort: 1, sshPort: 2 },
    localModel: { guestHost: "model.internal", models: [] },
    hostedProviders: [{ id: "hosted", service: "llm", models: [{ id: "m", label: "M" }] }],
    herdr: false,
  } as unknown as Config;
  const limits = { cpus: 1, memoryMiB: 512, rootfsGiB: 1, workGiB: 1, maxRuntimeHours: 1, maxModelRequests: 2 };
  const work = {
    id: "work",
    label: "Work on things",
    limits,
    model: "hosted/m",
    want: ["plain.read", "svc:narrow.read", "site:example.com", "ext:notes", "secret:RELEASED"],
    duration: "1h",
  };
  const catalog = Catalog.parse({
    mcps: {},
    extensions: { notes: { label: "Notes", guestPath: "/opt/notes", description: "Take notes", tools: ["note"], sites: ["notes.example.com"] } },
  });
  // The guest's side: the doors it reaches, on localhost ports, and a Pi that is up once dtach has started it.
  const doors = { speaker: "", model: "" };
  const servers: Server[] = [];
  let piUp = false;
  pi.settleMs = 50;
  const boot: Boot = async (cfg, live: Live, _limits, paths, _env, access) => {
    const speakerEntry = await listen(createServer(speakerDoor(access, "ssh-ed25519 AAAA", ["llm"])));
    const modelEntry = await listen(createServer(modelDoor(cfg, live, access, paths.modelCalls)));
    servers.push(speakerEntry, modelEntry);
    Object.assign(doors, { speaker: `http://127.0.0.1:${port(speakerEntry)}`, model: `http://127.0.0.1:${port(modelEntry)}` });
    return {
      sessionId: "bottle-test",
      exec: async (command) => {
        if (command.includes("dtach -n")) piUp = true;
        else if (command.includes("/quit") || command.startsWith("pkill -x pi || true")) piUp = false;
        const probe = command.startsWith("ps -eo stat=,comm=,args=") || command.startsWith("ps -C pi");
        return { exitCode: probe && !piUp ? 1 : 0, stdout: "", stderr: "" };
      },
      close: async () => {},
    } satisfies Guest;
  };
  config.templates = [Template.parse(work)];
  const agents = new Agents(config, catalog, hostToken, boot);
  t.after(() => {
    agents.stop();
    servers.forEach(close);
    return rm(root, { recursive: true, force: true });
  });
  /** What the guest does: a call to the speaker door with a dummy credential, which the door replaces with the agent's. */
  const guestCall = (path: string) => fetch(`${doors.speaker}${path}`, { headers: { authorization: "Bearer guest-dummy" } });
  /** Launches the template and has the owner approve its one card. */
  const launch = async () => {
    const agent = await agents.create({ template: "work" });
    const [card, ...more] = await until(async () => (await speaker.pending()).length > 0).then(() => speaker.pending());
    return { agent, card: card!, more, approve: () => speaker.decide(card!.id) };
  };
  return { speaker, up, agents, config, doors, guestCall, hostToken, catalog, launch };
}

/** Starts the control API, whose listener startControl does not hand back, and closes it when the test ends. */
export const control = (t: TestContext, ...args: Parameters<typeof startControl>) => {
  const made: Server[] = [];
  const real = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...rest: Parameters<typeof real>) {
    made.push(this);
    return real.apply(this, rest);
  } as typeof real;
  startControl(...args);
  Server.prototype.listen = real;
  t.after(() => made.forEach(close));
};
