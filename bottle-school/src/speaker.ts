import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";

export const Lease = z.object({
  id: z.string(),
  subjectId: z.string(),
  kind: z.string(),
  ref: z.string(),
  expiresAt: z.string().nullable(),
});
export type Lease = z.infer<typeof Lease>;

const RequestStatus = z.object({
  id: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired", "revoked", "superseded"]),
});
const Snapshot = z.object({
  type: z.literal("snapshot"),
  leases: z.array(Lease),
  requests: z.array(RequestStatus.extend({ subjectId: z.string(), what: z.string(), reason: z.string() })),
});
export type Snapshot = Pick<z.infer<typeof Snapshot>, "leases" | "requests">;
const Subject = z.object({ id: z.string(), token: z.string() });
export type RequestBody = {
  subjectId: string;
  capability?: { kind: string; ref: string };
  bundle?: string;
  reason: string;
  duration: string;
};

/** `bottle register` writes the enforcer token that speaker's owner approved. */
export const readEnforcerToken = (config: Config) => {
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
    createSubject: async (label: string) => Subject.parse(await call("POST", "subjects", { label })),
    deleteSubject: (id: string) => call("DELETE", `subjects/${id}`),
    request: async (body: RequestBody) => RequestStatus.parse(await call("POST", "requests", body)),
  };
};
export type Speaker = ReturnType<typeof speakerClient>;

/**
 * Holds the enforcer WebSocket. Each snapshot replaces the lease set and request statuses; a closed socket or 30 s without
 * a snapshot clears it. Returns the function that reports the in-effect lease ids.
 */
export const watchLeases = (config: Config, token: string, onSnapshot: (snapshot: Snapshot) => void) => {
  const url = new URL("/_speaker/enforcers/ws", config.speaker.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined;
  let lastSnapshot = Date.now();
  let applied = "[]";
  const send = () => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(`{"type":"applied","leaseIds":${applied}}`);
  };
  const open = () => {
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.onopen = () => {
      lastSnapshot = Date.now();
      send();
    };
    socket.onmessage = (event) => {
      lastSnapshot = Date.now();
      onSnapshot(Snapshot.parse(JSON.parse(String(event.data))));
    };
    socket.onerror = () => console.error(`speaker connection to ${url.host} failed`);
    socket.onclose = () => {
      console.error("speaker connection closed; all leases cleared; reconnecting in 5 s");
      onSnapshot({ leases: [], requests: [] });
      setTimeout(open, 5_000);
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
