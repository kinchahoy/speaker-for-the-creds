import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "../../speaker/node_modules/@hono/node-server/dist/index.mjs";
import { createApp, readConfig } from "../../speaker/server.ts";
import { freePorts, setOwnerPassword } from "../../speaker/test/owner.ts";
import type { Config } from "../src/config.ts";
import { Template } from "../src/grants.ts";
import { Catalog, pi } from "../src/pi.ts";
import { modelDoor, type Boot, type Guest } from "../src/sandbox.ts";
import { Agents } from "../src/agents.ts";

type Ws = typeof import("../../speaker/node_modules/@types/ws/index.d.ts");
const { WebSocketServer } = createRequire(import.meta.url)("../../speaker/node_modules/ws") as Ws;
const until = async (ok: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
};
const limits = { cpus: 1, memoryMiB: 512, rootfsGiB: 1, workGiB: 1, maxRuntimeHours: 1 };

/**
 * A real speaker with an approved sandbox host, and Agents over a stand-in VM: every guest command is recorded and
 * succeeds, and Pi reports "not running" so a close needs no grace period.
 */
async function fixture(t: TestContext, catalog: unknown = { mcps: {}, extensions: {} }) {
  const root = await mkdtemp(join(tmpdir(), "bottle-agents-"));
  const dirs = { configRoot: join(root, "config"), stateRoot: join(root, "state"), outputRoot: join(root, "output") };
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const app = await createApp(readConfig({ DATA_DIR: join(root, "speaker"), PUBLIC_URL: "http://localhost", ...(await freePorts()) }));
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } }) as Server;
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = { cookie: await setOwnerPassword((path, init) => fetch(url + path, init)), origin: "http://localhost" };
  const ownerPost = (path: string, body: URLSearchParams = new URLSearchParams()) =>
    fetch(`${url}/admin${path}`, { method: "POST", headers: owner, body, redirect: "manual" });
  const panel = async (name: "inbox" | "active") => (await fetch(`${url}/admin/panel/${name}`, { headers: owner })).text();

  const hostToken = "agents-host-token";
  const registered = await fetch(`${url}/_speaker/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "bottle",
      kinds: ["site", "secret", "folder", "mcp", "ext"],
      tokenHash: createHash("sha256").update(hostToken).digest("hex"),
    }),
  });
  await ownerPost(`/hosts/${((await registered.json()) as { id: string }).id}/approve`);

  // The local model's /v1/models answer, which create checks before it launches on a local model.
  const modelServer = createServer((_req, res) => res.end("{}"));
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const config = {
    ...dirs,
    bindHost: "127.0.0.1",
    controlPort: 1,
    guestPort: 2,
    maxAgents: 2,
    idleStopMinutes: 10,
    guestImage: "test",
    speaker: { url, proxyPort: 1, sshPort: 2 },
    localModel: {
      guestHost: "model.internal",
      upstream: `127.0.0.1:${(modelServer.address() as AddressInfo).port}`,
      models: [{ id: "m", label: "M", alias: "m-alias" }],
    },
    hostedProviders: [],
    herdr: false,
  } satisfies Config;
  const templates = new Map(
    [
      { id: "offline", label: "Work offline", limits, model: "m-alias" },
      { id: "web", label: "Read example.com", limits, want: ["site:example.com"], duration: "1h" },
    ].map((entry) => [entry.id, Template.parse(entry)]),
  );
  const commands: string[] = [];
  let closed = 0;
  let restartFails = false;
  let piDies = false;
  let piUp = false;
  pi.settleMs = 50;
  // The real model door over a stub upstream, wired as boot wires it; a test asks it for model calls.
  const stubs: Server[] = [modelServer];
  let askModel = async () => {};
  const boot: Boot = async (_config, live, _limits, paths, _env, speaker) => {
    const upstream = createServer((req, res) => void req.resume().on("end", () => res.writeHead(200).end("data: {}\n\n")));
    const modelConfig = { ...config, localModel: { ...config.localModel, upstream: "127.0.0.1:0" } };
    const door = createServer(modelDoor(modelConfig, live, speaker, paths.modelCalls));
    stubs.push(upstream, door);
    upstream.listen(0, "127.0.0.1");
    door.listen(0, "127.0.0.1");
    await Promise.all([once(upstream, "listening"), once(door, "listening")]);
    modelConfig.localModel.upstream = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    askModel = async () => {
      const response = await fetch(`http://127.0.0.1:${(door.address() as AddressInfo).port}/v1/chat/completions`, { method: "POST", body: '{"model":"m"}' });
      await response.text();
    };
    // Pi's session as the guest would have written it, for the archive.
    await mkdir(`${paths.work}/.pi-session`, { recursive: true });
    await writeFile(`${paths.work}/.pi-session/agent.jsonl`, `${JSON.stringify({ type: "session", id: "s1" })}\n`);
    return {
      sessionId: "bottle-test",
      exec: async (command) => {
        commands.push(command);
        // Pi is up from a dtach launch until a quit or kill (or, when the test says so, it dies at once); a restart fails when the test says so.
        if (command.includes("dtach -n")) piUp = !piDies;
        else if (command.includes("/quit") || command.startsWith("pkill -x pi || true")) piUp = false;
        if (command.startsWith("ps -eo stat=,comm=,args=")) return { exitCode: piUp ? 0 : 1, stdout: "", stderr: "" };
        if (command.startsWith("tail ")) return { exitCode: 0, stdout: "Error: cannot load /opt/notes", stderr: "" };
        return { exitCode: restartFails && command.startsWith("pkill -x pi;") ? 1 : 0, stdout: "", stderr: "" };
      },
      close: async () => void closed++,
    } satisfies Guest;
  };
  const agents = new Agents(config, templates, Catalog.parse(catalog), hostToken, boot);
  t.after(async () => {
    agents.stop();
    for (const stub of stubs) stub.close();
    for (const client of wss.clients) client.terminate();
    app.proxy.close();
    await app.stop();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    url,
    agents,
    commands,
    closed: () => closed,
    failRestarts: () => (restartFails = true),
    killPiOnLaunch: () => (piDies = true),
    ownerPost,
    panel,
    config,
    askModel: () => askModel(),
  };
}

