import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";

/** Speaker's items are strings (`site:x`, `folder:s:rw`, `ext:id`, `obsidian.read`); the rest of bottle-school speaks kind and ref. */
const itemKinds: Record<string, string> = { site: "site", secret: "secret", folder: "folder", mcp: "mcp", ext: "extension" };
const Grant = z
  .object({ id: z.string(), agentId: z.string(), item: z.string(), expiresAt: z.string().nullable() })
  .transform(({ agentId, item, ...grant }) => {
    const [prefix, ...rest] = item.split(":");
    return {
      ...grant,
      subjectId: agentId,
      ...(rest.length ? { kind: itemKinds[prefix!] ?? prefix!, ref: rest.join(":") } : { kind: "credential", ref: item }),
    };
  });
export type Lease = z.infer<typeof Grant>;

const RequestStatus = z.object({ id: z.string(), status: z.enum(["pending", "decided", "expired"]) });
const Snapshot = z.object({
  type: z.literal("snapshot"),
  grants: z.array(Grant),
  requests: z.array(
    RequestStatus.extend({ agentId: z.string(), what: z.string(), reason: z.string() }).transform(({ agentId, ...request }) => ({
      ...request,
      subjectId: agentId,
    })),
  ),
});
export type Snapshot = { leases: Lease[]; requests: z.infer<typeof Snapshot>["requests"] };
const Agent = z.object({ id: z.string(), token: z.string() });
export type RequestBody = { agentId: string; want: string[]; reason: string; duration: string };

/** `bottle register` writes the sandbox host token that speaker's owner approved. */
export const readHostToken = (config: Config) => {
  const path = `${config.stateRoot}/speaker.token`;
  if (!existsSync(path)) throw new Error(`${path} is missing; run "bottle register"`);
  return readFileSync(path, "utf8").trim();
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
  };
};
export type Speaker = ReturnType<typeof speakerClient>;

/** How long the service may run without reaching speaker before it gives up: at startup, and after losing it. */
export const SPEAKER_LIMITS = { firstConnectMs: 30_000, outageMs: 5 * 60_000, maxBackoffMs: 30_000 };

/**
 * Classifies why speaker can't be used: an auth answer (401/403) is fatal — the token is unknown (speaker data reset or a
 * different speaker), not yet approved, or denied — while anything else (network error, 5xx) may clear up.
 */
const probeSpeaker = async (config: Config, token: string) => {
  try {
    // A sandbox host has no agent view: speaker answers an approved host token with 403 and an unknown one with 401.
    const response = await fetch(`${config.speaker.url}/_speaker/me`, {
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
 * Holds the sandbox host WebSocket. Each snapshot replaces the lease set and request statuses; a closed socket or 30 s without
 * a snapshot clears it. Reconnects with backoff, but calls `onFatal` instead of retrying forever: at once when speaker
 * rejects the token, after SPEAKER_LIMITS.firstConnectMs if speaker was never reached, and after SPEAKER_LIMITS.outageMs
 * of continuous outage. Returns the function that reports the in-effect lease ids.
 */
export const watchLeases = (
  config: Config,
  token: string,
  onSnapshot: (snapshot: Snapshot) => void,
  onFatal: (message: string) => void,
) => {
  const url = new URL("/_speaker/hosts/ws", config.speaker.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined;
  let lastSnapshot = Date.now();
  let applied = "[]";
  let connected = false;
  let downSince = Date.now();
  let backoff = 5_000;
  let stopped = false;
  const fail = (message: string) => {
    if (stopped) return;
    stopped = true;
    onFatal(message);
  };
  const retry = async () => {
    const probe = await probeSpeaker(config, token);
    if (probe.fatal) return fail(probe.message);
    const limit = connected ? SPEAKER_LIMITS.outageMs : SPEAKER_LIMITS.firstConnectMs;
    const down = Date.now() - downSince;
    if (down >= limit)
      return fail(
        `${probe.message}; gave up after ${Math.round(down / 1000)} s without speaker. ` +
          `Check that speaker is running and that speaker.url is right in the bottle-school config.json.`,
      );
    console.error(`${probe.message}; all leases cleared; retrying in ${backoff / 1000} s`);
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, SPEAKER_LIMITS.maxBackoffMs);
  };
  const send = () => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(`{"type":"applied","grantIds":${applied}}`);
  };
  const open = () => {
    if (stopped) return;
    let opened = false;
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.onopen = () => {
      opened = true;
      if (!connected) console.log(`speaker connected at ${config.speaker.url}`);
      connected = true;
      backoff = 5_000;
      lastSnapshot = Date.now();
      send();
    };
    socket.onmessage = (event) => {
      lastSnapshot = Date.now();
      const { grants, requests } = Snapshot.parse(JSON.parse(String(event.data)));
      onSnapshot({ leases: grants, requests });
    };
    socket.onclose = () => {
      if (opened) downSince = Date.now();
      onSnapshot({ leases: [], requests: [] });
      void retry();
    };
  };
  setInterval(() => {
    if (Date.now() - lastSnapshot < 30_000) return;
    lastSnapshot = Date.now();
    console.error("no speaker snapshot for 30 s; all leases cleared");
    onSnapshot({ leases: [], requests: [] });
  }, 5_000).unref();
  open();
  return (leaseIds: string[]) => {
    const next = JSON.stringify([...leaseIds].sort());
    if (next === applied) return;
    applied = next;
    send();
  };
};
