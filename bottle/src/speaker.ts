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
  /** The secrets a task may ask for; unchanged by a dropped connection. */
  secrets?: SecretInfo[];
};
const Agent = z.object({ id: z.string(), token: z.string() }).transform(({ id, token }) => ({ id, agentToken: token }));
export type RequestBody = { agentId: string; want: string[]; reason: string; duration: (typeof durationNames)[number]; sshKey?: string };

/** `bottle register` writes the sandbox host token that speaker's owner approved. */
export const readHostToken = (config: Config) => {
  const path = `${config.stateRoot}/speaker.token`;
  if (!existsSync(path)) throw new Error(`${path} is missing; run "bottle register"`);
  return readFileSync(path, "utf8").trim();
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
  const file = JSON.parse(readFileSync(configPath, "utf8"));
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
  const timeout = { init: { signal: AbortSignal.timeout(10_000) } };
  const check = async (what: string, response: Pick<Response, "ok" | "status" | "text" | "json">) => {
    if (!response.ok) throw new Error(`speaker ${what} returned ${response.status}: ${await response.text()}`);
    return response.json();
  };
  return {
    createAgent: async (label: string, agent: string) =>
      Agent.parse(await check("POST hosts/agents", await api.hosts.agents.$post({ json: { label, agent } }, timeout))),
    deleteAgent: async (id: string) => check(`DELETE hosts/agents/${id}`, await api.hosts.agents[":id"].$delete({ param: { id } }, timeout)),
    request: async (body: RequestBody) => RequestStatus.parse(await check("POST requests", await api.requests.$post({ json: body }, timeout))),
    /** The placeholder speaker issued this agent for a secret it holds (what `/catalog` shows); only the agent's own token can ask. */
    placeholder: async (agentToken: string, secret: string) => {
      const response = await speakerApi(config, agentToken).catalog.$get({}, timeout);
      if (!response.ok) throw new Error(`speaker GET catalog returned ${response.status}: ${await response.text()}`);
      const { secrets = {} } = Me.parse(await response.json());
      const placeholder = secrets[secret]?.placeholder;
      if (!placeholder) throw new Error(`speaker shows no active grant of secret ${secret} for this task`);
      return placeholder;
    },
  };
};
const Me = z.object({ secrets: z.record(z.string(), z.object({ placeholder: z.string() })).optional() });
export type Speaker = ReturnType<typeof speakerClient>;

/** Speaker's proxy certificate authority: secret hosts are TLS-terminated there, so the guest and bottle's tunnel must trust it. */
export const speakerCa = async (config: Config) => {
  const response = await speakerApi(config)["proxy"]["ca.pem"].$get({}, { init: { signal: AbortSignal.timeout(10_000) } });
  if (!response.ok) throw new Error(`speaker's proxy certificate is unavailable (HTTP ${response.status}); is speaker unlocked?`);
  return response.text();
};

/**
 * The route for requests to a secret's hosts: speaker's HTTPS proxy, which swaps the agent's placeholder for the real
 * value. bottle authenticates as the task's agent (its token is bound to this host's address) and trusts speaker's
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

/**
 * How long the service may run without reaching speaker: at startup, and after losing it. After `dropMs` without
 * speaker's snapshots the agents' grants are dropped until it is back.
 */
export const SPEAKER_LIMITS = { firstConnectMs: 30_000, outageMs: 5 * 60_000, retryMs: 5_000, maxBackoffMs: 30_000, dropMs: 30_000 };

/**
 * Classifies why speaker can't be used: an auth answer (401/403) is fatal — the token is unknown (speaker data reset or a
 * different speaker), not yet approved, or denied — while anything else (network error, 5xx) may clear up.
 */
