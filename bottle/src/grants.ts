import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { durationNames, type ErrorCode } from "../../speaker/items.ts";

const Limits = z
  .object({
    cpus: z.number().int().min(1),
    memoryMiB: z.number().int().min(128),
    rootfsGiB: z.number().int().min(1),
    workGiB: z.number().int().min(1),
    maxRuntimeHours: z.number().positive(),
    /** Spend cap: model requests per agent. */
    maxModelRequests: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A launch template is the runtime profile speaker does not decide (VM limits) plus what the agent starts
 * with: a `want` list of items and groups, named by its `label` and asked for over `duration`. Speaker shows that as the
 * agent's first request; the agent starts at once and works on whatever needs no new access while the owner decides.
 */
export const Template = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** What the agent is, as the owner would say it: the label on the agent's request card. */
    label: z.string().min(1).max(120),
    limits: Limits,
    /** The default model (an id or alias) when the launch names none. */
    model: z.string().min(1).optional(),
    /** Items and groups the agent asks for at launch (for example `group:developer`, `site:pypi.org`, `notes.read`). */
    want: z.array(z.string().trim().min(1)).max(50).default([]),
    /** Host folders bottle mounts into every agent from this template, as `<path>[:rw]` (`~` is the owner's home); see `launchFolders`. */
    folders: z.array(z.string().min(1)).max(10).default([]),
    /** How long the first request asks for. */
    duration: z.enum(durationNames).default("2h"),
  })
  .strict();
export type Template = z.infer<typeof Template>;

/** The error code for each status bottle answers with, the same codes speaker uses (see `errorBody`). */
export const codes = {
  400: "invalid",
  401: "denied",
  403: "denied",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  500: "internal_error",
  502: "upstream_unavailable",
} as const satisfies Record<number, ErrorCode>;

/** A failure with the HTTP status the control API answers it with: 400 bad input, 404 unknown agent, 409 wrong state, 502 speaker failed. */
export class StatusError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  readonly next?: string;
  constructor(status: StatusError["status"], message: string, next?: string) {
    super(message);
    this.status = status;
    if (next !== undefined) this.next = next;
  }
}

/**
 * The extensions a template gives at launch without a card: the owner wrote the template and started it, so that is the
 * decision. Only extensions that bring no sites; anything that opens the network or reaches a service still asks speaker.
 */
export const givenAtLaunch = (template: Template, extensions: Record<string, { sites: string[] }>) =>
  template.want.filter((item) => item.startsWith("ext:") && extensions[refOf(item)]?.sites.length === 0).map(refOf);

/** The agent's first request to speaker, from its template's want list (less what launch gives, plus items the launch itself needs); none if empty. */
export const launchRequest = (template: Template, agentId: string, extra: string[] = [], given: string[] = []) => {
  const want = [...new Set([...template.want.filter((item) => !given.includes(refOf(item)) || !item.startsWith("ext:")), ...extra])];
  return want.length ? { agentId, want, reason: `launch template ${template.id}: ${template.label}`, duration: template.duration } : undefined;
};

/** An entry carries its own expiry; every use compares it with the current time. */
export type Timed = { expiresAt: string | null };
export const unexpired = <T extends Timed>(entries: T[]) => entries.filter((entry) => entry.expiresAt === null || Date.parse(entry.expiresAt) > Date.now());

/** What follows an item's kind prefix: `example.com` for `site:example.com`, `docs:rw` for `folder:docs:rw`; a service item is its own ref. */
export const refOf = (item: string) => item.slice(item.indexOf(":") + 1);

/** Speaker owns approvals and the item grammar (speaker/items.ts); bottle adds the stricter shape of a site ref. */
const host = z.hostname().refine((value) => value === value.toLowerCase());
export const siteRef = z.union([
  host,
  z
    .string()
    .startsWith("*.")
    .refine((value) => host.safeParse(value.slice(2)).success),
]);
/** A `secret:<NAME>` grant names a secret in speaker and arrives with the hosts the owner bound it to. */
export const secretHosts = z.array(siteRef).min(1);

/** Guests may use only the agent-facing speaker API and service proxy. */
/** `modelServices`: the speaker services behind hosted models, reached only through the model door (its cap and model-calls.jsonl). */
export const speakerRequestAllowed = (speaker: URL, url: URL, method: string, modelServices: string[]) => {
  if (url.origin !== speaker.origin) return false;
  const path = url.pathname;
  if (path.startsWith("/_speaker/"))
    return (
      (method === "GET" && /^\/_speaker\/(health|catalog|help(?:\/[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?)?)$/.test(path)) ||
      (method === "GET" && /^\/_speaker\/(requests|secrets)\/[a-zA-Z0-9_-]+$/.test(path)) ||
      (method === "POST" && (path === "/_speaker/requests" || /^\/_speaker\/browser\/[a-zA-Z0-9_-]+$/.test(path)))
    );
  // A service, or a scope of one (`service:scope`); a scope of a hosted model's service is as closed as the service.
  const service = /^\/([a-zA-Z0-9_-]+)(?::[a-zA-Z0-9_-]+)?(?:\/|$)/.exec(path)?.[1];
  return service !== undefined && service !== "admin" && !modelServices.includes(service) && !path.startsWith("/_");
};

/**
 * Host folders the owner names at launch (`<absolute path or ~/…>[:rw]`), bind-mounted by bottle without speaker: the launch
 * itself is the owner's approval. Read-write ones appear at /space/<folder name>, read-only ones at /input/<folder name>.
 */
export const launchFolders = (specs: string[]) => {
  const folders = specs.map((spec) => {
    const writable = spec.endsWith(":rw");
    const raw = writable ? spec.slice(0, -3) : spec;
    const path = raw === "~" || raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
    if (!isAbsolute(path)) throw new StatusError(400, `folder ${spec} must be an absolute path or start with ~/`);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new StatusError(400, `folder ${path} does not exist; create it (mkdir -p ${path})`);
    return { path, writable, mount: `${writable ? "/space" : "/input"}/${basename(path)}` };
  });
  const clash = folders.find((folder, index) => folders.findIndex((other) => other.mount === folder.mount) !== index);
  if (clash) throw new StatusError(400, `two folders would both mount at ${clash.mount}; rename one`);
  return folders;
};
