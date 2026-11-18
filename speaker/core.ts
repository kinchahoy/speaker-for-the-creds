import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, watchFile } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { WSContext } from 'hono/ws'
import writeFile from 'write-file-atomic'
import { z } from 'zod'
import {
  type Approval,
  createEngine,
  type Description,
  type Engine,
  type Kind,
  type Refusal as Refused,
} from './engine.ts'
import { durationNames, errorBody, type ErrorCode, type ErrorFields, itemForms, kindOf } from './items.ts'
import { createJump } from './jump.ts'
import { createCa, createProxy, type ProxySecret, Refusal } from './proxy.ts'
import { createStore, generateSshKey, openStore, type OwnerSecret, type Store, type Vault } from './store.ts'

// A service id: a name, or a scope `name:scope` of a service that holds its own key (checked when it is saved).
export const serviceIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}(:[a-zA-Z0-9_-]{1,64})?$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id.split(':')[0]))
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
// Whether one base URL is the other or lies under it on the same site: what a service sharing another's key must be.
export const within = (inner: string, outer: string) => {
  const a = new URL(inner),
    b = new URL(outer)
  return a.origin === b.origin && `${a.pathname.replace(/\/$/, '')}/`.startsWith(`${b.pathname.replace(/\/$/, '')}/`)
}
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
  // The address it registered from: like an agent token, a host token only works from there.
  source: z.string(),
  // When it registered (ms).
  registeredAt: z.number(),
})
const reasonSchema = z.string().trim().min(1).max(500)
// The identity fields of an agent, in display order. Self-reported ones are display text from the agent or its sandbox
// host (untrusted, never a key; `max` caps the length); speaker-known ones speaker sets itself. `say` is how a card
// words the field.
export const identityFields = {
  label: { from: 'self', max: 200, say: 'name' },
  agent: { from: 'self', max: 120, say: 'says it is' },
  title: { from: 'self', max: 60, say: 'task' },
  source: { from: 'known', say: 'from' },
  via: { from: 'known', say: 'via' },
  key: { from: 'known', say: 'key' },
} as const
const selfReported = (field: 'label' | 'agent' | 'title') =>
  z
    .string()
    .trim()
    .min(1)
    .max(identityFields[field].max)
    .refine((text) => !/\p{Cc}/u.test(text), 'Control characters are not allowed')
