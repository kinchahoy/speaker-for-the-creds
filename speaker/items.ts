// The item grammar speaker and bottle share: what an item looks like, how long a grant may last, and how a host
// pattern matches a host. Pure functions only; both packages import this file.

// A service is `name` or a scope `name:scope` (the part before the colon is the service whose key it uses); the other
// kinds' prefixes can never be a scope's parent, so `site:x.read` stays a site.
export const kindPrefixes = ['site', 'secret', 'ssh', 'folder', 'mcp', 'ext', 'group', 'host']
// Items are strings; the pattern table doubles as the list of accepted forms in error messages.
export const itemPatterns = {
  service: new RegExp(`^(?!(?:${kindPrefixes.join('|')}):)[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)?\\.(read|full)$`),
  site: /^site:(\*\.)?[a-zA-Z0-9.-]+$/,
  secret: /^secret:[A-Za-z0-9_-]+$/,
  ssh: /^ssh:[a-zA-Z0-9_-]+$/,
  folder: /^folder:[a-zA-Z0-9_-]+(:rw)?$/,
  mcp: /^mcp:[a-zA-Z0-9_-]+$/,
  ext: /^ext:[a-zA-Z0-9_-]+$/,
  group: /^group:[a-zA-Z0-9_-]+$/,
  // A sandbox host's own registration (`host:<id>`); only a sandbox host asks for it, by registering.
  host: /^host:[a-zA-Z0-9_-]+$/,
}
export type ItemKind = keyof typeof itemPatterns
export const itemForms = [
  '<service>.read',
  '<service>.full',
  '<service>:<scope>.read',
  'site:<host>',
  'secret:<NAME>',
  'ssh:<target>',
  'folder:<share>[:rw]',
  'mcp:<id>',
  'ext:<id>',
  'group:<name>',
]
export const kindOf = (item: string) =>
  (Object.entries(itemPatterns) as [ItemKind, RegExp][]).find(([, pattern]) => pattern.test(item))?.[0]

// How long a request may ask for; the owner may also grant `permanent`.
export const durations = { '30m': 1800_000, '1h': 3600_000, '2h': 7200_000, '1d': 86_400_000, '30d': 2_592_000_000 }
export const durationNames = Object.keys(durations) as [keyof typeof durations, ...(keyof typeof durations)[]]

// A host pattern is a host (`api.example.com`) or a wildcard over its subdomains (`*.example.com`, which does not
// match `example.com` itself).
export const covers = (pattern: string, host: string) => {
  const [p, h] = [pattern.toLowerCase(), host.toLowerCase()]
  return p.startsWith('*.') ? h.length > p.length - 1 && h.endsWith(p.slice(1)) : p === h
}
export const coversAny = (patterns: readonly string[], host: string) =>
  patterns.some((pattern) => covers(pattern, host))

// The one shape of every error speaker and bottle answer: a code, a human sentence, and the next step or what to tell
// the user when there is one. (Only bottle's model endpoint differs: it answers in the OpenAI shape Pi expects.)
export type ErrorCode =
  | 'invalid'
  | 'not_found'
  | 'denied'
  | 'conflict'
  | 'rate_limited'
  | 'locked'
  | 'no_key'
  | 'enroll'
  | 'register'
  | 'approval_required'
  | 'upstream_unavailable'
  | 'internal_error'
export type ErrorFields = { next?: string; tell_user?: string; [field: string]: unknown }
export const errorBody = (error: ErrorCode, message: string, fields: ErrorFields = {}) => ({
  error,
  message,
  ...fields,
})
