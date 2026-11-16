import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hc as honoClient } from "hono/client";
import { ProxyAgent } from "undici";
import { z } from "zod";
import { durationNames } from "../../speaker/items.ts";
import type { SpeakerApi } from "../../speaker/api.ts";
import type { Config } from "./config.ts";
import type { Catalog } from "./pi.ts";

/** A grant as speaker sends it: an item (`site:x`, `folder:s:rw`, `ext:id`, `obsidian.read`) for one agent. */
const Grant = z.object({
  id: z.string(),
  agentId: z.string(),
  item: z.string(),
  expiresAt: z.string().nullable(),
  /** A secret grant names the hosts the owner bound it to (never the value). */
  hosts: z.array(z.string().toLowerCase()).optional(),
});
export type Grant = z.infer<typeof Grant>;

const RequestStatus = z.object({ id: z.string(), status: z.enum(["pending", "decided", "expired"]) });
/** A secret the owner set up in speaker: its name, the hosts it may go to, and the variable the agent sets. */
const SecretInfo = z.object({ name: z.string(), hosts: z.array(z.string()), env: z.string() });
export type SecretInfo = z.infer<typeof SecretInfo>;
const Snapshot = z.object({
  type: z.literal("snapshot"),
  grants: z.array(Grant),
  secrets: z.array(SecretInfo).default([]),
  requests: z.array(RequestStatus.extend({ agentId: z.string(), what: z.string(), reason: z.string() })),
});
export type Snapshot = {
  grants: Grant[];
  requests: z.infer<typeof Snapshot>["requests"];
  /** The secrets an agent may ask for; unchanged by a dropped connection. */
  secrets?: SecretInfo[];
};
const SpeakerAgent = z.object({ id: z.string(), token: z.string() }).transform(({ id, token }) => ({ id, agentToken: token }));
export type RequestBody = { agentId: string; want: string[]; reason: string; duration: (typeof durationNames)[number]; sshKey?: string };

/** `bottle register` writes the sandbox host token that speaker's owner approved. */
export const readHostToken = (config: Config) => {
  const path = `${config.stateRoot}/speaker.token`;
  if (!existsSync(path)) throw new Error(`${path} is missing; run "bottle register"`);
  return z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, `${path} is not a host token; run "bottle register"`)
    .parse(readFileSync(path, "utf8"));
};

/** Speaker's typed client: a wrong path or body shape fails `tsc`. */
export const speakerApi = (config: Config, token?: string) =>
  honoClient<SpeakerApi>(config.speaker.url, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } })._speaker;

const Registered = z.object({ id: z.string(), proxyPort: z.number(), sshPort: z.number() });

/**
 * Registers this machine as a sandbox host: writes a fresh token to the state directory, asks speaker to list the host
 * for the owner's approval, and records speaker's proxy and SSH ports (which its reply carries) in config.json.
 * Returns the id the owner sees in speaker /admin.
 */
export const registerHost = async (config: Config, configPath: string, name: string) => {
  const token = randomBytes(32).toString("hex");
  const response = await speakerApi(config)
    .hosts.$post(
      { json: { name, kinds: ["secret", "site", "folder", "mcp", "ext"], tokenHash: createHash("sha256").update(token).digest("hex") } },
      { init: { signal: AbortSignal.timeout(10_000) } },
    )
    .catch((error: Error & { cause?: { code?: string } }) => {
      throw new Error(`cannot reach speaker at ${config.speaker.url} (${error.cause?.code ?? error.message}); is it running?`);
    });
  if (!response.ok) throw new Error(`speaker POST hosts returned ${response.status}: ${await response.text()}`);
  const { id, proxyPort, sshPort } = Registered.parse(await response.json());
  writeFileSync(`${config.stateRoot}/speaker.token`, token, { mode: 0o600 });
  const file = z.looseObject({}).parse(JSON.parse(readFileSync(configPath, "utf8")));
  file.speaker = { url: config.speaker.url, proxyPort, sshPort };
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`);
  return id;
};

/** Whether the owner has approved this host: speaker answers `GET /_speaker/hosts/self` 200 for an approved host token, 401 for a pending or unknown one. */
export const hostApproved = async (config: Config) => {
  const response = await speakerApi(config, readHostToken(config)).hosts.self.$get({}, { init: { signal: AbortSignal.timeout(10_000) } });
  await response.body?.cancel();
  return response.ok;
};

export const speakerClient = (config: Config, hostToken: string) => {
  const api = speakerApi(config, hostToken);
  // A fresh signal per call: one shared AbortSignal.timeout fires once and then aborts every later call at once.
  const timeout = () => ({ init: { signal: AbortSignal.timeout(10_000) } });
  const check = async (what: string, response: Pick<Response, "ok" | "status" | "text" | "json">) => {
    if (!response.ok) throw new Error(`speaker ${what} returned ${response.status}: ${await response.text()}`);
    return response.json();
  };
  return {
    /** `launched`: the extensions the template gave at launch, so speaker records and shows them (it does not grant them). */
    createAgent: async (label: string, agent: string, launched: string[] = []) =>
      SpeakerAgent.parse(await check("POST hosts/agents", await api.hosts.agents.$post({ json: { label, agent, launched } }, timeout()))),
    deleteAgent: async (id: string) => check(`DELETE hosts/agents/${id}`, await api.hosts.agents[":id"].$delete({ param: { id } }, timeout())),
    request: async (body: RequestBody) => RequestStatus.parse(await check("POST requests", await api.requests.$post({ json: body }, timeout()))),
  };
};
export type Speaker = ReturnType<typeof speakerClient>;

/** Speaker's proxy certificate authority: secret hosts are TLS-terminated there, so the guest and bottle's tunnel must trust it. */
export const speakerCa = async (config: Config) => {
  const response = await speakerApi(config)["proxy"]["ca.pem"].$get({}, { init: { signal: AbortSignal.timeout(10_000) } });
  if (!response.ok) throw new Error(`speaker's proxy certificate is unavailable (HTTP ${response.status}); is speaker unlocked?`);
  return response.text();
};

