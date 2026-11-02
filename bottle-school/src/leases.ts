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

/** A launch template holds what speaker does not decide: VM limits, Pi plugins, and an optional bundle. */
export const Template = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    label: z.string().min(1).max(120),
    limits: Limits,
    plugins: z.array(z.string()),
    bundle: z.string().optional(),
  })
  .strict();
export type Template = z.infer<typeof Template>;

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
export const secretRef = z.string().regex(/^[A-Z][A-Z0-9_]*@[^@]+$/).transform((ref) => {
  const [name, hosts] = ref.split("@");
  return { name: name!, hosts: hosts!.split(",") };
}).pipe(z.object({ name: z.string(), hosts: z.array(siteRef).min(1) }));
export const folderRef = z.string().regex(/^[a-zA-Z0-9_-]+(:rw)?$/);

/** Guests may use only the subject-facing speaker API and credential proxy. */
export const speakerRequestAllowed = (speaker: URL, url: URL, method: string) => {
  if (url.origin !== speaker.origin) return false;
  const path = url.pathname;
  if (path.startsWith("/_speaker/"))
    return (method === "GET" && /^\/_speaker\/(health|providers(?:\/[a-zA-Z0-9_-]+\/guide)?|requests\/[a-zA-Z0-9_-]+)$/.test(path)) ||
      (method === "POST" && path === "/_speaker/requests");
  return /^\/[a-zA-Z0-9_-]+(?:\/|$)/.test(path) && !/^\/admin(?:\/|$)/.test(path) && !path.startsWith("/_");
};