const probeSpeaker = async (config: Config, hostToken: string) => {
  try {
    const response = await fetch(`${config.speaker.url}/_speaker/hosts/self`, {
      headers: { authorization: `Bearer ${hostToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (response.status === 401)
      return {
        fatal: true,
        message:
          `speaker at ${config.speaker.url} rejects this sandbox host's token (HTTP ${response.status}): it is not ` +
          `approved yet, was removed, or speaker's data was reset. Approve the sandbox host in speaker /admin, or run ` +
          `"mise run bottle register" again.`,
      };
    return { fatal: false, message: response.ok ? "speaker answered but the connection failed" : `speaker answered HTTP ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
    return { fatal: false, message: `cannot reach speaker at ${config.speaker.url} (${cause})` };
  }
};

/**
 * The link to speaker. `connecting` until speaker first answers, `open` while connected, `down` after losing it,
 * `stopped` for good (stop() or a fatal error). `heardAt` is when speaker last spoke. `stale` is a link silent for
 * `dropMs`: every grant was dropped until the next snapshot, whatever the connection is doing (`was`). `since` is when the
 * outage began.
 */
type Link =
  | { state: "connecting" | "down"; since: number; heardAt: number }
  | { state: "open"; heardAt: number }
  | { state: "stale"; since: number; was: "connecting" | "down" | "open" }
  | { state: "stopped" };
type Outage = Exclude<Link, { state: "open" | "stopped" }>;

/**
 * Holds the sandbox host WebSocket. Each snapshot replaces the grant set and request statuses. When speaker has not been
 * heard for `dropMs` (30 s: connection lost, or snapshots stopped) every grant is dropped until the next snapshot. It
 * reconnects with backoff, but calls `onFatal` instead of retrying forever: at once when speaker rejects the token, after
 * SPEAKER_LIMITS.firstConnectMs if speaker was never reached, and after SPEAKER_LIMITS.outageMs of continuous outage. On
 * every connection it reports its catalog. Returns the function that reports the in-effect grant ids; its `stop`
 * closes the connection and ends the reconnecting.
 */
export const watchGrants = (
  config: Config,
  hostToken: string,
  onSnapshot: (snapshot: Snapshot) => void,
  onFatal: (message: string) => void,
  limits = SPEAKER_LIMITS,
  catalog: Catalog = { mcps: {}, extensions: {} },
) => {
  const url = new URL("/_speaker/hosts/ws", config.speaker.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let link: Link = { state: "connecting", since: Date.now(), heardAt: Date.now() };
  let socket: WebSocket | undefined;
  let backoff = limits.retryMs;
  let retryTimer: NodeJS.Timeout | undefined;
  let applied = "[]";
  const fail = (message: string) => {
    if (link.state === "stopped") return;
    link = { state: "stopped" };
    onFatal(message);
  };
  const retry = async (outage: Outage) => {
    const probe = await probeSpeaker(config, hostToken);
    if (link.state === "stopped") return;
    if (probe.fatal) return fail(probe.message);
    const down = Date.now() - outage.since;
    const reached = outage.state === "stale" ? outage.was !== "connecting" : outage.state === "down";
    if (down >= (reached ? limits.outageMs : limits.firstConnectMs))
      return fail(
        `${probe.message}; gave up after ${Math.round(down / 1000)} s without speaker. ` +
          `Check that speaker is running and that speaker.url is right in the bottle config.json.`,
      );
    console.error(`${probe.message}; grants are dropped after ${limits.dropMs / 1000} s without speaker; retrying in ${backoff / 1000} s`);
    retryTimer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, limits.maxBackoffMs);
  };
  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const open = () => {
    if (link.state === "stopped") return;
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${hostToken}` } });
    socket.onopen = () => {
      if (link.state === "stopped") return;
      if (link.state === "connecting") console.log(`speaker connected at ${config.speaker.url}`);
      // A stale link stays stale until the first snapshot arrives.
      link = link.state === "stale" ? { ...link, was: "open" } : { state: "open", heardAt: Date.now() };
      backoff = limits.retryMs;
      send({ type: "catalog", ...catalogReport(catalog) });
      send({ type: "applied", grantIds: JSON.parse(applied) });
    };
    socket.onmessage = (event) => {
      if (link.state === "stopped") return;
      link = { state: "open", heardAt: Date.now() };
      const { grants, requests, secrets } = Snapshot.parse(JSON.parse(String(event.data)));
      onSnapshot({ grants, requests, secrets });
    };
    socket.onclose = () => {
      if (link.state === "stopped") return;
      if (link.state === "open") link = { state: "down", since: Date.now(), heardAt: link.heardAt };
      else if (link.state === "stale" && link.was === "open") link = { state: "stale", since: Date.now(), was: "down" };
      void retry(link);
    };
  };
  const dropTimer = setInterval(
    () => {
      if (link.state === "stopped" || link.state === "stale" || Date.now() - link.heardAt < limits.dropMs) return;
      link = { state: "stale", since: link.state === "open" ? Date.now() : link.since, was: link.state };
      console.error(`no word from speaker for ${limits.dropMs / 1000} s; all grants dropped until it is back`);
      onSnapshot({ grants: [], requests: [] });
    },
    Math.min(1_000, limits.dropMs / 4),
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
  const stop = () => {
    link = { state: "stopped" };
    clearInterval(dropTimer);
    clearTimeout(retryTimer);
    socket?.close();
  };
  return Object.assign(report, { stop, catalog: setCatalog });
};
