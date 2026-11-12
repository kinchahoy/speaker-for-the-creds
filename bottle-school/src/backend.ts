import type { Dispatcher } from "undici";
import type { Config } from "./config.ts";
import { hostMatches, unexpired, type Timed } from "./leases.ts";

export type HttpResponseRecord = {
  at: string;
  method: string;
  destination: string;
  requestHeaders: Record<string, string>;
  status: number;
  responseHeaders: Record<string, string>;
  durationMs: number;
  bytes?: number;
  complete: boolean;
  error?: string;
  requestCapture: "complete" | "truncated" | "metadata_only" | "empty";
  responseCapture: "complete" | "truncated" | "metadata_only" | "empty";
  requestBody?: CapturedBody;
  responseBody?: CapturedBody;
};

export type CapturedBody = {
  path: string;
  contentType?: string;
  capturedBytes: number;
  totalBytes: number;
  limitBytes: number;
  truncated: boolean;
};

/** The live lease view every backend reads. Each speaker snapshot replaces these entries; every use checks expiry. */
export type Live = {
  hosts: (Timed & { host: string })[];
  /** Granted `secret:` items and the hosts speaker bound them to. Requests to these hosts go through speaker's proxy. */
  secretHosts: (Timed & { name: string; hosts: string[] })[];
  /** Folder grants: host directory and mode. The backend turns each into whatever mount its runtime uses. */
  shares: Map<string, Timed & { root: string; writable: boolean }>;
  events: { at: string; text: string }[];
  httpResponses: HttpResponseRecord[];
  httpResponsesOmitted: number;
  httpBodyBytes: number;
  /** Spend cap: model requests allowed so far, the owner's limit, and whether the refusal was recorded. */
  modelRequests: number;
  maxModelRequests?: number;
  modelCapNoted: boolean;
};


export type Guest = {
  /** Backend session id; `Backend.attach` turns it into the owner's terminal command. */
  sessionId: string;
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close: () => Promise<void>;
};

/**
 * What a sandbox runtime provides. `boot` starts one VM for a task: deny-by-default egress decided by the live view
 * (hosts, secret hosts routed through `proxy`, the model-request cap), folders from `live.shares` mounted under /input
 * and following later changes, `paths` mounted at /work, /output and /etc/pi-v2, and model and other text request bodies
 * recorded into `live.httpResponses` with their blobs under `paths.capture`. Grant changes need no VM call: the backend
 * re-reads `live` on every use.
 */
export type Backend = {
  boot: (
    config: Config,
    live: Live,
    limits: { cpus: number; memoryMiB: number; rootfsGiB: number },
    paths: { work: string; artifacts: string; guestConfig: string; capture: string },
    env: Record<string, string>,
    speaker: { url: string; token: string },
    proxy: () => Promise<Dispatcher>,
  ) => Promise<Guest>;
  /** The owner's terminal into a running guest, as a command to spawn. */
  attach: (sessionId: string, command: string[]) => { file: string; args: string[] };
  /** Drop records of VMs a crashed service left behind; returns how many. */
  reconcile: () => Promise<number>;
};

export const note = (live: Pick<Live, "events">, text: string) => {
  live.events.push({ at: new Date().toISOString(), text });
  if (live.events.length > 2_000) live.events.splice(0, live.events.length - 2_000);
};

/** Gondolin's request hook can only allow or refuse, so a refused model request gets Gondolin's fixed 403. */
export const countModelRequest = (live: Live) => {
  if (live.maxModelRequests === undefined || live.modelRequests < live.maxModelRequests) {
    live.modelRequests += 1;
    return true;
  }
  if (!live.modelCapNoted)
    note(live, `model request limit ${live.maxModelRequests} reached; the owner can raise it`);
  live.modelCapNoted = true;
  return false;
};

/**
 * Where requests to a granted secret's hosts go: through speaker's proxy, which holds the value and swaps the agent's
 * placeholder in. `allow` answers for those hosts (undefined for every other host, which the rest of the policy decides);
 * `dispatcher` is the upstream route Gondolin must use for them. The proxy connection is made at first use.
 */
export const secretRoute = (live: Pick<Live, "secretHosts" | "events">, proxy: () => Promise<Dispatcher>) => {
  let viaSpeaker: Dispatcher | undefined;
  const covered = (host: string) =>
    hostMatches(unexpired(live.secretHosts).flatMap((entry) => entry.hosts), host);
  return {
    allow: async (host: string) => {
      if (!covered(host)) return undefined;
      try {
        viaSpeaker ??= await proxy();
        return true;
      } catch (error) {
        // Never fall back to a direct request: the placeholder would reach the real host instead of the secret.
        note(live, `blocked a request to ${host}: ${(error as Error).message}`);
        return false;
      }
    },
    dispatcher: (host: string) => {
      if (!covered(host)) return undefined;
      if (!viaSpeaker) throw new Error(`speaker's proxy is not connected; refusing a direct request to ${host}`);
      return viaSpeaker;
    },
    close: async () => void (await viaSpeaker?.close()),
  };
};