/**
 * The route for requests to a secret's hosts: speaker's HTTPS proxy, which swaps the agent's placeholder for the real
 * value. bottle authenticates as the agent (its token is bound to this host's address) and trusts speaker's
 * proxy certificate authority (`ca`, from speakerCa) for the tunnel only; the secret itself never reaches bottle.
 */
export const speakerProxy = (config: Config, agentToken: string, ca: string) => {
  return new ProxyAgent({
    uri: `http://${new URL(config.speaker.url).hostname}:${config.speaker.proxyPort}`,
    token: `Basic ${Buffer.from(`agent:${agentToken}`).toString("base64")}`,
    requestTls: { ca },
  });
};

/** What this host's catalog offers, for speaker's list of what an agent may ask for and its checks of `mcp:` and `ext:` items. */
export const catalogReport = (catalog: Catalog) => ({
  mcps: Object.entries(catalog.mcps).map(([id, { label, tools }]) => ({ id, label, tools })),
  extensions: Object.entries(catalog.extensions).map(([id, { label, description, tools, sites }]) => ({ id, label, description, tools, sites })),
});

/** When bottle has not heard from speaker for this long it can no longer hear a revoke, so every grant is dropped until speaker is back. */
export const DROP_MS = 30_000;

/**
 * Holds the sandbox host WebSocket, reconnecting for ever. Each snapshot replaces the grant set and request statuses.
 * After `dropMs` without a word from speaker every grant is dropped until the next snapshot. The catalog, applied ids and
 * titles are reported on every connect. `status()` is one line for people; it is logged when the link changes state.
 */
export const watchGrants = (
  config: Config,
  hostToken: string,
  onSnapshot: (snapshot: Snapshot) => void,
  catalog: Catalog = { mcps: {}, extensions: {} },
  { dropMs = DROP_MS, retryMs = 5_000, stopMs = 300_000, onGone = (_why: string) => {} } = {},
) => {
  const url = new URL("/_speaker/hosts/ws", config.speaker.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let heardAt = Date.now();
  let dropped = false;
  let applied = "[]";
  let titles = "{}";
  let up = false;
  let since = new Date();
  let lastError = "not connected yet";
  const status = () => (up ? `connected to ${config.speaker.url}` : `reconnecting since ${since.toLocaleTimeString()}: ${lastError}`);
  const change = (next: boolean) => {
    if (up === next) return;
    up = next;
    since = new Date();
    console.log(`speaker: ${status()}`);
  };
  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const open = () => {
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${hostToken}` } });
    socket.onopen = () => {
      change(true);
      send({ type: "catalog", ...catalogReport(catalog) });
      send({ type: "applied", grantIds: JSON.parse(applied) });
      send({ type: "titles", titles: JSON.parse(titles) });
    };
    socket.onmessage = (event) => {
      heardAt = Date.now();
      dropped = false;
      const { grants, requests, secrets } = Snapshot.parse(JSON.parse(String(event.data)));
      onSnapshot({ grants, requests, secrets });
    };
    socket.onerror = (event) => {
      lastError = (event as ErrorEvent).message || "connection failed";
    };
    socket.onclose = async () => {
      if (stopped) return;
      // Why: speaker says so itself when it is locked or does not know this host; no answer means it is down.
      const answer = await fetch(new URL("/_speaker/hosts/self", config.speaker.url), { headers: { authorization: `Bearer ${hostToken}` } }).catch(
        () => undefined,
      );
      if (answer && !answer.ok)
        lastError = ((await answer.json().catch(() => ({}))) as { message?: string }).message ?? `speaker answered HTTP ${answer.status}`;
      change(false);
      // A speaker that is down (not merely locked) for stopMs ends bottle: no grant can apply without it.
      if (!answer && Date.now() - since.getTime() > stopMs)
        return onGone(`cannot reach speaker at ${config.speaker.url} for ${Math.round(stopMs / 60_000)} min`);
      timer = setTimeout(open, retryMs);
    };
  };
  const dropTimer = setInterval(
    () => {
      if (dropped || Date.now() - heardAt < dropMs) return;
      dropped = true;
      console.error(`no word from speaker for ${dropMs / 1000} s; all grants dropped until it is back`);
      onSnapshot({ grants: [], requests: [] });
    },
    Math.min(1_000, dropMs / 4),
  ).unref();
  open();
  const report = (grantIds: string[]) => {
    const next = JSON.stringify([...grantIds].sort());
    if (next === applied) return;
    applied = next;
    send({ type: "applied", grantIds });
  };
  /** Replaces the catalog this host offers and reports it at once. */
  const setCatalog = (next: Catalog) => {
    catalog = next;
    send({ type: "catalog", ...catalogReport(catalog) });
  };
  /** Reports each agent's title (by speaker agent id), on connect and whenever one changes. */
  const setTitles = (next: Record<string, string>) => {
    if (JSON.stringify(next) === titles) return;
    titles = JSON.stringify(next);
    send({ type: "titles", titles: next });
  };
  const stop = () => {
    stopped = true;
    clearInterval(dropTimer);
    clearTimeout(timer);
    socket?.close();
  };
  return Object.assign(report, { stop, status, catalog: setCatalog, titles: setTitles });
};