export const titleSchema = selfReported('title')
export const identitySchema = z.object({ label: selfReported('label'), agent: selfReported('agent').default('unknown') })
// A sandbox host's agent also names the extensions its template gave at launch. The host enforces them without speaker
// (the owner started the template), so speaker only records and shows them; they are not grants and cannot be revoked here.
export const hostAgentSchema = identitySchema.extend({
  launched: z
    .array(itemSchema.refine((item) => kindOf(item) === 'ext', 'Only extensions are given at launch'))
    .max(50)
    .default([]),
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
const secretHostsSchema = z
  .array(z.string().regex(/^(\*\.)?[a-zA-Z0-9.-]+$/, 'Allowed hosts look like api.github.com or *.example.org'))
  .min(1)
const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'An environment variable name uses letters, numbers and _')
export const ownerSecretSchema = z.object({
  // `secret:<NAME>` is how agents ask for it.
  name: z.string().regex(/^[A-Za-z0-9_-]+$/, 'A secret name uses letters, numbers, _ and -'),
  value: z.string().refine((value) => !/[\r\n]/.test(value), 'A secret value must be a single line'),
  // Released: the agent reads the value itself (no hosts, no variable). Otherwise speaker inserts it for the hosts.
  release: z.literal('on').optional(),
  hosts: z.string().default('').transform((value) => value.split(/[\s,]+/).filter(Boolean)),
  // The environment variable the agent sees (holding a placeholder, never the value).
  env: z.string().default(''),
})
// What config.json keeps of a secret: what it may reach (inserted) or `release: true` (the agent reads it).
export const secretSetupSchema = z.union([
  z.object({ release: z.literal(true) }),
  z.object({ hosts: secretHostsSchema, env: envNameSchema }),
])
// config.json (see createCore). A secret's entry is what it may reach; its value is in the encrypted store.
export const configSchema = z.object({
  services: z.record(serviceIdSchema, serviceSchema),
  groups: groupsSchema.default({}),
  secrets: z.record(ownerSecretSchema.shape.name, secretSetupSchema).default({}),
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
type Usage = { uses: number; lastUsedAt: number | null }
// Refusals leave no approval behind, so they are counted; requests, granted and denied are read off the approvals.
type Counts = {
  refused: number
  blocked: number
  lastRefusal?: string
}
export const noCounts = (): Counts => ({ refused: 0, blocked: 0 })
export type Agent = Usage & {
  counts: Counts
  id: string
  // A revoked agent stays in the map as a tombstone, so its token keeps answering `denied` rather than `enroll`
  // until speaker restarts. Everything else reads enrolled agents only (agentById, enrolled).
  status: 'enrolled' | 'revoked'
  revokedAt?: number
  tokenHash: string
  label: string
  // The task title its sandbox host reported (see identityFields); kept in memory only.
  title?: string
  agent: string
  // Address the agent enrolled from (a sandboxed agent: its sandbox host's); its token is refused elsewhere.
  source: string
  // The sandbox host that created it, for a sandboxed agent.
  host?: string
  // Extensions its template gave at launch, as that host reported (see hostAgentSchema).
  launched?: string[]
  sshKey?: string
  createdAt: number
  lastSeen: number
}
// How far a grant has reached what enforces it. `enforced`: it is in force (speaker itself enforces it, or the
// sandbox host reported it applied). `sent`: sent to a connected sandbox host, not yet reported applied.
// `host-offline`: its sandbox host is not connected.
type Enforcement = 'enforced' | 'sent' | 'host-offline'
export type GrantView = Approval & {
  label: string
  agent: string
  enforcement: Enforcement
  bundledWith: string[]
  detail: Description
}
// One connected sandbox host: its socket, the grants it reported applied, and what it can start inside its VMs
// (MCP servers and Pi extensions, with the sites they need).
export type Connection = {
  ws: WSContext
  applied: Set<string>
  catalog?: HostCatalog
}
// Where the encrypted store stands: no owner password yet, set but not unlocked since the last start, or open.
type VaultState = { state: 'unset' } | { state: 'locked' } | { state: 'unlocked'; store: Store }
type AgentView = Agent & { sandboxHost?: string; grants: number; requests: number; granted: number; denied: number }
export type View = {
  hosts: (Host & { grant?: string })[]
  agents: AgentView[]
  cards: ReturnType<Engine['cards']>
  grants: GrantView[]
  sessions: { id: string; agent: string; what: string; started: number }[]
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
      // The reverse proxy whose last X-Forwarded-For entry names the real caller (ignored from anyone else): its address,
      // or a name such as a Docker service name, which follows the container wherever it lands.
      TRUSTED_PROXY: z.union([z.ipv4(), z.ipv6(), z.hostname()]).optional(),
    })
    .parse(environment)
}

async function optionalFile(path: string | URL): Promise<string | undefined> {
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
  const enroll = await readFile(new URL('./skill/enroll.sh', import.meta.url), 'utf8')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const file = (name: string) => join(dataDir, name)
  // config.json: everything the owner set up except the values (services, groups, what each secret may reach), so it
  // can be shared; the values live in the encrypted store. A fresh install starts from the starter services.
  const configFile = file('config.json')
  const json = async (path: string | URL) => {
    const text = await optionalFile(path)
    return text === undefined ? undefined : JSON.parse(text)
  }
  const starter = async () => {
    const services = await json(new URL('./services.example.json', import.meta.url))
    services.demo.baseUrl = `http://127.0.0.1:${config.PORT}/_demo-upstream`
    return services
  }
  const stored = await json(configFile)
  const ownerConfig = configSchema.parse(stored ?? { services: await starter() })
  const saveConfig = () => save(configFile, ownerConfig)
  if (!stored) await saveConfig()
  const { services, groups } = ownerConfig
  const hostsFile = file('hosts.json')
  const storedHosts = z.array(hostSchema).parse(JSON.parse((await optionalFile(hostsFile)) ?? '[]'))
  const hosts = new Map<string, Host>(storedHosts.map((host) => [host.id, host]))
  // The records only: a restarted speaker asks the owner to approve every known host again.
  const saveHosts = () => writeFile.sync(hostsFile, JSON.stringify([...hosts.values()], null, 2), { mode: 0o600 })
  // Keys and sign-in. The store appears when the owner first sets a password; after every restart speaker is locked
  // until the owner signs in, which unwraps the data key. Sessions live in memory only. Until the owner has set a
  // password and unlocked, speaker serves no agent, sandbox host or proxy call (see lockNotice).
  const storeFile = file('store.json')
  let vault: VaultState = { state: (await optionalFile(storeFile)) === undefined ? 'unset' : 'locked' }
  const unlocked = () => {
    if (vault.state !== 'unlocked') throw new Error('Speaker is locked')
    return vault.store
  }
  // The secrets agents can use: those with both a setup in config.json and a value in the unlocked store.
  const ownerSecrets = (): Record<string, OwnerSecret> => {
    if (vault.state !== 'unlocked') return {}
    const values = vault.store.vault.secrets
    return Object.fromEntries(
      Object.entries(ownerConfig.secrets).flatMap(([name, setup]) =>
        Object.hasOwn(values, name)
          ? [[name, { hosts: [], env: '', release: false, ...setup, value: values[name] }]]
          : [],
      ),
    )
  }
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
  // A service's key is its own, or that of the wider service it names in auth.secret, which it must sit inside.
  const credentialOf = (id: string) => {
    const service = services[id]
    if (!service || service.auth.type === 'none') return service && ''
    const owner = service.auth.secret
    return vault.state === 'unlocked' &&
      Object.hasOwn(vault.store.vault.services, owner) &&
      (owner === id || (Object.hasOwn(services, owner) && within(service.baseUrl, services[owner].baseUrl)))
      ? vault.store.vault.services[owner]
      : undefined
  }
  // First unlock: speaker's SSH key and the demo service's key.
  async function newVault() {
    const created: Vault = { services: {}, secrets: {}, ssh: await generateSshKey() }
    if (services.demo) created.services.demo = demoSecret
    return created
  }
  const sessions = new Map<string, number>()
  const agents = new Map<string, Agent>()
  const agentById = (id: string) => {
    const agent = agents.get(id)
    return agent?.status === 'enrolled' ? agent : undefined
  }
  const enrolled = () => [...agents.values()].filter((agent) => agent.status === 'enrolled')
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
  // SSH and folders over SSH: targets, shares, the jump server and its relay (see jump.ts).
  const jump = await createJump({
    port: config.SSH_PORT,
    dataDir,
    agent: agentById,
    grants: () =>
      engine.grants().map(({ id, subject, item, expiresAt }) => ({ id, agentId: subject, item, expiresAt })),
    audit,
    expire: () => sweep(),
  })
  const syncJump = () => void jump.sync().catch(() => undefined)
  function sweep() {
    const now = Date.now()
    for (const [id, end] of sessions) if (end <= now) sessions.delete(id)
    engine.sweep()
    for (const agent of enrolled())
      if (now - agent.lastSeen > agentIdleLimit && !engine.grants(agent.id).length) agents.delete(agent.id)
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
        : parts.length
          ? prefix + rest
          : base.pathname // a call to the service itself reaches the base address exactly as the owner wrote it
    target.search = search
    return target.origin === base.origin && `${target.pathname}/`.startsWith(prefix) ? target : undefined
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

  const hostOf = (agent: { host?: string }) => (agent.host ? hosts.get(agent.host) : undefined)
  const catalogOf = (agentId: string) => connections.get(agentById(agentId)?.host ?? '')?.catalog
  const secretHosts = (name: string) => (Object.hasOwn(ownerSecrets(), name) ? ownerSecrets()[name].hosts : [])
  const serviceItem = (item: string) => {
    return kindOf(item) === 'service' ? { id: item.slice(0, -5), write: item.endsWith('.full') } : undefined
  }
  // Item kinds an agent may ask for: services, groups, secrets, SSH and folders, plus what its sandbox host enforces.
  const allowedKinds = (agent: Agent): string[] => [
    'service',
    'group',
    'secret',
    'ssh',
    'folder',
    ...(hostOf(agent)?.kinds ?? []),
  ]
  const hostItem = (id: string) => `host:${id}`
  const hostGrant = (id: string) => engine.held(id, [hostItem(id)])

  const refuse = (item: string, real: string[], what: string): Refused => ({
    message: `${item} is not something you can ask for. ${what} you can ask for: ${real.length ? real.join(', ') : 'none'}.`,
    next: 'GET /_speaker/catalog',
  })
  const unavailable = (why: string) => ({ to: 'unavailable', why }) as const
  // A wildcard over a whole top-level domain, such as *.com: approving it opens far more than one service.
  const broad = (hosts: string[]) => {
    const wide = hosts.filter((host) => host.startsWith('*.') && !host.slice(2).includes('.'))
    return wide.length ? `very broad: ${wide.join(', ')} matches every host under it` : undefined
  }
  const base: Omit<Kind, 'where' | 'describe'> = {
    subject: 'agent',
    validate: () => undefined,
    admission: () => ({ to: 'ask' }),
    snapshot: () => ({}),
    granted: () => undefined,
    ended: () => undefined,
  }
  const overSsh: Omit<Kind, 'where'> = {
    ...base,
    validate(item) {
      const message = jump.unknownName(item)
      return message
        ? {
            message,
            next: 'Use the exact name your task or the owner gave you; read "Folders and SSH" in GET /_speaker/help',
          }
        : undefined
    },
    admission(item, agentId) {
      const why = jump.unavailable(agentId, item)
      return why === undefined ? { to: 'ask' } : unavailable(why)
    },
    describe: (item) => jump.describe(item),
    granted: () => jump.sync(),
  }
  const hostEntry = (agentId: string, list: 'mcps' | 'extensions', item: string) =>
    catalogOf(agentId)?.[list].find(({ id }) => item === `${list === 'mcps' ? 'mcp' : 'ext'}:${id}`)
  const inCatalog =
    (list: 'mcps' | 'extensions', what: string) =>
    (item: string, agentId: string): Refused | undefined =>
      hostEntry(agentId, list, item)
        ? undefined
        : refuse(
            item,
            (catalogOf(agentId)?.[list] ?? []).map(({ id }) => id),
            what,
          )
  const kinds: Record<string, Kind> = {
    service: {
      ...base,
      where: 'both',
      validate: (item) => {
        const target = serviceItem(item)
        return target && Object.hasOwn(services, target.id) && credentialOf(target.id) !== undefined
          ? undefined
          : refuse(
              item,
              Object.keys(services)
                .filter((id) => credentialOf(id) !== undefined)
                .flatMap((id) => [`${id}.read`, `${id}.full`]),
              'Services',
            )
      },
      admission(item) {
        const { id, write } = serviceItem(item) as { id: string; write: boolean }
        if (!Object.hasOwn(services, id)) return unavailable(`there is no service ${id}`)
        if (credentialOf(id) === undefined) return unavailable(`${id} has no key`)
        return { to: write ? services[id].write : services[id].read }
      },
      describe(item, agentId) {
        const { id, write } = serviceItem(item) as { id: string; write: boolean }
        const service = Object.hasOwn(services, id) ? services[id] : undefined
        if (!service) return { text: 'no longer set up', reach: [] }
        // Asking for the service while holding one of its scopes (or .full while holding .read) widens what the agent has.
        const narrower = engine
          .grants(agentId)
          .find((g) => g.item.startsWith(`${id}:`) || (write && g.item === `${id}.read`))?.item
        return {
          ...(narrower ? { warning: `wider than held: ${narrower}`, wider: true } : {}),
          text: `${write ? 'read and change' : 'read'} ${service.baseUrl}${service.mcp ? ' · MCP server' : ''}`,
          // What `.read` lets through grows with the read paths and the MCP read-only tools.
          reach: [
            service.baseUrl,
            ...(service.mcp ? ['MCP read-only tools'] : []),
            ...(write ? [] : (service.readPaths ?? []).map((path) => `POST ${path}`)),
          ],
          risk: write ? 'read/write' : undefined,
        }
      },
    },
    secret: {
      ...base,
      where: 'host',
      validate: (item) =>
        Object.hasOwn(ownerSecrets(), item.slice('secret:'.length))
          ? undefined
          : refuse(item, Object.keys(ownerSecrets()), 'Secrets'),
      admission: (item) =>
        Object.hasOwn(ownerSecrets(), item.slice('secret:'.length))
          ? { to: 'ask' }
          : unavailable(`there is no secret ${item.slice('secret:'.length)}`),
      // Granting a secret opens the hosts its value goes to.
      describe(item) {
        const name = item.slice('secret:'.length)
        const hosts = secretHosts(name)
        if (ownerSecrets()[name]?.release)
          return {
            text: 'the agent reads the value with GET /_speaker/secrets',
            reach: ['released'],
            warning: 'agent receives the value',
            hint: 'Revoking stops further reads but cannot take back a value already read.',
            risk: 'secret',
          }
        return hosts.length
          ? { text: `sent to ${hosts.join(', ')}`, reach: hosts, warning: broad(hosts), risk: 'secret' }
          : { text: 'not set up: it will do nothing', reach: [], risk: 'secret' }
      },
      // The sandbox host routes those hosts to speaker's proxy; it never hears the value.
      snapshot: (item) => ({ hosts: secretHosts(item.slice('secret:'.length)) }),
    },
    site: {
      ...base,
      where: 'host',
      describe: (item) => ({
        text: 'the sandbox may reach this site',
        reach: [item.slice('site:'.length)],
        warning: broad([item.slice('site:'.length)]),
      }),
    },
    ssh: { ...overSsh, where: 'speaker' },
    folder: { ...overSsh, where: 'both' },
    mcp: {
      ...base,
      where: 'host',
      validate: inCatalog('mcps', 'MCP servers'),
      describe: (item, agentId) => ({
        text: `${hostEntry(agentId, 'mcps', item)?.label ?? 'MCP server'} · runs in the sandbox`,
        reach: [item],
      }),
    },
    ext: {
      ...base,
      where: 'host',
      validate: inCatalog('extensions', 'Extensions'),
      describe: (item, agentId) => ({
        text: `${hostEntry(agentId, 'extensions', item)?.label ?? 'Pi extension'} · runs in the sandbox`,
        reach: [item],
      }),
    },
    // A sandbox host registering: approving lets it create agents and enforce the kinds it named. It stays until the
    // owner removes it; removing it (or denying the registration) ends its agents and forgets it.
    host: {
      ...base,
      subject: 'host',
      where: 'speaker',
      describe(_item, id) {
        const host = hosts.get(id)
        if (!host) return { text: 'removed', reach: [] }
        const replaces = [...hosts.values()].filter(
          (o) => o.id !== id && o.name === host.name && o.source === host.source,
        )
        return {
          text: `Approving lets this sandbox host create agents and enforce grants for ${host.kinds.join(', ') || 'no item kinds'}.`,
          reach: host.kinds,
          warning: replaces.length
            ? replaces
                .map(
                  (o) =>
                    `Approving replaces the ${hostGrant(o.id) ? 'approved' : 'pending'} host ${o.name} registered ${new Date(o.registeredAt).toISOString()}: it and its agents are removed.`,
                )
                .join(' ')
            : undefined,
        }
      },
      // The same name from the same address is the same machine registering again: its older entries (their tokens
      // are bound to that address and are unusable now) go, with their agents.
      granted(approval) {
        const host = hosts.get(approval.subject) as Host
        audit('host_approved', { host: host.id })
        for (const old of [...hosts.values()])
          if (old.id !== host.id && old.name === host.name && old.source === host.source) {
            engine.endSubject(old.id)
            audit('host_replaced', { host: old.id, by: host.id, name: old.name })
          }
        saveHosts()
      },
      ended(approval) {
        const host = hosts.get(approval.subject)
        if (!host) return
        hosts.delete(host.id)
        for (const agent of enrolled()) if (agent.host === host.id) endAgent(agent.id)
        connections.get(host.id)?.ws.close(1008, 'removed')
        saveHosts()
        audit('host_removed', { host: host.id })
      },
    },
  }
  const engine = createEngine({
    kinds,
    kindOf: (item) => kindOf(item) as string,
    audit,
    changed: () => push(),
    subjects: {
      agent: {
        durations: [...durationNames, 'permanent'],
        wait: requestLifetime,
        field: 'agent',
        exists: (id) => agentById(id) !== undefined,
        who(id) {
          const agent = agentById(id)
          return agent
            ? {
                label: agent.label,
                agent: agent.agent,
                via: hostOf(agent)?.name,
                source: agent.source,
                key: agent.tokenHash.slice(0, 8),
                at: agent.createdAt,
              }
            : { label: 'Unknown agent', source: '' }
        },
      },
      host: {
        durations: ['permanent'],
        wait: Number.POSITIVE_INFINITY,
        field: 'host',
        exists: (id) => hosts.has(id),
        who(id) {
          const host = hosts.get(id)
          return { label: `Sandbox host ${host?.name ?? id}`, source: host?.source ?? '', at: host?.registeredAt }
        },
      },
    },
  })
  const askHost = (id: string) => engine.request('host', id, [hostItem(id)], { reason: '', duration: 'permanent' })
  const registerHost = (host: Host) => {
    hosts.set(host.id, host)
    askHost(host.id)
    saveHosts()
  }
  for (const id of hosts.keys()) askHost(id)

  const snapshot = (hostId: string) => ({
    type: 'snapshot',
    grants: engine
      .grants()
      .filter((grant) => agentById(grant.subject)?.host === hostId && kinds[grant.kind].where !== 'speaker')
      .map(({ id, subject, item, kind, expiresAt }) => ({
        id,
        agentId: subject,
        item,
        expiresAt,
        ...kinds[kind].snapshot(item),
      })),
    secrets: Object.entries(ownerSecrets()).map(([name, { hosts, env }]) => ({ name, hosts, env })),
    requests: [...engine.requests.values()]
      .filter((request) => agentById(request.subject)?.host === hostId)
      .map((request) => ({
        id: request.id,
        agentId: request.subject,
        status: engine.statusOf(request),
        what: engine.outcomeOf(request).pending.join(', '),
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

  const coverFor = (agentId: string, service: string, write: boolean) =>
    engine.held(agentId, write ? [`${service}.full`] : [`${service}.full`, `${service}.read`])
  // Secrets proxy (proxy.ts). One random placeholder per agent per secret; the agent puts it where the secret goes and
  // speaker swaps it for the value in requests to the secret's allowed hosts.
  const placeholders = new Map<string, string>()
  const placeholderOf = (agentId: string, name: string) => {
    const key = `${agentId}\n${name}`
    if (!placeholders.has(key)) placeholders.set(key, `speaker-placeholder-${randomBytes(24).toString('hex')}`)
    return placeholders.get(key) as string
  }
  const secretGrants = (agentId: string): (ProxySecret & { name: string; env: string; release: boolean; until: string | null })[] =>
    engine
      .grants(agentId)
      .filter((grant) => grant.kind === 'secret')
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
  // The caller's address is the socket's; only the trusted proxy may name another one, with the last
  // X-Forwarded-For entry it appended. In-process app.fetch callers have no socket and share 'unknown'.
  const peerOf = (c: Context) =>
    (
      c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    )?.incoming?.socket?.remoteAddress?.replace(/^::ffff:/, '')
  // What TRUSTED_PROXY names now, looked up again every 30 s. A failed lookup keeps the last answer; one that never
  // succeeded trusts no one.
  let proxyAddresses = new Set<string>()
  const resolveProxy = async (name = config.TRUSTED_PROXY) => {
    if (!name) return
    try {
      proxyAddresses = new Set(isIP(name) ? [name] : (await lookup(name, { all: true })).map(({ address }) => address))
    } catch (error) {
      audit('trusted_proxy_unresolved', { name, error: (error as NodeJS.ErrnoException).code ?? String(error) })
    }
  }
  await resolveProxy()
  if (config.TRUSTED_PROXY && !isIP(config.TRUSTED_PROXY)) setInterval(resolveProxy, 30_000).unref()
  // An in-process caller (app.fetch, no socket) counts as the proxy when none is configured, as it always has.
  const trusted = (peer: string | undefined) =>
    peer === undefined ? config.TRUSTED_PROXY === undefined : proxyAddresses.has(peer)
  const sourceOf = (c: Context) => {
    const peer = peerOf(c)
    if (peer === undefined) return 'unknown'
    if (!trusted(peer)) return peer
    // The proxy appends the caller as the last entry; anything that is not an IP address leaves the proxy's own.
    const last = c.req
      .header('x-forwarded-for')
      ?.split(',')
      .at(-1)
      ?.trim()
      .replace(/^::ffff:/, '')
    return z.union([z.ipv4(), z.ipv6()]).safeParse(last).data ?? peer
  }
  const baseOf = (c: Context) => {
    const url = new URL(c.req.url)
    const proto = trusted(peerOf(c))
      ? z.enum(['http', 'https']).safeParse(c.req.header('x-forwarded-proto')).data
      : undefined
    return `${proto ?? url.protocol.slice(0, -1)}://${url.host}`
  }
  const enforcementOf = (grant: Approval): Enforcement => {
    const hostId = agentById(grant.subject)?.host
    if (!hostId || kinds[grant.kind].where !== 'host') return 'enforced'
    const connection = connections.get(hostId)
    if (!connection) return 'host-offline'
    return connection.applied.has(grant.id) ? 'enforced' : 'sent'
  }
  const view = (): View => ({
    hosts: [...hosts.values()].map((host) => ({ ...host, grant: hostGrant(host.id)?.id })),
    agents: enrolled().map((agent) => {
      const outcomes = [...engine.requests.values()].filter((r) => r.subject === agent.id).map(engine.outcomeOf)
      const items = (field: 'granted' | 'denied') => outcomes.flatMap((o) => o[field]).length
      return {
        ...agent,
        sandboxHost: hostOf(agent)?.name,
        grants: engine.grants(agent.id).length,
        requests: outcomes.length,
        granted: items('granted'),
        denied: items('denied'),
      }
    }),
    cards: engine.cards(),
    grants: engine
      .grants()
      .filter((grant) => kinds[grant.kind].subject === 'agent')
      .map((grant) => {
        const agent = agentById(grant.subject)
        return {
          ...grant,
          label: agent?.label ?? '',
          agent: agent?.agent ?? '',
          enforcement: enforcementOf(grant),
          bundledWith: (grant.with ?? []).flatMap((id) => engine.approvals.get(id)?.item ?? []),
          detail: engine.describe(grant),
        }
      }),
    sessions: jump.sessions(),
  })
  // A host titles only the agents it created; others in the report are ignored. Titles are display text only.
  const setTitles = (hostId: string, titles: Record<string, string>) => {
    for (const [id, title] of Object.entries(titles)) {
      const agent = agentById(id)
      if (agent?.host === hostId) agent.title = title
    }
  }
  function endAgent(id: string) {
    const agent = agentById(id)
    if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
    agent.status = 'revoked'
    agent.revokedAt = Date.now()
    engine.endSubject(id)
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
  const createOwnerStore = (password: string) =>
    engine.serial(async () => {
      if (vault.state !== 'unset') throw new HTTPException(409, { message: 'The owner password is already set' })
      await unlock(await createStore(storeFile, password, await newVault()))
    })
  const signIn = async (password: string) => {
    const opened = await openStore(storeFile, password)
    if (vault.state === 'locked') await unlock(opened)
  }
  const checkPassword = (password: string) => openStore(storeFile, password)
  // config.json may be edited by hand (the data folder can be a plain folder): it is read again when it changes. A
  // file that does not parse is refused and logged, and the running setup stays.
  watchFile(configFile, { interval: 2_000 }, async () => {
    try {
      const next = configSchema.parse(await json(configFile))
      if (JSON.stringify(next) === JSON.stringify(ownerConfig)) return // speaker's own save
      for (const key of ['services', 'groups', 'secrets'] as const) {
        for (const name of Object.keys(ownerConfig[key])) delete ownerConfig[key][name]
        Object.assign(ownerConfig[key], next[key])
      }
      mcpTools.clear()
      engine.reconcile()
      audit('config_reloaded')
    } catch (error) {
      audit('config_reload_failed', { why: String(error) })
    }
  }).unref()
  return {
    config,
    skill,
    enroll,
    services,
    groups,
    hosts,
    agents,
    agentById,
    enrolled,
    agentByToken,
    resolveAgent,
    engine,
    kinds,
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
    sweep,
    push,
    syncJump,
    snapshot,
    serviceItem,
    allowedKinds,
    coverFor,
    secretGrants,
    certificateAuthority,
    useOf,
    tally,
    listMcpTools,
    mcpAccess,
    upstreamUrl,
    applyCredential,
    hostOf,
    hostGrant,
    registerHost,
    ownerConfig,
    saveConfig,
    peerOf,
    sourceOf,
    baseOf,
    enforcementOf,
    view,
    setTitles,
    endAgent,
  }
}
export type Core = Awaited<ReturnType<typeof createCore>>
