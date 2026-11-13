import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ProxyAgent } from "undici";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Catalog } from "./pi.ts";

/** Speaker's items are strings (`site:x`, `folder:s:rw`, `ext:id`, `obsidian.read`); the rest of bottle-school speaks kind and ref. */
const itemKinds: Record<string, string> = { site: "site", secret: "secret", folder: "folder", mcp: "mcp", ext: "extension" };
const Grant = z
  .object({
    id: z.string(),
    agentId: z.string(),
    item: z.string(),
    expiresAt: z.string().nullable(),
    /** A secret grant names the hosts the owner bound it to (never the value). */
    hosts: z.array(z.string()).optional(),
  })
  .transform(({ agentId, item, hosts, ...grant }) => {
    const [prefix, ...rest] = item.split(":");
    return {
      ...grant,
      ...(hosts ? { hosts: hosts.map((host) => host.toLowerCase()) } : {}),
      subjectId: agentId,
      ...(rest.length ? { kind: itemKinds[prefix!] ?? prefix!, ref: rest.join(":") } : { kind: "credential", ref: item }),
    };
  });
export type Lease = z.infer<typeof Grant>;

const RequestStatus = z.object({ id: z.string(), status: z.enum(["pending", "decided", "expired"]) });
/** A secret the owner set up in speaker: its name, the hosts it may go to, and the variable the agent sets. */
const SecretInfo = z.object({ name: z.string(), hosts: z.array(z.string()), env: z.string() });
export type SecretInfo = z.infer<typeof SecretInfo>;
const Snapshot = z.object({
  type: z.literal("snapshot"),
  grants: z.array(Grant),
  secrets: z.array(SecretInfo).default([]),
  requests: z.array(
    RequestStatus.extend({ agentId: z.string(), what: z.string(), reason: z.string() }).transform(({ agentId, ...request }) => ({
      ...request,
      subjectId: agentId,
    })),
  ),
});
export type Snapshot = {
  leases: Lease[];
  requests: z.infer<typeof Snapshot>["requests"];
  /** The secrets a task may ask for; unchanged by a dropped connection. */
  secrets?: SecretInfo[];
};
const Agent = z.object({ id: z.string(), token: z.string() });
export type RequestBody = { agentId: string; want: string[]; reason: string; duration: string; sshKey?: string };

/** `bottle register` writes the sandbox host token that speaker's owner approved. */
export const readHostToken = (config: Config) => {
  const path = `${config.stateRoot}/speaker.token`;
  if (!existsSync(path)) throw new Error(`${path} is missing; run "bottle register"`);
  return readFileSync(path, "utf8").trim();
};

const Registered = z.object({ id: z.string(), proxyPort: z.number().optional(), sshPort: z.number().optional() });

/**
 * Registers this machine as a sandbox host: writes a fresh token to the state directory, asks speaker to list the host
 * for the owner's approval, and records speaker's proxy and SSH ports (which its reply carries) in config.json.
 * Returns the id the owner sees in speaker /admin.
 */
export const registerHost = async (config: Config, configPath: string, name: string) => {
  const token = randomBytes(32).toString("hex");
  const response = await fetch(`${config.speaker.url}/_speaker/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      kinds: ["secret", "site", "folder", "mcp", "ext"],
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: Error & { cause?: { code?: string } }) => {
    throw new Error(`cannot reach speaker at ${config.speaker.url} (${error.cause?.code ?? error.message}); is it running?`);
  });
  if (!response.ok) throw new Error(`speaker POST hosts returned ${response.status}: ${await response.text()}`);
  const { id, proxyPort, sshPort } = Registered.parse(await response.json());
  writeFileSync(`${config.stateRoot}/speaker.token`, token, { mode: 0o600 });
  const file = JSON.parse(readFileSync(configPath, "utf8"));
  file.speaker = { url: config.speaker.url, ...(proxyPort ? { proxyPort } : {}), ...(sshPort ? { sshPort } : {}) };
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`);
  return id;
};

