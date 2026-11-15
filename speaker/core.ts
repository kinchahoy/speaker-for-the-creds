import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { WSContext } from 'hono/ws'
import writeFile from 'write-file-atomic'
import { z } from 'zod'
import { durationNames, durations, errorBody, type ErrorCode, type ErrorFields, itemForms, kindOf } from './items.ts'
import { createJump } from './jump.ts'
import { hostStates } from './lifecycle.ts'
import { createCa, createProxy, type ProxySecret, Refusal } from './proxy.ts'
import { createStore, generateSshKey, openStore, type Store, type Vault } from './store.ts'

export const idSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id))
export const urlSchema = z.url().refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, 'Use an HTTP(S) URL without credentials, query, or fragment')
const sshKeySchema = z
  .string()
  .trim()
  .regex(
    /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]*)?$/,
    'Send one ed25519 or ECDSA public key',
  )
const durationSchema = z.enum(durationNames).default('2h')
const adminDurationSchema = z.enum([...durationSchema.unwrap().options, 'permanent']).default('2h')
// Three denials of the same item for the same agent within this window lock it: it is answered as denied, without
// asking the owner, until the window after the third denial has passed.
const denialLimit = 3
const denialWindow = 15 * 60_000
const requestLifetime = 2 * 3600_000
const agentIdleLimit = 7 * 86_400_000
// MCP JSON-RPC methods that only read or manage the protocol session; tools/call is classified per tool.
const mcpReadMethods = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
])
const authSchema = z.discriminatedUnion('type', [
  // A keyless service (a remote MCP server or API that needs no credential): speaker only gates and forwards.
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secret: idSchema }),
  z.object({ type: z.literal('basic'), secret: idSchema }),
  z.object({
    type: z.literal('header'),
    secret: idSchema,
    headerName: z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
      .refine(
        (name) =>
          !['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization'].includes(
            name.toLowerCase(),
          ),
      ),
  }),
  // The secret is a URL path segment (for example a webhook id) spliced in after the base URL.
  z.object({ type: z.literal('path'), secret: idSchema }),
])
export const serviceSchema = z.object({
  baseUrl: urlSchema,
  notes: z.string().max(20_000).optional(),
  auth: authSchema,
  // open: any agent reads without a grant; ask: a grant is needed; never: never granted.
  read: z.enum(['open', 'ask', 'never']).default('ask'),
  write: z.enum(['ask', 'never']).default('ask'),
  // POST paths that only read (for example a search endpoint).
  readPaths: z.array(z.string().startsWith('/')).optional(),
  // Streamable-HTTP MCP server: POST bodies are classified by JSON-RPC method and tool annotations.
  mcp: z.boolean().optional(),
})
const itemSchema = z
  .string()
  .trim()
  .refine((item) => kindOf(item) !== undefined, `An item is one of: ${itemForms.join(', ')}`)
// Item kinds a sandbox host may declare it enforces.
const hostKinds = ['secret', 'site', 'folder', 'mcp', 'ext'] as const
// SHA-256 of the empty string: what a setup that never wrote its token file sends.
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const hashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'tokenHash must be 64 lowercase hex characters (SHA-256 of the token)')
  .refine((value) => value !== emptyHash, 'tokenHash is the hash of an empty token; write the token first')
export const groupDescriptionSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[^\r\n]*$/)
  .optional()
export const groupItemsSchema = z.array(
  itemSchema.refine((item) => kindOf(item) !== 'group', 'Groups cannot contain groups'),
)
const groupsSchema = z.record(idSchema, z.object({ description: groupDescriptionSchema, items: groupItemsSchema }))
export const hostSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kinds: z.array(z.enum(hostKinds)).max(hostKinds.length),
  tokenHash: hashSchema,
  status: z.enum(hostStates),
  // The address it registered from: like an agent token, a host token only works from there. A host saved before
  // this field matches no address and is told to register again.
  source: z.string().default(''),
  // When it registered (ms); 0 for a host saved before this field, shown as "unknown".
  registeredAt: z.number().default(0),
})
const reasonSchema = z.string().trim().min(1).max(500)
export const identitySchema = z.object({
  label: z.string().trim().min(1).max(200),
  agent: z.string().trim().min(1).max(120).default('unknown'),
})
export const requestSchema = z.object({
  want: z.array(itemSchema).min(1).max(50),
  reason: reasonSchema,
  duration: durationSchema,
  sshKey: sshKeySchema.optional(),
})
// Enrollment carries the identity and, optionally, the first request (want may be empty).
export const enrollSchema = identitySchema
  .extend({
    tokenHash: hashSchema,
    want: z.array(itemSchema).max(50).default([]),
    reason: reasonSchema.optional(),
    duration: durationSchema,
    sshKey: sshKeySchema.optional(),
  })
  .refine((value) => value.want.length === 0 || value.reason, {
    message: 'reason is required with want',
    path: ['reason'],
  })
const listSchema = z.union([z.string(), z.array(z.string())]).transform((value) => [value].flat())
export const newPasswordSchema = z
  .object({ password: z.string().min(8, 'Use at least 8 characters.'), confirm: z.string() })
  .refine((value) => value.password === value.confirm, { message: 'The two passwords differ.', path: ['confirm'] })
