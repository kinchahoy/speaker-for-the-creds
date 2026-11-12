import { isIPv4 } from "node:net";
import { readFileSync } from "node:fs";
import { z } from "zod";

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
    duration: z.enum(["30m", "1h", "2h", "1d", "30d"]).default("2h"),
  })
  .strict();
export type Template = z.infer<typeof Template>;

/** The task's first request to speaker, from its template's want list (plus items the launch itself needs); none if empty. */
export const launchRequest = (template: Template, agentId: string, extra: string[] = []) => {
  const want = [...new Set([...template.want, ...extra])];
  return want.length
    ? { agentId, want, reason: `launch template ${template.id}: ${template.label}`, duration: template.duration }
    : undefined;
};

/**
 * Attended means the owner is at the terminal to answer questions. A launch prompt implies the owner walked away;
 * no prompt implies the owner will attach and type. A template's `attended` overrides that default, and a launch
 * that contradicts it fails rather than silently losing the owner's choice.
 */
export const attendedFor = (template: Template, input: { prompt?: string; attended?: boolean }) => {
  if (template.attended !== undefined && input.attended !== undefined && input.attended !== template.attended)
    throw new Error(`template ${template.id} is always ${template.attended ? "attended" : "unattended"}`);
  return template.attended ?? input.attended ?? input.prompt === undefined;
};

export const loadTemplates = (path: string) => {
  const templates = z.array(Template).parse(JSON.parse(readFileSync(path, "utf8")));
  if (new Set(templates.map(({ id }) => id)).size !== templates.length)
    throw new Error("templates repeat an id");
  return new Map(templates.map((template) => [template.id, template]));
};

/** An entry carries its own expiry; every use compares it with the current time. */
export type Timed = { expiresAt: string | null };
export const unexpired = <T extends Timed>(entries: T[]) =>
  entries.filter((entry) => entry.expiresAt === null || Date.parse(entry.expiresAt) > Date.now());

export const hostMatches = (patterns: readonly string[], host: string) => {
  const normalized = host.toLowerCase();
  return patterns.some((pattern) =>
    pattern.startsWith("*.") ? normalized.endsWith(pattern.slice(1)) : pattern === normalized,
  );
};

/** Guest egress currently supports IPv4 destinations only. */
export const ipv4Destination = (ip: string) => isIPv4(ip);

/** Speaker owns approvals; bottle-school owns the syntax and local meaning of refs. */
const host = z.hostname().refine((value) => value === value.toLowerCase());
export const siteRef = z.union([host, z.string().startsWith("*.").refine((value) => host.safeParse(value.slice(2)).success)]);
/** A `secret:<NAME>` grant names a secret in speaker and arrives with the hosts the owner bound it to. */
export const secretRef = z.string().regex(/^[A-Za-z0-9_]+$/);
export const secretHosts = z.array(siteRef).min(1);
export const folderRef = z.string().regex(/^[a-zA-Z0-9_-]+(:rw)?$/);

/** Guests may use only the agent-facing speaker API and service proxy. */
export const speakerRequestAllowed = (speaker: URL, url: URL, method: string) => {
  if (url.origin !== speaker.origin) return false;
  const path = url.pathname;
  if (path.startsWith("/_speaker/"))
    return (method === "GET" && /^\/_speaker\/(health|me|help(?:\/[a-zA-Z0-9_-]+)?)$/.test(path)) ||
      (method === "POST" && path === "/_speaker/requests");
  return /^\/[a-zA-Z0-9_-]+(?:\/|$)/.test(path) && !/^\/admin(?:\/|$)/.test(path) && !path.startsWith("/_");
};
