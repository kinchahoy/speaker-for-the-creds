import { readFileSync } from "node:fs";
import { z } from "zod";
import { durationNames, type ErrorCode } from "../../speaker/items.ts";

const Limits = z
  .object({
    cpus: z.number().int().min(1),
    memoryMiB: z.number().int().min(128),
    rootfsGiB: z.number().int().min(1),
    workGiB: z.number().int().min(1),
    maxRuntimeHours: z.number().positive(),
    /** Spend cap: model requests per task. */
    maxModelRequests: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A launch template is the runtime profile speaker does not decide (VM limits, attended mode) plus what the task starts
 * with: a `want` list of items and groups, named by its `label` and asked for over `duration`. Speaker shows that as the
 * task's first request; the task starts at once and works on whatever needs no new access while the owner decides.
 */
export const Template = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** What the task is, as the owner would say it: the label on the task's request card. */
    label: z.string().min(1).max(120),
    limits: Limits,
    /** Forces attended (true) or unattended (false) launches; unset, the launch decides. */
    attended: z.boolean().optional(),
    /** Items and groups the task asks for at launch (for example `group:developer`, `site:pypi.org`, `notes.read`). */
    want: z.array(z.string().trim().min(1)).max(50).default([]),
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

/** A failure with the HTTP status the control API answers it with: 400 bad input, 404 unknown task, 409 wrong state, 502 speaker failed. */
export class StatusError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  readonly next?: string;
  constructor(status: StatusError["status"], message: string, next?: string) {
    super(message);
    this.status = status;
    if (next !== undefined) this.next = next;
  }
}

/** The task's first request to speaker, from its template's want list (plus items the launch itself needs); none if empty. */
export const launchRequest = (template: Template, agentId: string, extra: string[] = []) => {
  const want = [...new Set([...template.want, ...extra])];
  return want.length ? { agentId, want, reason: `launch template ${template.id}: ${template.label}`, duration: template.duration } : undefined;
};

/**
 * Attended means the owner is at the terminal to answer questions. A launch prompt implies the owner walked away;
 * no prompt implies the owner will attach and type. A template's `attended` overrides that default, and a launch
 * that contradicts it fails rather than silently losing the owner's choice.
 */
export const attendedFor = (template: Template, input: { prompt?: string; attended?: boolean }) => {
  if (template.attended !== undefined && input.attended !== undefined && input.attended !== template.attended)
    throw new StatusError(400, `template ${template.id} is always ${template.attended ? "attended" : "unattended"}`);
  return template.attended ?? input.attended ?? input.prompt === undefined;
};

export const loadTemplates = (path: string) => {
  const templates = z.array(Template).parse(JSON.parse(readFileSync(path, "utf8")));
  if (new Set(templates.map(({ id }) => id)).size !== templates.length) throw new Error("templates repeat an id");
  return new Map(templates.map((template) => [template.id, template]));
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
      (method === "GET" && /^\/_speaker\/(health|catalog|help(?:\/[a-zA-Z0-9_-]+)?)$/.test(path)) ||
      (method === "GET" && /^\/_speaker\/requests\/[a-zA-Z0-9_-]+$/.test(path)) ||
      (method === "POST" && path === "/_speaker/requests")
    );
  const service = /^\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(path)?.[1];
  return service !== undefined && service !== "admin" && !modelServices.includes(service) && !path.startsWith("/_");
};