export const ownerSecretSchema = z.object({
  // `secret:<NAME>` is how agents ask for it.
  name: z.string().regex(/^[A-Za-z0-9_]+$/, 'A secret name uses letters, numbers and _'),
  value: z.string().refine((value) => !/[\r\n]/.test(value), 'A secret value must be a single line'),
  hosts: z
    .string()
    .transform((value) => value.split(/[\s,]+/).filter(Boolean))
    .pipe(
      z
        .array(z.string().regex(/^(\*\.)?[a-zA-Z0-9.-]+$/, 'Allowed hosts look like api.github.com or *.example.org'))
        .min(1),
    ),
  // The environment variable the agent sees (holding a placeholder, never the value).
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'An environment variable name uses letters, numbers and _'),
})
// What a card posts: the items ticked and every item the card showed. Only shown items are decided.
export const decisionSchema = z.object({
  duration: adminDurationSchema,
  items: listSchema.default([]),
  shown: listSchema,
})

export type Service = z.infer<typeof serviceSchema>
export type Group = z.infer<typeof groupsSchema>[string]
export type Host = z.infer<typeof hostSchema>
type Duration = z.infer<typeof adminDurationSchema>
type Usage = { uses: number; lastUsedAt: number | null }
// What the owner sees at a glance: requests that reached them, items decided, and what speaker turned away (a request
// refused before the owner saw it, a call blocked for lack of a grant), with the latest such message.
type Counts = {
  requests: number
  granted: number
  denied: number
  refused: number
  blocked: number
  lastRefusal?: string
}
export const noCounts = (): Counts => ({ requests: 0, granted: 0, denied: 0, refused: 0, blocked: 0 })
export type Agent = Usage & {
  counts: Counts
  id: string
  // A revoked agent stays in the map as a tombstone, so its token keeps answering `denied` rather than `enroll`
  // until speaker restarts. Everything else reads enrolled agents only (agentById, enrolled).
  status: 'enrolled' | 'revoked'
  revokedAt?: number
  tokenHash: string
  label: string
  agent: string
  // Address the agent enrolled from (a sandboxed agent: its sandbox host's); its token is refused elsewhere.
  source: string
  // The sandbox host that created it, for a sandboxed agent.
  host?: string
  sshKey?: string
  createdAt: number
  lastSeen: number
}
// Grants exist only while they are in force: expiry and revocation delete them (and are logged as `grant_expired` and
// `grant_revoked`).
export type Grant = Usage & {
  id: string
  agentId: string
  item: string
  // null: until revoked (owner only).
  expiresAt: string | null
  // The span the owner approved; Extend adds it again.
  grantedMs?: number
  requestId: string
  // A site grant brought only by an extension: the ext grant(s) it ends with. It ends when the last of them does.
  with?: string[]
}
export type Outcome = 'pending' | 'granted' | 'denied'
export type Request = {
  id: string
  agentId: string
  want: string[]
  // Every item asked for after group expansion, and where it stands. A repeated POST of the same set joins this request.
  outcomes: Record<string, Outcome>
  // Set when nobody decided within the request lifetime; otherwise the status follows from the outcomes.
  expired?: true
  reason: string
  duration: z.infer<typeof durationSchema>
  // The service call that filed it, if any.
  trigger?: string
  // When the granted items end (null: until revoked).
  expiresAt?: number | null
  grantIds: string[]
  // Sites brought only by an extension in this request (site item -> ext item): their grants end with the extension's.
  bundled?: Record<string, string>
  createdAt: number
  decidedAt?: number
}
export const itemsWhere = (request: Request, outcome: Outcome) =>
  Object.keys(request.outcomes).filter((item) => request.outcomes[item] === outcome)
type RequestState = 'pending' | 'decided' | 'expired'
export const statusOf = (request: Request): RequestState =>
  request.expired ? 'expired' : itemsWhere(request, 'pending').length ? 'pending' : 'decided'
// How far a grant has reached what enforces it. `enforced`: it is in force (speaker itself enforces it, or the
// sandbox host reported it applied). `sent`: sent to a connected sandbox host, not yet reported applied.
// `host-offline`: its sandbox host is not connected.
type Enforcement = 'enforced' | 'sent' | 'host-offline'
type GrantView = Grant & { label: string; agent: string; enforcement: Enforcement; bundledWith: string[] }
type RequestView = Request & { status: RequestState; items: string[] }
// One connected sandbox host: its socket, the grants it reported applied, and what it can start inside its VMs
// (MCP servers and Pi extensions, with the sites they need).
export type Connection = {
  ws: WSContext
  applied: Set<string>
  catalog?: HostCatalog
}
// Where the encrypted store stands: no owner password yet, set but not unlocked since the last start, or open.
type VaultState = { state: 'unset' } | { state: 'locked' } | { state: 'unlocked'; store: Store }
type AgentView = Agent & { sandboxHost?: string; grants: number }
export type View = {
  hosts: Host[]
  agents: AgentView[]
  requests: RequestView[]
  grants: GrantView[]
  // Open SSH sessions, and what an ssh: or folder: item reaches for an agent (keyed `agentId item`).
  sessions: { id: string; agent: string; what: string; started: number }[]
  details: Record<string, { text: string; warning?: string }>
}
export type LogEntry = { time: string; event: string; agent?: string; label?: string; [field: string]: unknown }