test("a launch boots the VM, starts Pi, writes its configuration and files the template's first request", async (t) => {
  const f = await fixture(t);
  const agent = await f.agents.create({ template: "web", name: "docs" });
  assert.equal(agent.state, "idle");
  assert.equal(agent.attended, true);
  assert.ok(f.commands.includes("dtach -n /run/pi.dtach /usr/local/bin/pi-launch"), "Pi started");
  assert.match(readFileSync(`${agent.guestConfigDir}/args`, "utf8"), /--model\nm\n/);
  assert.match(readFileSync(`${agent.guestConfigDir}/APPEND_SYSTEM.md`, "utf8"), /# Task: docs/);
  const inbox = await f.panel("inbox");
  assert.match(inbox, /<strong>docs<\/strong>/);
  assert.match(inbox, /launch template web: Read example\.com/);
  assert.ok(inbox.includes('value="site:example.com"'));
  // The agent waits for the owner: the request shows as pending in its listing.
  await until(() => f.agents.pendingRequests(agent).length === 1);
  assert.equal(f.agents.pendingRequests(agent)[0]!.what, "site:example.com");
  // Without a template want, nothing is asked at launch.
  await f.agents.create({ template: "offline" });
  assert.equal((await f.panel("inbox")).match(/<article id="request-/g)?.length, 1);
});

test("an approved grant reaches the agent's live view and is reported to speaker as in force", async (t) => {
  const f = await fixture(t);
  const agent = await f.agents.create({ template: "web" });
  await until(() => f.agents.pendingRequests(agent).length === 1);
  const [request] = f.agents.pendingRequests(agent);
  const body = new URLSearchParams({ duration: "1h", items: "site:example.com", shown: "site:example.com" });
  assert.equal((await f.ownerPost(`/requests/${request!.id}/approve`, body)).status, 303);
  await until(() => agent.live.hosts.some((entry) => entry.host === "example.com"));
  assert.deepEqual(
    agent.grants.map((grant) => grant.item),
    ["site:example.com"],
  );
  assert.match(readFileSync(`${agent.outputDir}/_control/grants.jsonl`, "utf8"), /"item":"site:example.com"/);
  assert.ok(agent.live.events.some((event) => event.text === "grants now: site:example.com"));
  // Speaker hears it applied: the grant is no longer marked as waiting or granted-not-applied.
  await until(async () => {
    const active = await f.panel("active");
    return active.includes("<code>site:example.com</code>") && !active.includes("data-state=");
  });
});

test("stop asks Pi to quit, exports the transcript, archives the records, closes the VM and ends the speaker agent", async (t) => {
  const f = await fixture(t);
  const agent = await f.agents.create({ template: "offline", name: "archive me", prompt: "write DONE", attended: false });
  assert.equal(agent.attended, false);
  await writeFile(`${agent.outputDir}/artifacts/result.txt`, "result\n");
  await f.askModel();
  await f.askModel();
  await f.agents.close(agent);
  assert.equal(agent.state, "archived");
  assert.equal(f.closed(), 1);
  assert.equal(f.agents.byId.has(agent.id), false);
  assert.ok(f.commands.includes("printf '/quit\\r' | dtach -p /run/pi.dtach"), "Pi asked to quit");
  assert.ok(f.commands.some((command) => command.startsWith("pi --export /work/.pi-session/agent.jsonl")));
  const control = `${agent.outputDir}/_control`;
  const record = JSON.parse(readFileSync(`${control}/agent.json`, "utf8"));
  assert.deepEqual([record.id, record.state, record.name, record.attended], [agent.id, "archived", "archive me", false]);
  const manifest = JSON.parse(readFileSync(`${control}/manifest.json`, "utf8"));
  assert.equal(manifest.closed, true);
  assert.deepEqual(
    manifest.files.map((file: { path: string }) => file.path),
    ["result.txt"],
  );
  const calls = readFileSync(`${control}/model-calls.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2, "one line per model call");
  for (const call of calls) {
    assert.deepEqual(Object.keys(call).sort(), ["at", "durationMs", "reply", "request", "status", "truncated"]);
    assert.equal(call.status, 200);
    assert.equal(call.request, '{"model":"m"}');
    assert.equal(call.reply, "data: {}\n\n");
  }
  assert.ok(existsSync(`${control}/pi-session.jsonl`));
  assert.match(readFileSync(`${control}/policy-events.jsonl`, "utf8"), /owner began archival/);
  assert.equal(existsSync(`${f.config.stateRoot}/agents/${agent.id}`), false, "the work tree is removed");
  // The agent's speaker record is gone.
  const response = await fetch(`${f.url}/_speaker/catalog`, { headers: { authorization: `Bearer ${agent.agentToken}` } });
  assert.equal(response.status, 403);
});

test("an agent whose Pi restart failed is pi-down, and closing it still exports the transcript", async (t) => {
  const catalog = {
    mcps: {},
    extensions: { notes: { label: "Notes", guestPath: "/opt/notes", description: "Take notes", tools: ["note"], sites: [] } },
  };
  const f = await fixture(t, catalog);
  const agent = await f.agents.create({ template: "offline", name: "restarts" });
  f.failRestarts();
  await f.agents.speaker.request({ agentId: agent.speakerAgentId, want: ["ext:notes"], reason: "take notes", duration: "1h" });
  await until(() => f.agents.pendingRequests(agent).length === 1);
  const [request] = f.agents.pendingRequests(agent);
  const body = new URLSearchParams({ duration: "1h", items: "ext:notes", shown: "ext:notes" });
  assert.equal((await f.ownerPost(`/requests/${request!.id}/approve`, body)).status, 303);
  await until(() => agent.state === "pi-down");
  f.commands.length = 0;
  await f.agents.close(agent);
  assert.equal(agent.state, "archived");
  assert.ok(f.commands.includes("printf '/quit\\r' | dtach -p /run/pi.dtach"), "Pi asked to quit");
  assert.ok(
    f.commands.some((command) => command.startsWith("pi --export /work/.pi-session/agent.jsonl")),
    "transcript exported",
  );
  assert.ok(existsSync(`${agent.outputDir}/_control/pi-session.jsonl`));
});

const notes = {
  mcps: {},
  extensions: { notes: { label: "Notes", guestPath: "/opt/notes", description: "Take notes", tools: ["note"], sites: [] } },
};
const grantNotes = async (f: Awaited<ReturnType<typeof fixture>>, agent: { speakerAgentId: string }) => {
  await f.agents.speaker.request({ agentId: agent.speakerAgentId, want: ["ext:notes"], reason: "take notes", duration: "1h" });
  await until(() => f.agents.pendingRequests(agent as never).length === 1);
  const body = new URLSearchParams({ duration: "1h", items: "ext:notes", shown: "ext:notes" });
  assert.equal((await f.ownerPost(`/requests/${f.agents.pendingRequests(agent as never)[0]!.id}/approve`, body)).status, 303);
};

test("a grant that restarts Pi writes the change for the guest, and the grant is reported in force", async (t) => {
  const f = await fixture(t, notes);
  const agent = await f.agents.create({ template: "offline" });
  await grantNotes(f, agent);
  await until(() => agent.extRunning.includes("notes") && agent.state === "idle");
  assert.deepEqual(JSON.parse(readFileSync(`${agent.guestConfigDir}/change.json`, "utf8")), {
    id: 1,
    added: ["ext:notes"],
    removed: [],
    tools: { added: ["note"], removed: [] },
  });
});

test("an approved mcp: grant puts the server into Pi's MCP config, and a revoke removes it", async (t) => {
  const f = await fixture(t, {
    mcps: { files: { label: "Files", transport: "stdio", command: "/opt/mcp/files", args: ["--ro"], tools: ["read-file"], write: false } },
    extensions: {},
  });
  const agent = await f.agents.create({ template: "offline" });
  const servers = () => JSON.parse(readFileSync(`${agent.guestConfigDir}/mcp.json`, "utf8")).mcpServers;
  await f.agents.speaker.request({ agentId: agent.speakerAgentId, want: ["mcp:files"], reason: "read files", duration: "1h" });
  await until(() => f.agents.pendingRequests(agent).length === 1);
  const body = new URLSearchParams({ duration: "1h", items: "mcp:files", shown: "mcp:files" });
  assert.equal((await f.ownerPost(`/requests/${f.agents.pendingRequests(agent)[0]!.id}/approve`, body)).status, 303);
  await until(() => agent.mcpRunning.includes("files") && agent.state === "idle");
  assert.deepEqual(Object.keys(servers()), ["files"]);
  assert.equal(servers().files.command, "/opt/mcp/files");
  const grantId = agent.grants.find((grant) => grant.item === "mcp:files")!.id;
  assert.equal((await f.ownerPost("/grants/revoke", new URLSearchParams({ id: grantId }))).status, 303);
  await until(() => agent.mcpRunning.length === 0 && agent.state === "idle");
  assert.deepEqual(servers(), {});
});

test("an agent whose Pi dies right after a restart is pi-down with Pi's stderr, and the grant is not in force", async (t) => {
  const f = await fixture(t, notes);
  const agent = await f.agents.create({ template: "offline" });
  f.killPiOnLaunch();
  await grantNotes(f, agent);
  await until(() => agent.state === "pi-down");
  assert.deepEqual(agent.extRunning, []);
  assert.ok(
    agent.live.events.some((event) => event.text.includes("Pi restart failed: Pi restart: Pi exited right after launch: Error: cannot load /opt/notes")),
  );
});

test("reloading the catalog tells speaker what the host now offers and leaves running agents alone", async (t) => {
  const entry = { label: "Notes", guestPath: "/opt/notes", description: "Take notes", tools: ["note"], sites: [] };
  const f = await fixture(t, { mcps: {}, extensions: { notes: entry } });
  const agent = await f.agents.create({ template: "offline" });
  const offered = async () =>
    Object.keys(
      ((await (await fetch(`${f.url}/_speaker/catalog`, { headers: { authorization: `Bearer ${agent.agentToken}` } })).json()) as { extensions: object })
        .extensions,
    );
  await until(async () => (await offered()).includes("notes"));
  f.agents.reloadCatalog(Catalog.parse({ mcps: {}, extensions: { wiki: { ...entry, label: "Wiki", guestPath: "/opt/wiki" } } }));
  await until(async () => (await offered()).join() === "wiki");
  assert.equal(agent.state, "idle");
});