/** Whether the owner has approved this host: speaker answers 401 `approval_required` to a pending or unknown token. */
export const hostApproved = async (config: Config) => {
  const response = await fetch(`${config.speaker.url}/_speaker/catalog`, {
    headers: { authorization: `Bearer ${readHostToken(config)}` },
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status !== 401;
};

export const speakerClient = (config: Config, token: string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${config.speaker.url}/_speaker/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`speaker ${method} ${path} returned ${response.status}: ${await response.text()}`);
    return response.json();
  };
  return {
    createAgent: async (label: string, agent: string) => Agent.parse(await call("POST", "hosts/agents", { label, agent })),
    deleteAgent: (id: string) => call("DELETE", `hosts/agents/${id}`),
    request: async (body: RequestBody) => RequestStatus.parse(await call("POST", "requests", body)),
    /** The placeholder speaker issued this agent for a secret it holds (what `/catalog` shows); only the agent's own token can ask. */
    placeholder: async (agentToken: string, secret: string) => {
      const response = await fetch(`${config.speaker.url}/_speaker/catalog`, {
        headers: { authorization: `Bearer ${agentToken}` },
        signal: AbortSignal.timeout(10_000),
      });
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

/**
 * The route for requests to a secret's hosts: speaker's HTTPS proxy, which swaps the agent's placeholder for the real
 * value. bottle-school authenticates as the task's agent (its token is bound to this host's address) and trusts speaker's
 * proxy certificate authority for the tunnel only; the secret itself never reaches bottle-school.
 */
export const speakerProxy = async (config: Config, agentToken: string) => {
  const { proxyPort } = config.speaker;
  if (!proxyPort)
    throw new Error("speaker.proxyPort is not set in config.json: speaker has no PROXY_PORT, or run `mise run bottle-cli register` again to learn it");
  const response = await fetch(`${config.speaker.url}/_speaker/proxy/ca.pem`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok)
    throw new Error(`speaker's proxy certificate is unavailable (HTTP ${response.status}); is PROXY_PORT set and speaker unlocked?`);
  return new ProxyAgent({
    uri: `http://${new URL(config.speaker.url).hostname}:${proxyPort}`,
    token: `Basic ${Buffer.from(`agent:${agentToken}`).toString("base64")}`,
    requestTls: { ca: await response.text() },
  });
};

/** The shares this host holds, for speaker's choice of delivery: the guest has no VM mount, its folders arrive over SSH. */
export const shareReport = (config: Config) => Object.keys(config.shareRoots).map((name) => ({ name, mount: false }));

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
const probeSpeaker = async (config: Config, token: string) => {
  try {
    // A sandbox host has no agent view: speaker answers an approved host token with 403 and an unknown one with 401.
    const response = await fetch(`${config.speaker.url}/_speaker/catalog`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (response.status === 401)
      return {
        fatal: true,
        message:
          `speaker at ${config.speaker.url} rejects this sandbox host's token (HTTP ${response.status}): it is not ` +
          `approved yet, was removed, or speaker's data was reset. Approve the sandbox host in speaker /admin, or run ` +
          `"mise run bottle-cli register" again.`,
      };
    return { fatal: false, message: `speaker answered HTTP ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
    return { fatal: false, message: `cannot reach speaker at ${config.speaker.url} (${cause})` };
  }
};

/**
 * Holds the sandbox host WebSocket. Each snapshot replaces the lease set and request statuses. When speaker has not been
 * heard for `dropMs` (30 s: connection lost, or snapshots stopped) every lease is dropped until the next snapshot. It
 * reconnects with backoff, but calls `onFatal` instead of retrying forever: at once when speaker rejects the token, after
 * SPEAKER_LIMITS.firstConnectMs if speaker was never reached, and after SPEAKER_LIMITS.outageMs of continuous outage. On
 * every connection it reports the shares it holds. Returns the function that reports the in-effect lease ids; its `stop`
 * closes the connection and ends the reconnecting.
 */
export const watchLeases = (
  config: Config,
  token: string,
  onSnapshot: (snapshot: Snapshot) => void,
  onFatal: (message: string) => void,
  limits = SPEAKER_LIMITS,
  catalog: Catalog = { mcps: {}, extensions: {} },
) => {
  const url = new URL("/_speaker/hosts/ws", config.speaker.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // The connection: `connecting` until speaker first answers, `open` while connected, `down` after losing it, and
  // `stopped` for good (stop() or a fatal error).
  let state: "connecting" | "open" | "down" | "stopped" = "connecting";
  let socket: WebSocket | undefined;
  let lastHeard = Date.now();
  let downSince = Date.now();
  let backoff = limits.retryMs;
  let retryTimer: NodeJS.Timeout | undefined;
  let dropped = false;
  let applied = "[]";
  const fail = (message: string) => {
    if (state === "stopped") return;
    state = "stopped";
    onFatal(message);
  };
  const retry = async () => {
    const probe = await probeSpeaker(config, token);
    if (state === "stopped") return;
    if (probe.fatal) return fail(probe.message);
    const down = Date.now() - downSince;
    if (down >= (state === "down" ? limits.outageMs : limits.firstConnectMs))
      return fail(
        `${probe.message}; gave up after ${Math.round(down / 1000)} s without speaker. ` +
          `Check that speaker is running and that speaker.url is right in the bottle-school config.json.`,
      );
    console.error(`${probe.message}; grants are dropped after ${limits.dropMs / 1000} s without speaker; retrying in ${backoff / 1000} s`);
    retryTimer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, limits.maxBackoffMs);
  };
  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const open = () => {
    if (state === "stopped") return;
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.onopen = () => {
      if (state === "connecting") console.log(`speaker connected at ${config.speaker.url}`);
      state = "open";
      backoff = limits.retryMs;
      lastHeard = Date.now();
      send({ type: "shares", shares: shareReport(config) });
      send({ type: "catalog", ...catalogReport(catalog) });
      send({ type: "applied", grantIds: JSON.parse(applied) });
    };
    socket.onmessage = (event) => {
      lastHeard = Date.now();
      dropped = false;
      const { grants, requests, secrets } = Snapshot.parse(JSON.parse(String(event.data)));
      onSnapshot({ leases: grants, requests, secrets });
    };
    socket.onclose = () => {
      if (state === "stopped") return;
      if (state === "open") {
        state = "down";
        downSince = Date.now();
      }
      void retry();
    };
  };
  const dropTimer = setInterval(() => {
    if (dropped || Date.now() - lastHeard < limits.dropMs) return;
    dropped = true;
    console.error(`no word from speaker for ${limits.dropMs / 1000} s; all grants dropped until it is back`);
    onSnapshot({ leases: [], requests: [] });
  }, Math.min(1_000, limits.dropMs / 4)).unref();
  open();
  const report = (leaseIds: string[]) => {
    const next = JSON.stringify([...leaseIds].sort());
    if (next === applied) return;
    applied = next;
    send({ type: "applied", grantIds: leaseIds });
  };
  const stop = () => {
    state = "stopped";
    clearInterval(dropTimer);
    clearTimeout(retryTimer);
    socket?.close();
  };
  return Object.assign(report, { stop });
};