type HostCatalog = {
  mcps: { id: string; label: string; tools: string[] }[]
  extensions: { id: string; label: string; description: string; tools: string[]; sites: string[] }[]
}
type Caller = { role: 'host'; host: Host } | { role: 'agent'; agent: Agent }
export type Env = { Variables: { caller: Caller } }
export const demoSecret = 'speaker-demo-credential-not-for-real-services'
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export const union = (...lists: string[][]) => [...new Set(lists.flat())]
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      DATA_DIR: z.string().default('./data'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      // Required: the admin CSRF origin and the sign-in link in `locked` answers use it.
      PUBLIC_URL: urlSchema,
      // Port of the HTTPS proxy that inserts secrets (see proxy.ts).
      PROXY_PORT: z.coerce.number().int().min(1).max(65535),
      // The jump server's port (SSH and folders over SSH).
      SSH_PORT: z.coerce.number().int().min(1).max(65535),
      // Address of the reverse proxy whose last X-Forwarded-For entry names the real caller; ignored from anyone else.
      TRUSTED_PROXY: z.union([z.ipv4(), z.ipv6()]).optional(),
    })
    .parse(environment)
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
export const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
export const agentError = (
  c: Context,
  status: ContentfulStatusCode,
  error: ErrorCode,
  message: string,
  fields?: ErrorFields,
) => c.json(errorBody(error, message, fields), status)
export const invalid = (message: string, accepted?: string[], status: 400 | 404 = 400, next?: string) =>
  new HTTPException(status, {
    res: Response.json(
      errorBody(status === 404 ? 'not_found' : 'invalid', message, {
        ...(accepted ? { accepted } : {}),
        ...(next ? { next } : {}),
      }),
      {
        status,
      },
    ),
    message,
  })

export async function createCore(config: ReturnType<typeof readConfig>) {
  const dataDir = resolve(config.DATA_DIR)
  const skill = await readFile(new URL('./skill/SKILL.md', import.meta.url), 'utf8')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const file = (name: string) => join(dataDir, name)
  const servicesFile = file('services.json')
  const starter = z
    .record(idSchema, serviceSchema)
    .parse(JSON.parse(await readFile(new URL('./services.example.json', import.meta.url), 'utf8')))
  starter.demo.baseUrl = `http://127.0.0.1:${config.PORT}/_demo-upstream`
  // A fresh install starts with the starter services; after that the file is the owner's.
  const stored = await optionalFile(servicesFile)
  const services = stored === undefined ? starter : z.record(idSchema, serviceSchema).parse(JSON.parse(stored))
  if (stored === undefined) await save(servicesFile, services)
  const groupsFile = file('groups.json')
  const groups = groupsSchema.parse(JSON.parse((await optionalFile(groupsFile)) ?? '{}'))
  const hostsFile = file('hosts.json')
  const hosts = new Map(
    z
      .array(hostSchema)
      .parse(JSON.parse((await optionalFile(hostsFile)) ?? '[]'))
      .map((host) => [host.id, host]),
  )
  const saveHosts = () => save(hostsFile, [...hosts.values()])
  // Keys and sign-in. The store appears when the owner first sets a password; after every restart speaker is locked
  // until the owner signs in, which unwraps the data key. Sessions live in memory only. Until the owner has set a
  // password and unlocked, speaker serves no agent, sandbox host or proxy call (see lockNotice).
  const storeFile = file('store.json')
  let vault: VaultState = { state: (await optionalFile(storeFile)) === undefined ? 'unset' : 'locked' }
  const unlocked = () => {
    if (vault.state !== 'unlocked') throw new Error('Speaker is locked')
    return vault.store
  }
  // What the owner has stored, empty until unlocked.
  const ownerSecrets = (): Vault['secrets'] => (vault.state === 'unlocked' ? vault.store.vault.secrets : {})
  const unlock = async (opened: Store) => {
    vault = { state: 'unlocked', store: opened }
    // Speaker's SSH key goes into a stock ssh-agent; nothing else holds it in clear.
    await jump.start(opened.vault.ssh)
  }
  // The one rule for refusing agent, sandbox-host and proxy use: why speaker cannot serve yet, or undefined when it can.
  const lockNotice = (base = config.PUBLIC_URL.replace(/\/$/, '')) =>
    vault.state === 'unlocked'
      ? undefined
      : vault.state === 'unset'
        ? { message: 'Speaker has no owner password yet', tell_user: `The owner sets one at ${base}/admin` }
        : { message: 'Speaker is locked', tell_user: `Speaker restarted: sign in at ${base}/admin to unlock` }
  // A service's key, or '' for a keyless service; undefined when a keyed service has none yet.
  const credentialOf = (id: string) =>
    services[id]?.auth.type === 'none'
      ? ''
      : vault.state === 'unlocked' && Object.hasOwn(vault.store.vault.services, id)
        ? vault.store.vault.services[id]
        : undefined
  // First unlock: speaker's SSH key and the demo service's key.
  async function newVault() {
    const created: Vault = { services: {}, secrets: {}, ssh: await generateSshKey() }
    if (services.demo) created.services.demo = demoSecret
    return created
  }
  const sessions = new Map<string, number>()
  // Agents, grants, requests and usage live in memory only: a restart starts them empty.
  const agents = new Map<string, Agent>()
  const grants = new Map<string, Grant>()
  const requests = new Map<string, Request>()
  const agentById = (id: string) => {
    const agent = agents.get(id)
    return agent?.status === 'enrolled' ? agent : undefined
  }
  const enrolled = () => [...agents.values()].filter((agent) => agent.status === 'enrolled')
  // The one agent token check, for the API and the proxy: the agent behind a token, or why there is none. Every
  // agent token only works from the address it enrolled from. (The lock is checked by each caller before this.)
  const resolveAgent = (
    token: string,
    source: string | undefined,
  ): { agent: Agent } | { refused: 'revoked' | 'unknown' } => {
    const agent = agentByToken(hash(token))
    if (agent?.status === 'revoked') return { refused: 'revoked' }
    if (!agent || agent.source !== source) return { refused: 'unknown' }
    agent.lastSeen = Date.now()
    return { agent }
  }
  const agentByToken = (digest: string) => [...agents.values()].find((agent) => same(agent.tokenHash, digest))
  const connections = new Map<string, Connection>()
  const strikes = new Map<string, number[]>()
  // The log: every event goes to standard output and is appended to audit.jsonl, which the admin Log page reads, so
  // the record outlives a restart. It is never trimmed; delete or rotate the file by hand.
  const auditFile = file('audit.jsonl')
  const readLog = async (): Promise<LogEntry[]> =>
    ((await optionalFile(auditFile)) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry)
      .reverse()
  const audit = (event: string, fields: Record<string, unknown> = {}) => {
    const who = typeof fields.agent === 'string' ? agentById(fields.agent) : undefined
    const entry: LogEntry = {
      time: new Date().toISOString(),
      event,
      ...fields,
      ...(who ? { label: who.label, agentName: who.agent } : {}),
    }
    const line = JSON.stringify(entry)
    console.log(line)
    appendFileSync(auditFile, `${line}\n`, { mode: 0o600 })
    // SSH, folder and secrets-proxy refusals are logged by their own modules; each names the agent it turned away.
    if (['ssh_refused', 'secret_proxy_refused'].includes(event) && who)
      tally(who, 'blocked', String(fields.why ?? fields.reason))
  }
  const tally = (agent: Agent, field: 'refused' | 'blocked', message: string) => {
    agent.counts[field]++
    agent.counts.lastRefusal = message
  }
  const rid = () => randomBytes(16).toString('hex')
  const live = (grant: { expiresAt: string | null }) =>
    grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()
  const expiry = (duration: Duration) =>
    duration === 'permanent' ? null : new Date(Date.now() + durations[duration]).toISOString()
  // SSH and folders over SSH: targets, shares, the jump server and its relay (see jump.ts).
  const jump = await createJump({
    port: config.SSH_PORT,
    dataDir,
    agent: agentById,
    grants: () => [...grants.values()].filter(live),
    audit,
    expire: () => sweep(),
  })
  const syncJump = () => void jump.sync().catch(() => undefined)
  // A request ends once, from pending: decided when its last item is answered, expired when nobody answers in time.
  function endRequest(request: Request, status: 'decided' | 'expired') {
    if (status === 'expired') request.expired = true
    else request.decidedAt = Date.now()
    audit(`request_${status}`, {
      request: request.id,
      agent: request.agentId,
      from: 'pending',
      granted: itemsWhere(request, 'granted'),
      denied: itemsWhere(request, 'denied'),
    })
  }
  const endGrant = (grant: Grant, event: 'expired' | 'revoked') => {
    grants.delete(grant.id)
    audit(`grant_${event}`, { grant: grant.id, agent: grant.agentId, item: grant.item })
    // Sites that came with an extension end with it, unless another extension grant still holds them.
    for (const site of [...grants.values()])
      if (site.with?.includes(grant.id)) {
        site.with = site.with.filter((id) => id !== grant.id && grants.has(id))
        if (!site.with.length) endGrant(site, event)
      }
  }
  // Applies clock-driven transitions before every HTTP request: expired grants and requests, idle agents.
  function sweep() {
    const now = Date.now()
    for (const [id, end] of sessions) if (end <= now) sessions.delete(id)
    let ended = false
    for (const grant of grants.values())
      if (!live(grant)) {
        endGrant(grant, 'expired')
        ended = true
      }
    for (const [id, request] of requests) {
      const status = statusOf(request)
      if (status === 'pending' && now - request.createdAt >= requestLifetime) endRequest(request, 'expired')
      else if (status !== 'pending' && now - (request.decidedAt ?? request.createdAt) >= 86_400_000) requests.delete(id)
    }
    const hasGrant = (id: string) => [...grants.values()].some((grant) => grant.agentId === id)
    for (const agent of enrolled())
      if (now - agent.lastSeen > agentIdleLimit && !hasGrant(agent.id)) agents.delete(agent.id)
    if (ended) push()
  }
  // The upstream URL for an agent-facing path, or undefined when it would leave the service's base path.
  const upstreamUrl = (service: Service, secret: string, parts: string[], search: string) => {
    const base = new URL(service.baseUrl),
      target = new URL(base.origin)
    const prefix = `${base.pathname.replace(/\/$/, '')}/`
    const rest = parts.join('/')
    target.pathname =
      service.auth.type === 'path'
        ? `${prefix}${encodeURIComponent(secret)}${parts.length ? `/${rest}` : ''}`
        : prefix + rest
    target.search = search
    return target.origin === base.origin && target.pathname.startsWith(prefix) ? target : undefined
  }
  const applyCredential = (service: Service, secret: string, headers: Headers) => {
    if (service.auth.type === 'path' || service.auth.type === 'none') return
    if (service.auth.type === 'header') headers.set(service.auth.headerName, secret)
    else
      headers.set(
        'authorization',
        service.auth.type === 'basic' ? `Basic ${Buffer.from(secret).toString('base64')}` : `Bearer ${secret}`,
      )
  }
  // Lenient page schema: the client's own tools/list schema rejects tools without an inputSchema; only the hints matter here.
  const mcpToolPage = z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        annotations: z
          .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
          .optional(),
      }),
    ),
    nextCursor: z.string().optional(),
  })
  type McpTool = { readOnly: boolean; destructive: boolean; annotated: boolean }
  const mcpTools = new Map<string, { at: number; tools: Map<string, McpTool> }>()
  // Lists an MCP service's tools with speaker's own credentialed session through the official MCP client.
  async function listMcpTools(id: string) {
    const service = services[id],
      secret = credentialOf(id)
    if (!service || secret === undefined) throw new Error('MCP service or credential missing')
    const url = upstreamUrl(service, secret, [], '')
    if (!url) throw new Error('Invalid MCP service URL')
    const headers = new Headers()
    applyCredential(service, secret, headers)
    const client = new Client({ name: 'speaker', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers, redirect: 'manual' } })
    const signal = AbortSignal.timeout(10_000)
    const tools = new Map<string, McpTool>()
    try {
      await client.connect(transport, { signal })
      let cursor: string | undefined
      do {
        const page = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, mcpToolPage, {
          signal,
        })
        for (const tool of page.tools)
          tools.set(tool.name, {
            readOnly: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint === true,
            annotated: Boolean(tool.annotations),
          })
        cursor = page.nextCursor
      } while (cursor)
    } finally {
      await transport.terminateSession().catch(() => undefined)
      await client.close().catch(() => undefined)
    }
    mcpTools.set(id, { at: Date.now(), tools })
    audit('mcp_tools_listed', { service: id, tools: tools.size })
    return tools
  }
  // Cached tool annotations, refreshed every 10 minutes or when an unknown tool is called (at most every 30s).
  async function mcpTool(id: string, name: string) {
    const cached = mcpTools.get(id)
    const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY
    if (age > 600_000 || (!cached?.tools.has(name) && age > 30_000))
      await listMcpTools(id).catch(() => audit('mcp_tools_failed', { service: id }))
    return mcpTools.get(id)?.tools.get(name)
  }
  // Classifies one MCP POST body: protocol housekeeping and read-only tools are reads; anything else is a write.
  async function mcpAccess(id: string, body: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { write: true, detail: 'unparseable MCP body' }
    }
    const notes: string[] = []
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const method = (message as { method?: unknown })?.method
      if (typeof method !== 'string' || method.startsWith('notifications/') || mcpReadMethods.has(method)) continue
      const name = (message as { params?: { name?: unknown } }).params?.name
      if (method === 'tools/call' && typeof name === 'string') {
        const tool = await mcpTool(id, name)
        if (tool?.readOnly) continue
        notes.push(`${name}${tool ? (tool.destructive ? ' (destructive)' : '') : ' (unknown tool)'}`)
      } else notes.push(method)
    }
    return { write: notes.length > 0, detail: notes.join(', ') }
  }

  // What a sandbox host enforces: every active grant of its agents, and their requests.
  const hostOf = (agent: { host?: string }) => (agent.host ? hosts.get(agent.host) : undefined)
  const secretHosts = (name: string) => (Object.hasOwn(ownerSecrets(), name) ? ownerSecrets()[name].hosts : [])
  // A sandbox host mounts its agents' over-SSH folders with `sshfs`, so it hears those grants; every other over-SSH
  // grant is between the agent and the relay alone.
  const snapshot = (hostId: string) => ({
    type: 'snapshot',
    grants: [...grants.values()]
      .filter(
        (grant) =>
          live(grant) &&
          agentById(grant.agentId)?.host === hostId &&
          (!jump.overSsh(grant) || grant.item.startsWith('folder:')),
      )
      .map(({ id, agentId, item, expiresAt }) => ({
        id,
        agentId,
        item,
        expiresAt,
        // A secret grant carries the hosts the owner bound it to, never the value.
        ...(item.startsWith('secret:') ? { hosts: secretHosts(item.slice('secret:'.length)) } : {}),
      })),
    // What a sandboxed agent may ask for, so the sandbox host can name them in its instructions.
    secrets: Object.entries(ownerSecrets()).map(([name, { hosts, env }]) => ({ name, hosts, env })),
    requests: [...requests.values()]
      .filter((request) => agentById(request.agentId)?.host === hostId)
      .map((request) => ({
        id: request.id,
        agentId: request.agentId,
        status: statusOf(request),
        what: itemsWhere(request, 'pending').join(', '),
        reason: request.reason,
      })),
  })
  function push() {
    syncJump()
    for (const [id, { ws }] of connections) ws.send(JSON.stringify(snapshot(id)))
  }
  setInterval(() => {
    sweep()
    push()
  }, 10_000).unref()

  // Serialize decisions; a failed one reaches its caller without poisoning the queue.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }
  const serviceItem = (item: string) => {
    const [, id, level] = /^([a-zA-Z0-9_-]+)\.(read|full)$/.exec(item) ?? []
    return id ? { id, write: level === 'full' } : undefined
  }
  const grantFor = (agentId: string, item: string) =>
    [...grants.values()].find((grant) => live(grant) && grant.agentId === agentId && grant.item === item)
  // `.full` includes read, so either item covers a read.
  const coverFor = (agentId: string, service: string, write: boolean) =>
    grantFor(agentId, `${service}.full`) ?? (write ? undefined : grantFor(agentId, `${service}.read`))
  // Secrets proxy (proxy.ts). One random placeholder per agent per secret; the agent puts it where the secret goes and
  // speaker swaps it for the value in requests to the secret's allowed hosts.
  const placeholders = new Map<string, string>()
  const placeholderOf = (agentId: string, name: string) => {
    const key = `${agentId}\n${name}`
    if (!placeholders.has(key)) placeholders.set(key, `speaker-placeholder-${randomBytes(24).toString('hex')}`)
    return placeholders.get(key) as string
  }
  // The agent's active `secret:` grants whose secret still exists in the store.
  const secretGrants = (agentId: string): (ProxySecret & { name: string; env: string; until: string | null })[] =>
    [...grants.values()]
      .filter((grant) => grant.agentId === agentId && grant.item.startsWith('secret:') && live(grant))
      .flatMap((grant) => {
        const name = grant.item.slice('secret:'.length),
          owned = Object.hasOwn(ownerSecrets(), name) ? ownerSecrets()[name] : undefined
        return owned ? [{ ...owned, name, until: grant.expiresAt, placeholder: placeholderOf(agentId, name) }] : []
      })
  // The proxy's certificate authority: made at first need, kept in the encrypted store.
  let authority: Promise<{ cert: string; key: string }> | undefined
  const certificateAuthority = () => {
    const opened = unlocked()
    authority ??= (async () => {
      if (!opened.vault.ca) {
        opened.vault.ca = await createCa()
        await opened.save()
      }
      return opened.vault.ca
    })().catch((error) => {
      authority = undefined
      throw error
    })
    return authority
  }
  const useOf = (target: Usage) => {
    target.uses++
    target.lastUsedAt = Date.now()
  }
  function addGrant(request: Request, item: string, expiresAt: string | null, duration: Duration, bundle?: string[]) {
    const replaced = [...grants.values()].filter((old) => old.agentId === request.agentId && old.item === item)
    for (const old of replaced) grants.delete(old.id)
    const grant: Grant = {
      id: rid(),
      agentId: request.agentId,
      item,
      expiresAt,
      requestId: request.id,
      uses: 0,
      lastUsedAt: null,
    }
    if (duration !== 'permanent') grant.grantedMs = durations[duration]
    if (bundle?.length) grant.with = bundle
    // Sites bundled with a grant this one replaces now follow the new grant.
    for (const site of grants.values())
      if (site.with?.some((id) => replaced.some((old) => old.id === id)))
        site.with = union(site.with.map((id) => (replaced.some((old) => old.id === id) ? grant.id : id)))
    grants.set(grant.id, grant)
    request.grantIds.push(grant.id)
    audit('grant_created', { grant: grant.id, agent: grant.agentId, item, expiresAt })
  }
  const revokeGrants = (matches: (grant: Grant) => boolean) => {
    for (const grant of [...grants.values()]) if (matches(grant)) endGrant(grant, 'revoked')
    push()
  }
  const strikeKey = (agentId: string, item: string) => `${agentId}\n${item}`
  const recentStrikes = (key: string) => (strikes.get(key) ?? []).filter((at) => Date.now() - at < denialWindow)
  // When asking the owner works again for an item denied three times (a time in ms), else undefined.
  const lockedUntil = (agentId: string, item: string) => {
    const struck = recentStrikes(strikeKey(agentId, item))
    return struck.length >= denialLimit ? struck[struck.length - 1] + denialWindow : undefined
  }
  const retryAfter = (agentId: string, items: string[]) => {
    const until = Math.max(0, ...items.map((item) => lockedUntil(agentId, item) ?? 0))
    return until ? new Date(until).toISOString() : undefined
  }
  // The owner's decision on what the card showed: grants the ticked items and denies the other shown ones. An item
  // added to the request after the card was rendered stays pending, and so does the request.
  function decide(id: string, approved: string[], shown: string[], duration: Duration) {
    return serial(async () => {
      const request = requests.get(id)
      if (!request) throw new HTTPException(404, { message: 'Request not found' })
      if (statusOf(request) !== 'pending')
        throw new HTTPException(409, { message: `Request is already ${statusOf(request)}` })
      const owner = agentById(request.agentId)
      if (!owner) throw new HTTPException(409, { message: 'Agent was removed' })
      const take = new Set(approved)
      const seen = new Set(shown)
      const pending = itemsWhere(request, 'pending')
      const yes = pending.filter((item) => seen.has(item) && take.has(item))
      const no = pending.filter((item) => seen.has(item) && !take.has(item))
      if (!yes.length && !no.length) throw new HTTPException(409, { message: 'None of the shown items are pending' })
      const expiresAt = expiry(duration)
      // Extensions first: a bundled site binds to the ext grant just made. A site the agent already holds on its own
      // stays as it is; one bundled with another extension gains this one.
      const bundledOf = (item: string) => {
        const ext = request.bundled?.[item]
        return ext && yes.includes(ext) ? ext : undefined
      }
      for (const item of yes.filter((item) => !bundledOf(item))) addGrant(request, item, expiresAt, duration)
      for (const item of yes.filter(bundledOf)) {
        const ext = bundledOf(item) as string
        const extGrant = [...grants.values()].find((g) => g.agentId === request.agentId && g.item === ext)
        const held = [...grants.values()].find((g) => g.agentId === request.agentId && g.item === item && live(g))
        if (held && !held.with) continue
        if (extGrant) addGrant(request, item, expiresAt, duration, union(held?.with ?? [], [extGrant.id]))
        else addGrant(request, item, expiresAt, duration)
      }
      // The agent is told "granted" only once the jump server is listening for its new grants.
      if (yes.length) await jump.sync()
      for (const item of no)
        strikes.set(strikeKey(request.agentId, item), [...recentStrikes(strikeKey(request.agentId, item)), Date.now()])
      for (const item of yes) request.outcomes[item] = 'granted'
      for (const item of no) request.outcomes[item] = 'denied'
      owner.counts.granted += yes.length
      owner.counts.denied += no.length
      if (yes.length) request.expiresAt = expiresAt === null ? null : Date.parse(expiresAt)
      if (statusOf(request) === 'decided') endRequest(request, 'decided')
      push()
    })
  }
  // Items the owner never grants are denied at once, open reads need no grant, and locked items are denied without a
  // card; the rest go to the owner in one request. Asking for exactly the set a pending request already holds joins
  // that request (this is how a caller waits by posting again); any other set is a request of its own.
  function createRequest(
    agent: Agent,
    items: string[],
    want: string[],
    reason: string,
    duration: Request['duration'],
    trigger?: string,
    bundled: Record<string, string> = {},
  ) {
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item))
    const existing = [...requests.values()].find(
      (r) => r.agentId === agent.id && statusOf(r) === 'pending' && sameSet(Object.keys(r.outcomes), items),
    )
    if (existing) {
      if (reason) Object.assign(existing, { reason, duration })
      return existing
    }
    const outcomes: Record<string, Outcome> = {}
    for (const item of items) {
      const target = serviceItem(item)
      const service = target && services[target.id]
      const rule = service && (target.write ? service.write : service.read)
      const missing = jump.unavailable(agent.id, item)
      // An item that cannot be delivered is denied at once and logged for the owner, with no card.
      if (missing !== undefined) {
        audit('request_unavailable', { agent: agent.id, item, why: missing })
        outcomes[item] = 'denied'
      } else if (rule === 'never' || lockedUntil(agent.id, item) !== undefined) outcomes[item] = 'denied'
      else outcomes[item] = rule === 'open' ? 'granted' : 'pending'
    }
    const request: Request = {
      id: rid(),
      agentId: agent.id,
      want: union(want),
      outcomes,
      reason,
      duration,
      trigger,
      ...(Object.keys(bundled).length ? { bundled } : {}),
      grantIds: [],
      createdAt: Date.now(),
    }
    requests.set(request.id, request)
    const count = (outcome: Outcome) => itemsWhere(request, outcome).length
    if (count('pending')) agent.counts.requests++
    agent.counts.granted += count('granted')
    agent.counts.denied += count('denied')
    push()
    audit('request_created', { request: request.id, agent: agent.id, items, reason, trigger })
    if (!count('pending')) {
      if (count('granted')) request.expiresAt = null
      endRequest(request, 'decided')
    }
    return request
  }
  // The caller's address is the socket's; only the trusted proxy may name another one, with the last
  // X-Forwarded-For entry it appended. In-process app.fetch callers have no socket and share 'unknown'.
  const peerOf = (c: Context) =>
    (
      c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    )?.incoming?.socket?.remoteAddress?.replace(/^::ffff:/, '')
  const sourceOf = (c: Context) => {
    const peer = peerOf(c)
    if (peer === undefined) return 'unknown'
    if (peer !== config.TRUSTED_PROXY) return peer
    return (
      c.req
        .header('x-forwarded-for')
        ?.split(',')
        .at(-1)
        ?.trim()
        .replace(/^::ffff:/, '') || peer
    )
  }
  // Links and commands given to agents use the address the caller used to reach speaker.
  const baseOf = (c: Context) => {
    const url = new URL(c.req.url)
    const proto = peerOf(c) === config.TRUSTED_PROXY ? c.req.header('x-forwarded-proto') : undefined
    return `${proto ?? url.protocol.slice(0, -1)}://${url.host}`
  }
  const enforcementOf = (grant: Grant): Enforcement => {
    const hostId = agentById(grant.agentId)?.host
    if (!hostId || serviceItem(grant.item) || jump.overSsh(grant)) return 'enforced'
    const connection = connections.get(hostId)
    if (!connection) return 'host-offline'
    return connection.applied.has(grant.id) ? 'enforced' : 'sent'
  }
  const view = (): View => {
    const asViews = [...requests.values()].map((request) => ({
      ...request,
      status: statusOf(request),
      items: itemsWhere(request, 'pending'),
    }))
    return {
      hosts: [...hosts.values()],
      agents: enrolled().map((agent) => ({
        ...agent,
        sandboxHost: hostOf(agent)?.name,
        grants: [...grants.values()].filter((grant) => grant.agentId === agent.id).length,
      })),
      requests: asViews,
      grants: [...grants.values()].filter(live).map((grant) => {
        const agent = agentById(grant.agentId)
        return {
          ...grant,
          label: agent?.label ?? '',
          agent: agent?.agent ?? '',
          enforcement: enforcementOf(grant),
          bundledWith: (grant.with ?? []).flatMap((id) => grants.get(id)?.item ?? []),
        }
      }),
      sessions: jump.sessions(),
      details: Object.fromEntries(
        [
          ...asViews.filter((r) => r.status === 'pending').flatMap((r) => r.items.map((i) => [r.agentId, i])),
          ...[...grants.values()].filter(live).map((g) => [g.agentId, g.item]),
        ].flatMap(([agentId, item]) => {
          const detail = jump.describe(agentId, item)
          return detail ? [[`${agentId} ${item}`, detail]] : []
        }),
      ),
    }
  }
  function endAgent(id: string) {
    const agent = agentById(id)
    if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
    agent.status = 'revoked'
    agent.revokedAt = Date.now()
    revokeGrants((grant) => grant.agentId === id)
    for (const [key, request] of requests) if (request.agentId === id) requests.delete(key)
    audit('agent_revoked', { agent: id, label: agent.label })
  }
  const proxy = createProxy({
    authenticate(token, source) {
      const notice = lockNotice()
      if (notice) throw new Refusal(503, `${notice.message}. ${notice.tell_user}`)
      const found = resolveAgent(token, source)
      if ('agent' in found) return { agent: found.agent.id }
      if (found.refused === 'revoked') throw new Refusal(403, 'The owner revoked this agent. Stop and tell the user')
      throw new Refusal(407, 'Unknown token or address. Enroll again (read "Set up" in GET /_speaker/help)')
    },
    secrets: secretGrants,
    ca: certificateAuthority,
    log: audit,
  })
  // The first visit sets the owner password and creates the store; later sign-ins unwrap it (WrongPassword if not).
  const createOwnerStore = (password: string) =>
    serial(async () => {
      if (vault.state !== 'unset') throw new HTTPException(409, { message: 'The owner password is already set' })
      await unlock(await createStore(storeFile, password, await newVault()))
    })
  const signIn = async (password: string) => {
    const opened = await openStore(storeFile, password)
    if (vault.state === 'locked') await unlock(opened)
  }
  const checkPassword = (password: string) => openStore(storeFile, password)
  return {
    config,
    skill,
    services,
    groups,
    hosts,
    agents,
    agentById,
    enrolled,
    agentByToken,
    resolveAgent,
    grants,
    requests,
    connections,
    sessions,
    readLog,
    mcpTools,
    jump,
    proxy,
    get vault() {
      return vault
    },
    unlocked,
    ownerSecrets,
    lockNotice,
    credentialOf,
    createOwnerStore,
    signIn,
    checkPassword,
    audit,
    rid,
    live,
    sweep,
    push,
    syncJump,
    snapshot,
    serial,
    serviceItem,
    coverFor,
    secretGrants,
    certificateAuthority,
    useOf,
    tally,
    revokeGrants,
    lockedUntil,
    retryAfter,
    decide,
    createRequest,
    listMcpTools,
    mcpAccess,
    upstreamUrl,
    applyCredential,
    hostOf,
    saveHosts,
    saveServices: () => save(servicesFile, services),
    saveGroups: () => save(groupsFile, groups),
    peerOf,
    sourceOf,
    baseOf,
    enforcementOf,
    view,
    endAgent,
  }
}
export type Core = Awaited<ReturnType<typeof createCore>>
