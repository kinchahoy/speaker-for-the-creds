import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { serve, upgradeWebSocket } from '@hono/node-server'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { etag } from 'hono/etag'
import { HTTPException } from 'hono/http-exception'
import { NONCE, secureHeaders } from 'hono/secure-headers'
import type { WSContext } from 'hono/ws'
import { rateLimiter } from 'hono-rate-limiter'
import writeFile from 'write-file-atomic'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { createJump } from './jump.ts'
import {
  type GrantEvent,
  type GrantState,
  grantTable,
  hostStates,
  hostTable,
  IllegalTransition,
  type RequestEvent,
  type RequestState,
  requestTable,
  transition,
} from './lifecycle.ts'
import { createCa, createProxy, type ProxySecret, Refusal } from './proxy.ts'
import { createStore, generateSshKey, openStore, type Store, type Vault, WrongPassword } from './store.ts'
import { adminPage, livePanels, setPasswordPage, signInPage } from './ui.ts'

const idSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id))
const urlSchema = z.url().refine((value) => {
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
const durations = { '30m': 1800_000, '1h': 3600_000, '2h': 7200_000, '1d': 86_400_000, '30d': 2_592_000_000 }
const durationSchema = z.enum(['30m', '1h', '2h', '1d', '30d']).default('2h')
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
const serviceSchema = z.object({
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
// Items are strings; the pattern table doubles as the list of accepted forms in error messages.
const itemPatterns = {
  service: /^[a-zA-Z0-9_-]+\.(read|full)$/,
  site: /^site:(\*\.)?[a-zA-Z0-9.-]+$/,
  secret: /^secret:[A-Za-z0-9_]+(@[^@\s]+)?$/,
  ssh: /^ssh:[a-zA-Z0-9_-]+$/,
  folder: /^folder:[a-zA-Z0-9_-]+(:rw)?$/,
  mcp: /^mcp:[a-zA-Z0-9_-]+$/,
  ext: /^ext:[a-zA-Z0-9_-]+$/,
  group: /^group:[a-zA-Z0-9_-]+$/,
}
const itemForms = [
  '<service>.read',
  '<service>.full',
  'site:<host>',
  'secret:<NAME>',
  'ssh:<target>',
  'folder:<share>[:rw]',
  'mcp:<id>',
  'ext:<id>',
  'group:<name>',
]
const kindOf = (item: string) => Object.entries(itemPatterns).find(([, pattern]) => pattern.test(item))?.[0]
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
const groupDescriptionSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[^\r\n]*$/)
  .optional()
const groupItemsSchema = z.array(itemSchema.refine((item) => kindOf(item) !== 'group', 'Groups cannot contain groups'))
const groupsSchema = z.record(idSchema, z.object({ description: groupDescriptionSchema, items: groupItemsSchema }))
const hostSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kinds: z.array(z.enum(hostKinds)).max(hostKinds.length),
  tokenHash: hashSchema,
  status: z.enum(hostStates),
})
const reasonSchema = z.string().trim().min(1).max(500)
const identitySchema = z.object({
  label: z.string().trim().min(1).max(200),
  agent: z.string().trim().min(1).max(120).default('unknown'),
})
const requestSchema = z.object({
  want: z.array(itemSchema).min(1).max(50),
  reason: reasonSchema,
  duration: durationSchema,
  sshKey: sshKeySchema.optional(),
})
// Enrollment carries the identity and, optionally, the first request (want may be empty).
const enrollSchema = identitySchema
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
const newPasswordSchema = z
  .object({ password: z.string().min(8, 'Use at least 8 characters.'), confirm: z.string() })
  .refine((value) => value.password === value.confirm, { message: 'The two passwords differ.', path: ['confirm'] })
const ownerSecretSchema = z.object({
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
const decisionSchema = z.object({
  duration: adminDurationSchema,
  items: listSchema.default([]),
  shown: listSchema,
})

export type Service = z.infer<typeof serviceSchema>
export type Group = z.infer<typeof groupsSchema>[string]
export type Host = z.infer<typeof hostSchema>
type Duration = z.infer<typeof adminDurationSchema>
type Usage = { uses: number; lastUsedAt: number | null }
export type Agent = Usage & {
  id: string
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
export type Grant = Usage & {
  id: string
  agentId: string
  item: string
  // null: until revoked (owner only).
  expiresAt: string | null
  // The span the owner approved; Extend adds it again.
  grantedMs?: number
  status: GrantState
  requestId: string
}
export type Request = {
  id: string
  agentId: string
  // Items still awaiting the owner; granted and denied are the decided ones.
  items: string[]
  want: string[]
  granted: string[]
  denied: string[]
  reason: string
  duration: z.infer<typeof durationSchema>
  status: RequestState
  // The service call that filed it, if any.
  trigger?: string
  // When the granted items end (null: until revoked).
  expiresAt?: number | null
  grantIds: string[]
  notification: 'disabled' | 'sending' | 'sent' | 'failed'
  createdAt: number
  decidedAt?: number
}
export type GrantView = Grant & { label: string; agent: string; state: 'active' | 'granted' | 'waiting' }
export type AgentView = Agent & { sandboxHost?: string; grants: number }
export type View = {
  hosts: (Host & { shares: { name: string; mount: boolean }[] })[]
  agents: AgentView[]
  requests: Request[]
  grants: GrantView[]
  // Open SSH sessions, and what an ssh: or folder: item reaches for an agent (keyed `agentId item`).
  sessions: { id: string; agent: string; what: string; started: number }[]
  details: Record<string, { text: string; warning?: string }>
}
export type LogEntry = { time: string; event: string; agent?: string; label?: string; [field: string]: unknown }

type Caller = { role: 'host'; host: Host } | { role: 'agent'; agent: Agent }
type Env = { Variables: { caller: Caller } }
const demoSecret = 'speaker-demo-credential-not-for-real-services'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const union = (...lists: string[][]) => [...new Set(lists.flat())]
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      DATA_DIR: z.string().default('./data'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      // Required: push links and the admin CSRF origin use it.
      PUBLIC_URL: urlSchema,
      NTFY_URL: urlSchema.optional(),
      NTFY_TOPIC: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
      NTFY_TOKEN: z.string().optional(),
      // Port of the HTTPS proxy that inserts secrets (see proxy.ts); the proxy is off when unset.
      PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
      // The jump server's port; without it SSH and folders over SSH are off.
      SSH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
      // Address of the reverse proxy whose last X-Forwarded-For entry names the real caller; ignored from anyone else.
      TRUSTED_PROXY: z.union([z.ipv4(), z.ipv6()]).optional(),
    })
    .refine((value) => Boolean(value.NTFY_URL) === Boolean(value.NTFY_TOPIC), 'Set both NTFY_URL and NTFY_TOPIC')
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
export const wss = new WebSocketServer({ noServer: true })
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
const invalid = (message: string, accepted?: string[], status: 400 | 404 = 400) =>
  new HTTPException(status, {
    res: Response.json({ error: 'invalid', message, ...(accepted ? { accepted } : {}) }, { status }),
  })

export async function createApp(config: ReturnType<typeof readConfig>) {
  const dataDir = resolve(config.DATA_DIR)
  const skill = await readFile(new URL('./skill/SKILL.md', import.meta.url), 'utf8')
  const help = await readFile(new URL('./skill/help.md', import.meta.url), 'utf8')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const file = (name: string) => join(dataDir, name)
  const servicesFile = file('services.json')
  const starter = z
    .record(idSchema, serviceSchema)
    .parse(JSON.parse(await readFile(new URL('./services.example.json', import.meta.url), 'utf8')))
  starter.demo.baseUrl = `http://127.0.0.1:${config.PORT}/_demo-upstream`
  const stored = await optionalFile(servicesFile),
    imported = file('.starter-services-imported')
  const services = stored === undefined ? starter : z.record(idSchema, serviceSchema).parse(JSON.parse(stored))
  // One-time starter import; never resurrect services deleted in the UI.
  if (stored === undefined || (await optionalFile(imported)) === undefined) {
    for (const [id, service] of Object.entries(starter)) {
      if (!Object.hasOwn(services, id)) services[id] = service
    }
    await save(servicesFile, services)
    await writeFile(imported, 'done', { mode: 0o600 })
  }
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
  // Service keys in clear, empty until the owner unlocks the encrypted store (see "Keys and sign-in" below).
  const secrets = new Map<string, string>()
  // Keys and sign-in. The store appears when the owner first sets a password; after every restart speaker is locked
  // until the owner signs in, which unwraps the data key. Sessions live in memory only.
  const storeFile = file('store.json')
  let store: Store | undefined
  let hasStore = (await optionalFile(storeFile)) !== undefined
  const unlocked = () => {
    if (!store) throw new Error('Speaker is locked')
    return store
  }
  const unlock = async (opened: Store) => {
    store = opened
    for (const [id, key] of Object.entries(opened.vault.services)) secrets.set(id, key)
    // Speaker's SSH key goes into a stock ssh-agent; nothing else holds it in clear.
    await jump.start(opened.vault.ssh)
  }
  // A service's key, or '' for a keyless service; undefined when a keyed service has none yet.
  const credentialOf = (id: string) => (services[id]?.auth.type === 'none' ? '' : secrets.get(id))
  const persistServiceKeys = () => {
    unlocked().vault.services = Object.fromEntries(secrets)
    return unlocked().save()
  }
  // First unlock: speaker's SSH key and the service keys from the plaintext files of earlier versions.
  async function newVault() {
    const vault: Vault = { services: {}, secrets: {}, ssh: await generateSshKey() }
    for (const [id, service] of Object.entries(services)) {
      if (service.auth.type === 'none') continue
      const plaintext = await optionalFile(join(dataDir, 'secrets', service.auth.secret))
      if (plaintext !== undefined) vault.services[id] = plaintext
    }
    if (services.demo && vault.services.demo === undefined) vault.services.demo = demoSecret
    return vault
  }
  const sessions = new Map<string, number>()
  const sessionLife = 12 * 3600_000
  const sessionCookie = 'speaker_session'
  const signedIn = (c: Context) => {
    const id = getCookie(c, sessionCookie)
    return id !== undefined && (sessions.get(id) ?? 0) > Date.now()
  }
  // Agents, grants, requests and usage live in memory only: a restart starts them empty.
  const agents = new Map<string, Agent>()
  const grants = new Map<string, Grant>()
  const requests = new Map<string, Request>()
  // Token hashes of revoked agents: they answer `denied` rather than `enroll` until restart.
  const revoked = new Set<string>()
  const sockets = new Map<string, WSContext>()
  const applied = new Map<string, Set<string>>()
  // The shares each connected sandbox host holds and whether it can mount them (recorded for folder delivery).
  const hostShares = new Map<string, { name: string; mount: boolean }[]>()
  const strikes = new Map<string, number[]>()
  // The log: every event goes to standard output and into this buffer, which the admin Log page reads.
  const logged: LogEntry[] = []
  const audit = (event: string, fields: Record<string, unknown> = {}) => {
    const who = typeof fields.agent === 'string' ? agents.get(fields.agent) : undefined
    const entry: LogEntry = {
      time: new Date().toISOString(),
      event,
      ...fields,
      ...(who ? { label: who.label, agentName: who.agent } : {}),
    }
    console.log(JSON.stringify(entry))
    if (logged.unshift(entry) > 500) logged.pop()
  }
  let version = 0
  const rid = () => randomBytes(16).toString('hex')
  const live = (grant: { expiresAt: string | null }) =>
    grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()
  const expiry = (duration: Duration) =>
    duration === 'permanent' ? null : new Date(Date.now() + durations[duration]).toISOString()
  // SSH and folders over SSH: targets, shares, the jump server and its relay (see jump.ts).
  const jump = await createJump({
    port: config.SSH_PORT,
    dataDir,
    agent: (id) => agents.get(id),
    grants: () => [...grants.values()].filter(live),
    mountable: (agentId) => Boolean(hostOf(agents.get(agentId) ?? {})?.kinds.includes('folder')),
    audit,
    expire: () => sweep(),
  })
  const syncJump = () => void jump.sync().catch(() => undefined)
  function moveRequest(request: Request, event: RequestEvent) {
    const from = request.status
    request.status = transition('request', requestTable, from, event)
    audit(`request_${request.status}`, {
      request: request.id,
      agent: request.agentId,
      from,
      granted: request.granted,
      denied: request.denied,
    })
  }
  function moveGrant(grant: Grant, event: GrantEvent) {
    grant.status = transition('grant', grantTable, grant.status, event)
    audit(`grant_${grant.status}`, { grant: grant.id, agent: grant.agentId, item: grant.item })
  }
  // Applies clock-driven transitions before every HTTP request: expired grants and requests, idle agents.
  function sweep() {
    const now = Date.now()
    for (const [id, end] of sessions) if (end <= now) sessions.delete(id)
    let ended = false
    for (const grant of grants.values())
      if (!live(grant)) {
        moveGrant(grant, 'expire')
        grants.delete(grant.id)
        ended = true
      }
    for (const [id, request] of requests) {
      if (request.status === 'pending' && now - request.createdAt >= requestLifetime) moveRequest(request, 'expire')
      if (request.status !== 'pending' && now - (request.decidedAt ?? request.createdAt) >= 86_400_000)
        requests.delete(id)
    }
    const hasGrant = (id: string) => [...grants.values()].some((grant) => grant.agentId === id)
    for (const agent of agents.values())
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
  type McpTool = { readOnly: boolean; destructive: boolean; annotated: boolean }
  const mcpTools = new Map<string, { at: number; tools: Map<string, McpTool> }>()
  // Lists an MCP service's tools with speaker's own credentialed session (initialize, tools/list, close).
  async function listMcpTools(id: string) {
    const service = services[id],
      secret = credentialOf(id)
    if (!service || secret === undefined) throw new Error('MCP service or credential missing')
    const url = upstreamUrl(service, secret, [], '')
    if (!url) throw new Error('Invalid MCP service URL')
    let sessionId: string | undefined
    let version: string | undefined
    const rpc = async (body: { id?: number; method: string; params?: object }, method = 'POST') => {
      const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
      if (sessionId) headers.set('mcp-session-id', sessionId)
      if (version) headers.set('mcp-protocol-version', version)
      applyCredential(service, secret, headers)
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', ...body }) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`MCP ${body.method} returned ${response.status}`)
      sessionId = response.headers.get('mcp-session-id') ?? sessionId
      const text = await response.text()
      if (body.id === undefined || !text) return undefined
      const messages = response.headers.get('content-type')?.includes('text/event-stream')
        ? text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => JSON.parse(line.slice(5)))
        : [JSON.parse(text)]
      return messages.find((message) => message.id === body.id)?.result
    }
    const init = await rpc({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'speaker', version: '1' } },
    })
    version = init?.protocolVersion
    await rpc({ method: 'notifications/initialized' })
    const tools = new Map<string, McpTool>()
    let cursor: string | undefined
    do {
      const page = await rpc({ id: 2, method: 'tools/list', params: cursor ? { cursor } : {} })
      for (const tool of page?.tools ?? [])
        tools.set(tool.name, {
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true,
          annotated: Boolean(tool.annotations),
        })
      cursor = page?.nextCursor
    } while (cursor)
    if (sessionId) await rpc({ method: 'session/close' }, 'DELETE').catch(() => undefined)
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
  const secretHosts = (name: string) =>
    store && Object.hasOwn(store.vault.secrets, name) ? store.vault.secrets[name].hosts : []
  const snapshot = (hostId: string) => ({
    type: 'snapshot',
    version,
    grants: [...grants.values()]
      .filter((grant) => live(grant) && agents.get(grant.agentId)?.host === hostId && !jump.overSsh(grant))
      .map(({ id, agentId, item, expiresAt }) => ({
        id,
        agentId,
        item,
        expiresAt,
        // A secret grant carries the hosts the owner bound it to, never the value.
        ...(item.startsWith('secret:') ? { hosts: secretHosts(item.slice('secret:'.length)) } : {}),
      })),
    // What a sandboxed agent may ask for, so the sandbox host can name them in its instructions.
    secrets: Object.entries(store?.vault.secrets ?? {}).map(([name, { hosts, env }]) => ({ name, hosts, env })),
    requests: [...requests.values()]
      .filter((request) => agents.get(request.agentId)?.host === hostId)
      .map((request) => ({
        id: request.id,
        agentId: request.agentId,
        status: request.status,
        what: request.items.join(', '),
        reason: request.reason,
      })),
  })
  function push() {
    version++
    syncJump()
    for (const [id, ws] of sockets) ws.send(JSON.stringify(snapshot(id)))
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
          owned = store && Object.hasOwn(store.vault.secrets, name) ? store.vault.secrets[name] : undefined
        return owned ? [{ ...owned, name, until: grant.expiresAt, placeholder: placeholderOf(agentId, name) }] : []
      })
  // The proxy's certificate authority: made at first need, kept in the encrypted store.
  let authority: Promise<{ cert: string; key: string }> | undefined
  const certificateAuthority = () => {
    const opened = store
    if (!opened) throw new Refusal(503, `Speaker is locked: the owner signs in at ${config.PUBLIC_URL}/admin`)
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
  function addGrant(request: Request, item: string, expiresAt: string | null, duration: Duration) {
    for (const old of [...grants.values()])
      if (old.agentId === request.agentId && old.item === item) grants.delete(old.id)
    const grant: Grant = {
      id: rid(),
      agentId: request.agentId,
      item,
      expiresAt,
      status: 'active',
      requestId: request.id,
      uses: 0,
      lastUsedAt: null,
    }
    if (duration !== 'permanent') grant.grantedMs = durations[duration]
    grants.set(grant.id, grant)
    request.grantIds.push(grant.id)
    audit('grant_created', { grant: grant.id, agent: grant.agentId, item, expiresAt })
  }
  const revokeGrants = (matches: (grant: Grant) => boolean) => {
    for (const grant of [...grants.values()])
      if (matches(grant)) {
        moveGrant(grant, 'revoke')
        grants.delete(grant.id)
      }
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
      transition('request', requestTable, request.status, 'decide')
      if (!agents.has(request.agentId)) throw new HTTPException(409, { message: 'Agent was removed' })
      const take = new Set(approved)
      const seen = new Set(shown)
      const yes = request.items.filter((item) => seen.has(item) && take.has(item))
      const no = request.items.filter((item) => seen.has(item) && !take.has(item))
      if (!yes.length && !no.length) throw new HTTPException(409, { message: 'None of the shown items are pending' })
      const expiresAt = expiry(duration)
      for (const item of yes) addGrant(request, item, expiresAt, duration)
      // The agent is told "granted" only once the jump server is listening for its new grants.
      if (yes.length) await jump.sync()
      for (const item of no)
        strikes.set(strikeKey(request.agentId, item), [...recentStrikes(strikeKey(request.agentId, item)), Date.now()])
      request.granted.push(...yes)
      request.denied.push(...no)
      request.items = request.items.filter((item) => !seen.has(item))
      if (yes.length) request.expiresAt = expiresAt === null ? null : Date.parse(expiresAt)
      if (!request.items.length) {
        request.decidedAt = Date.now()
        moveRequest(request, 'decide')
      }
      push()
    })
  }
  async function notify(
    title: string,
    anchor: string,
    message = 'Open the approval page to decide.',
  ): Promise<'disabled' | 'sent' | 'failed'> {
    if (!config.NTFY_URL) return 'disabled'
    try {
      const response = await fetch(config.NTFY_URL, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          ...(config.NTFY_TOKEN ? { authorization: `Bearer ${config.NTFY_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          topic: config.NTFY_TOPIC,
          title,
          message,
          click: `${config.PUBLIC_URL.replace(/\/$/, '')}/admin#${anchor}`,
        }),
      })
      if (!response.ok) throw new Error('Notification rejected')
      await response.body?.cancel()
      return 'sent'
    } catch (error) {
      // Audited boundary: a push is best-effort and must never block a request.
      // The admin page shows the failed state on the request.
      audit('notification_failed', { anchor, cause: String(error) })
      return 'failed'
    }
  }
  // Items the owner never grants are denied at once, open reads need no grant, and locked items are denied without a
  // card; the rest join the agent's pending request (or start one).
  function createRequest(
    agent: Agent,
    items: string[],
    want: string[],
    reason: string,
    duration: Request['duration'],
    trigger?: string,
  ) {
    const outcome = { granted: [] as string[], denied: [] as string[], ask: [] as string[] }
    for (const item of items) {
      const target = serviceItem(item)
      const service = target && services[target.id]
      const rule = service && (target.write ? service.write : service.read)
      const missing = jump.unavailable(agent.id, item)
      // A name that does not exist or cannot be delivered is denied at once and logged for the owner, with no card.
      if (missing !== undefined) {
        audit('request_unavailable', { agent: agent.id, item, why: missing })
        outcome.denied.push(item)
      } else if (rule === 'never' || lockedUntil(agent.id, item) !== undefined) outcome.denied.push(item)
      else if (rule === 'open') outcome.granted.push(item)
      else outcome.ask.push(item)
    }
    const existing = [...requests.values()].find((r) => r.agentId === agent.id && r.status === 'pending')
    const request: Request = existing ?? {
      id: rid(),
      agentId: agent.id,
      items: [],
      want: [],
      granted: [],
      denied: [],
      reason: '',
      duration,
      status: 'pending',
      trigger,
      grantIds: [],
      notification: config.NTFY_URL ? 'sending' : 'disabled',
      createdAt: Date.now(),
    }
    request.items = union(request.items, outcome.ask)
    request.want = union(request.want, want)
    request.granted = union(request.granted, outcome.granted)
    request.denied = union(request.denied, outcome.denied)
    if (reason) Object.assign(request, { reason, duration })
    if (existing) return request
    requests.set(request.id, request)
    push()
    audit('request_created', { request: request.id, agent: agent.id, items, reason, trigger })
    if (request.items.length) {
      void notify(`${agent.label} requests ${request.items.join(', ')}`, `request-${request.id}`).then((state) => {
        request.notification = state
      })
    } else {
      request.decidedAt = Date.now()
      if (request.granted.length) request.expiresAt = null
      moveRequest(request, 'decide')
    }
    return request
  }

  const app = new Hono<Env>()
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // Agent routes answer in JSON; admin pages keep their plain-text messages.
      if (error.res || c.req.path.startsWith('/admin')) return error.getResponse()
      return c.json({ error: 'invalid', message: error.message }, error.status)
    }
    if (error instanceof IllegalTransition) return c.json({ error: 'conflict', message: error.message }, 409)
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: 'invalid',
          fields: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            ...('values' in issue ? { accepted: issue.values } : {}),
          })),
        },
        400,
      )
    if (error instanceof SyntaxError) return c.json({ error: 'invalid', message: 'Body is not valid JSON' }, 400)
    audit('request_failed', { type: error.name, message: error.message })
    return c.json({ error: 'internal_error' }, 500)
  })

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
  const tellUser = (c: Context, anchor: string) => `Ask the owner to approve at ${baseOf(c)}/admin#${anchor}`
  const withAddress = (c: Context, text: string) => text.replaceAll('$SPEAKER_URL', baseOf(c))
  // Every agent-facing 401 names the next step and points at the skill.
  const unauthorized = (c: Context, error: string, fields: Record<string, string>) => {
    c.header('www-authenticate', 'Bearer realm="speaker"')
    c.header('link', '</skill.md>; rel="help"')
    return c.json({ error, ...fields, help: '/skill.md' }, 401)
  }
  // Until the owner signs in after a restart, every agent and sandbox-host call is refused.
  const locked: MiddlewareHandler<Env> = async (c, next) => {
    if (hasStore && !store)
      return c.json({ error: 'locked', tell_user: `Speaker restarted: sign in at ${baseOf(c)}/admin to unlock` }, 503)
    await next()
  }
  const enrollNext = 'Enroll again with a new token: GET /_speaker/help'
  // Resolves a bearer token to an approved sandbox host or an agent.
  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const token = /^Bearer +(\S+) *$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) return unauthorized(c, 'enroll', { next: `Send Authorization: Bearer <token>. ${enrollNext}` })
    const digest = hash(token)
    if (revoked.has(digest))
      return c.json({ error: 'denied', next: 'Stop: the owner revoked this agent. Tell the user.' }, 403)
    const byToken = <T extends { tokenHash: string }>(items: Map<string, T>) =>
      [...items.values()].find((item) => same(item.tokenHash, digest))
    const host = byToken(hosts),
      agent = byToken(agents)
    if (host?.status === 'approved') c.set('caller', { role: 'host', host })
    else if (host) return unauthorized(c, 'approval_required', { tell_user: tellUser(c, `host-${host.id}`) })
    else if (agent && agent.source === sourceOf(c)) {
      agent.lastSeen = Date.now()
      c.set('caller', { role: 'agent', agent })
    } else return unauthorized(c, 'enroll', { next: enrollNext })
    await next()
  }
  const hostCaller = (c: Context<Env>) => {
    const caller = c.get('caller')
    if (caller.role !== 'host') throw invalid('A sandbox host token is required here')
    return caller.host
  }
  const agentCaller = (c: Context<Env>) => {
    const caller = c.get('caller')
    if (caller.role !== 'agent') throw invalid('An agent token is required here')
    return caller.agent
  }
  // Holds a call for up to `Speaker-Wait` seconds (max 120) until `settled`; without the header it answers at once.
  const hold = async (c: Context<Env>, settled: () => boolean) => {
    const until = Date.now() + Math.min(Number(c.req.header('speaker-wait')) || 0, 120) * 1000
    while (!settled() && Date.now() < until && !c.req.raw.signal.aborted) await sleep(500)
  }
  // Item kinds an agent may ask for: services, groups, secrets when the proxy is on, SSH and folders, plus what its
  // sandbox host enforces.
  const allowedKinds = (agent: Agent): string[] => [
    'service',
    'group',
    ...(config.PROXY_PORT ? ['secret'] : []),
    'ssh',
    'folder',
    ...(hostOf(agent)?.kinds ?? []),
  ]
  // A group is offered only if every member is a kind the agent can use.
  const offered = (agent: Agent) =>
    Object.entries(groups).filter(([, group]) =>
      group.items.every((item) => allowedKinds(agent).includes(kindOf(item) ?? '')),
    )
  // Expands groups and checks every item may be asked for by this agent.
  function resolveItems(want: string[], agent: Agent) {
    const items = want.flatMap((item) => {
      if (kindOf(item) !== 'group') return [item]
      const group = offered(agent).find(([name]) => `group:${name}` === item)
      if (!group) throw invalid(`Unknown group ${item}`, [...offered(agent).map(([name]) => `group:${name}`)])
      return group[1].items
    })
    for (const item of items) {
      const kind = kindOf(item) ?? ''
      if (!allowedKinds(agent).includes(kind)) throw invalid(`${item} is not available to this agent`, itemForms)
      const target = serviceItem(item)
      if (target && (!Object.hasOwn(services, target.id) || credentialOf(target.id) === undefined))
        throw invalid(`Unknown service ${target.id}`)
    }
    return union(items)
  }
  // Granted items its sandbox host has not yet reported in force: they count as granted for the agent only once it has.
  const applying = (request: Request) =>
    request.grantIds.flatMap((id) => {
      const grant = grants.get(id)
      return grant && live(grant) && grantState(grant) !== 'active' ? [grant.item] : []
    })
  // A request as the agent sees it: per-item outcome, and what to do next.
  const outcome = (c: Context, request: Request) => {
    const retry = retryAfter(request.agentId, request.denied)
    const waiting = applying(request)
    return {
      id: request.id,
      status: request.status,
      granted: request.granted.filter((item) => !waiting.includes(item)),
      denied: request.denied,
      ...(waiting.length ? { applying: waiting } : {}),
      ...(request.granted.length
        ? { expiresAt: request.expiresAt ? new Date(request.expiresAt).toISOString() : null }
        : {}),
      ...(retry ? { retry_after: retry } : {}),
      ...(request.status === 'pending'
        ? {
            next: 'Repeat this call with Speaker-Wait: 60 to keep waiting for the owner',
            tell_user: tellUser(c, `request-${request.id}`),
          }
        : request.status === 'expired'
          ? { next: 'The owner did not decide in time. POST /_speaker/requests again if the task still needs it' }
          : request.denied.length
            ? { next: 'Stop asking for the denied items and tell the user' }
            : waiting.length
              ? { next: 'Granted; the sandbox is applying it. Retry what was blocked in a few seconds' }
              : {}),
    }
  }
  // Files the request, holds for the owner when asked to, and answers with the per-item outcome.
  async function ask(c: Context<Env>, agent: Agent, input: z.infer<typeof requestSchema>) {
    // A newer key replaces the older one.
    if (input.sshKey) {
      agent.sshKey = input.sshKey
      syncJump()
    }
    const items = resolveItems(input.want, agent)
    // A folder the agent's sandbox mounts needs no key (and Pi cannot send one); every other ssh: or folder: item does.
    if (
      !agent.sshKey &&
      items.some((item) => ['ssh', 'folder'].includes(kindOf(item) ?? '') && !jump.mounted(agent.id, item))
    )
      throw invalid('ssh: and folder: items need "sshKey": one throwaway public key of yours (ssh-ed25519 …)')
    const request = createRequest(agent, items, input.want, input.reason, input.duration)
    // `mcp:` and `ext:` take effect when Pi is idle, which this held call prevents, so only the others are waited for.
    await hold(
      c,
      () =>
        request.status !== 'pending' && !applying(request).some((item) => !['mcp', 'ext'].includes(kindOf(item) ?? '')),
    )
    return outcome(c, request)
  }

  app.use('*', async (_c, next) => {
    sweep()
    await next()
  })
  // Enrollment and registration are unauthenticated: one shared budget caps how many identities anyone can create.
  // Behind a reverse proxy every client shares one address anyway, so a per-address key would add nothing.
  const enrollmentLimit = rateLimiter<Env>({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    keyGenerator: () => 'enrollment',
    message: { error: 'rate_limited', next: 'Wait a few minutes before enrolling again' },
  })
  app.get('/_speaker/health', (c) => c.json({ ok: true }))
  // The proxy's public certificate: agents trust it for the hosts of their secrets.
  if (config.PROXY_PORT)
    app.get('/_speaker/proxy/ca.pem', async (c) => {
      try {
        return c.text((await certificateAuthority()).cert, 200, { 'content-type': 'application/x-pem-file' })
      } catch (error) {
        if (error instanceof Refusal) return c.json({ error: 'locked', message: error.message }, 503)
        throw error
      }
    })
  // Public discovery: what speaker is and where the instructions are. Services and groups stay behind auth.
  const markdown = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'max-age=3600' }
  app.use('/skill.md', etag())
  app.use('/_speaker/help', etag())
  app.get('/skill.md', (c) => c.text(withAddress(c, skill), 200, markdown))
  app.get('/_speaker/help', (c) => c.text(withAddress(c, help), 200, markdown))
  app.get('/', (c) =>
    c.req.header('accept')?.includes('text/html')
      ? c.html(
          '<!doctype html><meta charset="utf-8"><title>Speaker</title><p>Speaker gives AI agents owner-approved access to homelab APIs; agents never see the keys.</p><p>Owner: approve requests at <a href="/admin">/admin</a>.</p><p>Agents: <a href="/skill.md">/skill.md</a>.</p>',
        )
      : c.text(withAddress(c, skill), 200, markdown),
  )
  app.post('/_speaker/agents', locked, enrollmentLimit, async (c) => {
    const { tokenHash, want, reason, duration, sshKey, ...identity } = enrollSchema.parse(await c.req.json())
    const source = sourceOf(c)
    let agent = [...agents.values()].find((a) => same(a.tokenHash, tokenHash))
    if (agent && agent.source !== source)
      throw invalid('This token is already enrolled from another address; make a new token and enroll again')
    const created = !agent
    if (!agent) {
      agent = {
        id: rid(),
        tokenHash,
        ...identity,
        source,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        uses: 0,
        lastUsedAt: null,
      }
      agents.set(agent.id, agent)
      audit('agent_enrolled', { agent: agent.id, source })
    }
    const result = want.length ? await ask(c, agent, { want, reason: reason ?? '', duration, sshKey }) : undefined
    if (!result && sshKey) agent.sshKey = sshKey
    return c.json(
      { id: agent.id, ...(result ? { request: result } : { next: 'GET /_speaker/me' }) },
      created ? 201 : 200,
    )
  })
  app.post('/_speaker/hosts', locked, enrollmentLimit, async (c) => {
    const input = hostSchema.pick({ name: true, kinds: true, tokenHash: true }).parse(await c.req.json())
    const host: Host = { id: rid(), ...input, status: 'pending' }
    hosts.set(host.id, host)
    await saveHosts()
    audit('host_registered', { host: host.id, name: host.name })
    void notify(`Sandbox host ${host.name} wants to register`, `host-${host.id}`)
    return c.json({ id: host.id, status: host.status }, 201)
  })
  app.all('/_demo-upstream/*', async (c) => {
    if (c.req.header('authorization') !== `Bearer ${demoSecret}`)
      return c.json({ error: 'demo_credential_rejected' }, 401)
    const body = await c.req.text()
    return c.json({
      ok: true,
      credential: 'accepted',
      method: c.req.method,
      path: c.req.path,
      bodyBytes: Buffer.byteLength(body),
    })
  })

  const admin = new Hono()
  admin.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        scriptSrc: [NONCE],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    }),
  )
  admin.use('*', async (c, next) => {
    c.header('cache-control', 'no-store')
    await next()
  })
  admin.use('*', csrf({ origin: new URL(config.PUBLIC_URL).origin }))
  admin.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    // Fetch Metadata identifies browser same-origin requests even when TLS ends at a reverse proxy.
    // Keep the explicit Origin check for JSON clients, which Hono's form CSRF middleware skips.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      origin &&
      origin !== new URL(config.PUBLIC_URL).origin &&
      c.req.header('sec-fetch-site') !== 'same-origin'
    )
      return c.text(
        'Cross-origin request rejected. Open the admin page directly; check PUBLIC_URL if using a proxy.',
        403,
      )
    await next()
  })
  // Sign-in is the only way in: the first visit sets the owner password, later visits sign in with it.
  const signInLimit = rateLimiter({
    windowMs: 15 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    skipSuccessfulRequests: true,
    keyGenerator: (c) => sourceOf(c),
    message: 'Too many failed attempts; wait a few minutes.',
  })
  const authPage = (c: Context, error?: string, status: 200 | 400 | 401 = 200) => {
    // Plain HTTP from another machine sends the password in clear.
    const exposed = !baseOf(c).startsWith('https:') && !/^(127\.|::1$)/.test(sourceOf(c))
    return c.html(hasStore ? signInPage(exposed, error) : setPasswordPage(exposed, error), status)
  }
  const startSession = (c: Context) => {
    const id = rid()
    sessions.set(id, Date.now() + sessionLife)
    setCookie(c, sessionCookie, id, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: baseOf(c).startsWith('https:'),
      path: '/admin',
      maxAge: sessionLife / 1000,
    })
    return c.redirect('/admin', 303)
  }
  admin.post('/setup', signInLimit, async (c) => {
    const input = newPasswordSchema.safeParse(await c.req.parseBody())
    if (!input.success) return authPage(c, input.error.issues[0].message, 400)
    await serial(async () => {
      if (hasStore) throw new HTTPException(409, { message: 'The owner password is already set' })
      await unlock(await createStore(storeFile, input.data.password, await newVault()))
      hasStore = true
    })
    // Their keys are in the store now: the plaintext files of earlier versions go.
    await rm(join(dataDir, 'secrets'), { recursive: true, force: true })
    audit('owner_password_set')
    return startSession(c)
  })
  admin.post('/signin', signInLimit, async (c) => {
    if (!hasStore) return c.redirect('/admin', 303)
    const { password } = z.object({ password: z.string() }).parse(await c.req.parseBody())
    try {
      const opened = await openStore(storeFile, password)
      if (!store) await unlock(opened)
    } catch (error) {
      if (!(error instanceof WrongPassword)) throw error
      audit('signin_failed', { source: sourceOf(c) })
      return authPage(c, 'Wrong password.', 401)
    }
    audit('owner_signed_in')
    return startSession(c)
  })
  admin.use('*', async (c, next) => {
    if (signedIn(c)) return await next()
    if (c.req.method !== 'GET') return c.text('Sign in at /admin', 401)
    return c.req.path === '/admin' ? authPage(c) : c.redirect('/admin', 303)
  })
  const grantState = (grant: Grant): GrantView['state'] => {
    const hostId = agents.get(grant.agentId)?.host
    if (!hostId || serviceItem(grant.item) || jump.overSsh(grant)) return 'active'
    if (!sockets.has(hostId)) return 'waiting'
    return applied.get(hostId)?.has(grant.id) ? 'active' : 'granted'
  }
  const view = (): View => ({
    hosts: [...hosts.values()].map((host) => ({ ...host, shares: hostShares.get(host.id) ?? [] })),
    agents: [...agents.values()].map((agent) => ({
      ...agent,
      sandboxHost: hostOf(agent)?.name,
      grants: [...grants.values()].filter((grant) => grant.agentId === agent.id).length,
    })),
    requests: [...requests.values()],
    grants: [...grants.values()].filter(live).map((grant) => {
      const agent = agents.get(grant.agentId)
      return { ...grant, label: agent?.label ?? '', agent: agent?.agent ?? '', state: grantState(grant) }
    }),
    sessions: jump.sessions(),
    details: Object.fromEntries(
      [
        ...[...requests.values()]
          .filter((r) => r.status === 'pending')
          .flatMap((r) => r.items.map((i) => [r.agentId, i])),
        ...[...grants.values()].filter(live).map((g) => [g.agentId, g.item]),
      ].flatMap(([agentId, item]) => {
        const detail = jump.describe(agentId, item)
        return detail ? [[`${agentId} ${item}`, detail]] : []
      }),
    ),
  })
  // Newest entries first, optionally narrowed to one grant, agent, service, target or share.
  admin.get('/log', (c) => {
    const { grant, agent, service, target, share } = c.req.query()
    const entries = logged.filter(
      (e) =>
        (!grant || e.grant === grant) &&
        (!agent || e.agent === agent) &&
        (!target || e.target === target) &&
        (!share || e.share === share) &&
        (!service ||
          e.service === service ||
          (Array.isArray(e.items) && e.items.some((i) => String(i).startsWith(`${service}.`)))),
    )
    return c.html(
      adminPage(
        services,
        secrets,
        view(),
        undefined,
        c.get('secureHeadersNonce'),
        'log',
        groups,
        undefined,
        {},
        { entries, query: { grant, agent, service, target, share } },
        undefined,
        jump.setup(),
      ),
    )
  })
  admin.get('/', (c) =>
    c.html(
      adminPage(
        services,
        secrets,
        view(),
        c.req.query('service'),
        c.get('secureHeadersNonce'),
        c.req.query('section'),
        groups,
        c.req.query('error'),
        Object.fromEntries(
          [...mcpTools].map(([id, { at, tools }]) => {
            const list = [...tools.values()]
            return [
              id,
              {
                at,
                read: list.filter((tool) => tool.readOnly).length,
                write: list.filter((tool) => !tool.readOnly).length,
                unannotated: list.filter((tool) => !tool.annotated).length,
              },
            ]
          }),
        ),
        undefined,
        Object.fromEntries(
          Object.entries(unlocked().vault.secrets).map(([name, { hosts, env }]) => [name, { hosts, env }]),
        ),
        jump.setup(c.req.query('sshError')),
      ),
    ),
  )
  admin.get('/live', (c) => c.json(livePanels(view(), groups, unlocked().vault.secrets)))
  const fields = async (c: Context) => await c.req.parseBody({ all: true })
  const redirect = (c: Context) => c.redirect('/admin', 303)
  admin.post('/services/save', async (c) => {
    const input = z
      .object({
        id: idSchema,
        baseUrl: urlSchema,
        authType: z.enum(['none', 'bearer', 'header', 'basic', 'path']),
        headerName: z.string().optional(),
        secret: z.string().optional(),
        notes: z.string().optional(),
        read: serviceSchema.shape.read,
        write: serviceSchema.shape.write,
        readPaths: z.string().optional(),
        mcp: z.literal('on').optional(),
      })
      .parse(await fields(c))
    const readPaths = (input.readPaths ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const service = serviceSchema.parse({
      baseUrl: input.baseUrl,
      notes: input.notes?.trim() || undefined,
      auth: { type: input.authType, secret: input.id, headerName: input.headerName },
      read: input.read,
      write: input.write,
      readPaths: readPaths.length ? readPaths : undefined,
      mcp: input.mcp ? true : undefined,
    })
    if (input.secret) {
      if (/[\r\n]/.test(input.secret)) throw new HTTPException(400, { message: 'Credential must be a single line' })
      if (input.authType === 'path' && !/^[A-Za-z0-9._~-]+$/.test(input.secret))
        throw new HTTPException(400, { message: 'A path credential must be one URL path segment' })
      secrets.set(input.id, input.secret)
      await persistServiceKeys()
    }
    if (input.authType === 'none' && secrets.delete(input.id)) await persistServiceKeys()
    services[input.id] = service
    mcpTools.delete(input.id)
    await save(servicesFile, services)
    audit('service_saved', { service: input.id })
    return c.redirect('/admin?section=services', 303)
  })
  // Lists an MCP service's tools now, so the editor shows how they classify (read-only vs write).
  admin.post('/services/tools', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!services[id]?.mcp) throw new HTTPException(404, { message: 'Not an MCP service' })
    const ok = await listMcpTools(id).then(
      () => true,
      () => false,
    )
    return c.redirect(`/admin?section=services&service=${id}${ok ? '' : '&error=tools'}`, 303)
  })
  admin.post('/services/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(services, id)) throw new HTTPException(404, { message: 'Unknown service' })
    delete services[id]
    secrets.delete(id)
    await save(servicesFile, services)
    await persistServiceKeys()
    revokeGrants((grant) => grant.item.startsWith(`${id}.`))
    for (const [key, request] of requests)
      if (request.items.some((item) => item.startsWith(`${id}.`))) requests.delete(key)
    audit('service_deleted', { service: id })
    return c.redirect('/admin?section=services', 303)
  })
  // Secrets agents may use without seeing them (inserted by the secrets proxy of a later phase). A blank value keeps
  // the stored one.
  admin.post('/secrets/save', async (c) => {
    const input = ownerSecretSchema.parse(await fields(c))
    const { vault } = unlocked()
    const value = input.value || vault.secrets[input.name]?.value
    if (!value) throw new HTTPException(400, { message: 'A new secret needs a value' })
    vault.secrets[input.name] = { value, hosts: input.hosts, env: input.env }
    await unlocked().save()
    audit('secret_saved', { secret: input.name })
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/secrets/delete', async (c) => {
    const { name } = ownerSecretSchema.pick({ name: true }).parse(await fields(c))
    const { vault } = unlocked()
    if (!Object.hasOwn(vault.secrets, name)) throw new HTTPException(404, { message: 'Unknown secret' })
    delete vault.secrets[name]
    await unlocked().save()
    audit('secret_deleted', { secret: name })
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/password', async (c) => {
    const { current, ...next } = z
      .object({ current: z.string() })
      .and(newPasswordSchema)
      .parse(await fields(c))
    try {
      await openStore(storeFile, current)
    } catch (error) {
      if (error instanceof WrongPassword) throw new HTTPException(400, { message: 'The current password is wrong' })
      throw error
    }
    await unlocked().setPassword(next.password)
    audit('owner_password_changed')
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/groups/save', async (c) => {
    const back = (error: string) => c.redirect(`/admin?section=groups&error=${error}`, 303)
    const form = await fields(c)
    const input = z.object({ id: idSchema, items: z.string() }).safeParse(form)
    if (!input.success) return back('id')
    const description = groupDescriptionSchema.safeParse(form.description ?? '')
    if (!description.success) return back('description')
    const lines = input.data.items
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (!lines.length) return back('empty')
    const parsed = groupItemsSchema.safeParse(lines)
    if (!parsed.success) return back('line')
    groups[input.data.id] = { ...(description.data ? { description: description.data } : {}), items: parsed.data }
    await save(groupsFile, groups)
    audit('group_saved', { group: input.data.id })
    return c.redirect('/admin?section=groups', 303)
  })
  admin.post('/groups/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(groups, id)) throw new HTTPException(404, { message: 'Unknown group' })
    delete groups[id]
    await save(groupsFile, groups)
    audit('group_deleted', { group: id })
    return c.redirect('/admin?section=groups', 303)
  })
  const hostById = (id: string) => {
    const host = hosts.get(id)
    if (!host) throw new HTTPException(404, { message: 'Unknown sandbox host' })
    return host
  }
  admin.post('/hosts/:id/approve', async (c) => {
    const host = hostById(c.req.param('id'))
    host.status = transition('host', hostTable, host.status, 'approve')
    audit('host_approved', { host: host.id })
    await saveHosts()
    return redirect(c)
  })
  // Removing a host (pending or approved) also ends its agents; its tokens stop working.
  admin.post('/hosts/:id/remove', async (c) => {
    const host = hostById(c.req.param('id'))
    for (const agent of [...agents.values()]) if (agent.host === host.id) endAgent(agent.id)
    sockets.get(host.id)?.close(1008, 'removed')
    hosts.delete(host.id)
    audit('host_removed', { host: host.id })
    await saveHosts()
    return redirect(c)
  })
  function endAgent(id: string) {
    const agent = agents.get(id)
    if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
    revoked.add(agent.tokenHash)
    agents.delete(id)
    revokeGrants((grant) => grant.agentId === id)
    for (const [key, request] of requests) if (request.agentId === id) requests.delete(key)
    audit('agent_revoked', { agent: id, label: agent.label })
  }
  admin.post('/agents/:id/revoke', (c) => {
    endAgent(c.req.param('id'))
    return redirect(c)
  })
  // Extending moves the end to max(current end, now) + the span the owner originally granted.
  admin.post('/grants/extend', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    const grant = grants.get(id)
    if (!grant) throw new HTTPException(404, { message: 'Grant not found' })
    if (grant.expiresAt === null || grant.grantedMs === undefined)
      throw new HTTPException(409, { message: 'Nothing to extend' })
    const end = Math.max(Date.parse(grant.expiresAt), Date.now()) + grant.grantedMs
    grant.expiresAt = new Date(end).toISOString()
    for (const request of requests.values())
      if (request.grantIds.includes(id) && (request.expiresAt ?? 0) < end) request.expiresAt = end
    push()
    audit('grant_extended', { grant: id, agent: grant.agentId, expiresAt: grant.expiresAt })
    return redirect(c)
  })
  admin.post('/requests/:id/approve', async (c) => {
    const { duration, items, shown } = decisionSchema.parse(await fields(c))
    await decide(c.req.param('id'), items, shown, duration)
    return redirect(c)
  })
  admin.post('/requests/:id/deny', async (c) => {
    const { shown } = decisionSchema.pick({ shown: true }).parse(await fields(c))
    await decide(c.req.param('id'), [], shown, '2h')
    return redirect(c)
  })
  admin.post('/grants/revoke', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!grants.has(id)) throw new HTTPException(404, { message: 'Grant not found' })
    revokeGrants((grant) => grant.id === id)
    return redirect(c)
  })
  // Targets, shares and open sessions; a target or share that goes takes its grants with it.
  jump.routes(admin, fields, () =>
    revokeGrants(
      (grant) => /^(ssh|folder):/.test(grant.item) && jump.unavailable(grant.agentId, grant.item) !== undefined,
    ),
  )
  admin.all('*', (c) => c.json({ error: 'admin_route_not_found' }, 404))
  app.route('/admin', admin)

  app.use('*', locked, auth)
  app.get(
    '/_speaker/hosts/ws',
    async (c, next) => {
      hostCaller(c)
      await next()
    },
    upgradeWebSocket((c) => {
      const id = hostCaller(c).id
      return {
        onOpen: (_event, ws) => {
          sockets.get(id)?.close(1000, 'replaced')
          sockets.set(id, ws)
          applied.delete(id)
          hostShares.delete(id)
          ws.send(JSON.stringify(snapshot(id)))
        },
        onMessage: (event, ws) => {
          if (sockets.get(id) !== ws) return
          const message = z
            .discriminatedUnion('type', [
              z.object({ type: z.literal('applied'), grantIds: z.array(z.string()) }),
              z.object({
                type: z.literal('shares'),
                shares: z.array(z.object({ name: idSchema, mount: z.boolean() })),
              }),
            ])
            .parse(JSON.parse(String(event.data)))
          if (message.type === 'shares') {
            hostShares.set(id, message.shares)
            audit('host_shares', { host: id, shares: message.shares })
          } else applied.set(id, new Set(message.grantIds))
        },
        onClose: (_event, ws) => {
          if (sockets.get(id) !== ws) return
          sockets.delete(id)
          applied.delete(id)
          hostShares.delete(id)
        },
      }
    }),
  )
  app.post('/_speaker/hosts/agents', async (c) => {
    const host = hostCaller(c)
    const identity = identitySchema.parse(await c.req.json())
    const token = randomBytes(32).toString('base64url')
    // The agent's token works only from the sandbox host's address, so a token leaked from a VM is useless elsewhere.
    const agent: Agent = {
      id: rid(),
      tokenHash: hash(token),
      ...identity,
      source: sourceOf(c),
      host: host.id,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      uses: 0,
      lastUsedAt: null,
    }
    agents.set(agent.id, agent)
    audit('agent_created', { agent: agent.id, host: host.id })
    return c.json({ id: agent.id, token }, 201)
  })
  app.delete('/_speaker/hosts/agents/:id', (c) => {
    const id = c.req.param('id')
    if (agents.get(id)?.host !== hostCaller(c).id) throw invalid('Agent not found', undefined, 404)
    endAgent(id)
    return c.json({ ok: true })
  })
  // Per secret grant, everything the agent needs to use it through the proxy (the value is never shown).
  const secretsView = (c: Context, agent: Agent) => {
    const base = baseOf(c),
      ca = '$HOME/.local/state/speaker/ca.pem'
    return Object.fromEntries(
      secretGrants(agent.id).map(({ name, env, placeholder, hosts, until }) => [
        name,
        agent.host
          ? {
              until,
              hosts,
              placeholder,
              environment: { [env]: placeholder },
              git: 'Run `gh auth setup-git` once so git takes its credentials from gh.',
              note: "Set the variable on the command that needs it (for example GH_TOKEN=... gh pr list). No proxy settings or certificate are needed: your sandbox sends requests to these hosts through speaker's proxy, which swaps the placeholder for the secret.",
            }
          : {
              until,
              hosts,
              placeholder,
              environment: {
                [env]: placeholder,
                HTTPS_PROXY: `http://agent:<token>@${new URL(base).hostname}:${config.PROXY_PORT}`,
                SSL_CERT_FILE: ca,
              },
              token: '<token> is the part after "Bearer " in your header file; do not print it',
              certificate: `Once: curl -s ${base}/_speaker/proxy/ca.pem -o "${ca}". SSL_CERT_FILE is for gh; for git set GIT_SSL_CAINFO to the same file or run git config --global http.sslCAInfo "${ca}".`,
              git: 'Run `gh auth setup-git` once so git takes its credentials from gh.',
              note: 'Set these only on the command that needs them (for example HTTPS_PROXY=... gh pr list): the proxy refuses every host except these.',
            },
      ]),
    )
  }
  // Everything an agent needs to know about where it stands. Open services, targets and shares are never listed.
  app.get('/_speaker/me', (c) => {
    const agent = agentCaller(c)
    const mine = [...grants.values()].filter((grant) => grant.agentId === agent.id && live(grant))
    const state = (id: string, write: boolean) => {
      const rule = write ? services[id].write : services[id].read
      const grant = coverFor(agent.id, id, write)
      return rule === 'never'
        ? { state: 'never' }
        : grant
          ? { state: 'granted', until: grant.expiresAt }
          : { state: 'ask' }
    }
    return c.json({
      agent: {
        id: agent.id,
        label: agent.label,
        agent: agent.agent,
        source: agent.source,
        kind: agent.host ? 'sandboxed' : 'direct',
        status: mine.length
          ? 'active'
          : [...requests.values()].some((r) => r.agentId === agent.id && r.status === 'pending')
            ? 'pending'
            : 'idle',
      },
      services: Object.fromEntries(
        Object.entries(services)
          .filter(
            ([id, service]) =>
              credentialOf(id) !== undefined && (service.read !== 'open' || coverFor(agent.id, id, false)),
          )
          .map(([id, service]) => [
            id,
            { read: state(id, false), full: state(id, true), ...(service.mcp ? { mcp: true } : {}) },
          ]),
      ),
      grants: mine.map((grant) => ({
        item: grant.item,
        expiresAt: grant.expiresAt,
        ...(grantState(grant) === 'active' ? {} : { applying: true }),
      })),
      ...(config.PROXY_PORT ? { secrets: secretsView(c, agent) } : {}),
      // Complete command lines for the agent's SSH and folder grants.
      ssh: jump.commands(agent.id, new URL(baseOf(c)).hostname.replace(/^\[|\]$/g, '')),
      // Targets and shares are never named to agents, not even inside a group: only a count shows.
      groups: Object.fromEntries(
        offered(agent).map(([name, group]) => {
          const hidden = (kind: string) => group.items.filter((item) => kindOf(item) === kind).length
          const also = [
            hidden('ssh') && plural(hidden('ssh'), 'SSH target', 'SSH targets'),
            hidden('folder') && plural(hidden('folder'), 'folder', 'folders'),
          ].filter(Boolean)
          return [
            name,
            also.length
              ? {
                  ...group,
                  items: group.items.filter((item) => !['ssh', 'folder'].includes(kindOf(item) ?? '')),
                  also: also.join(', '),
                }
              : group,
          ]
        }),
      ),
      requests: [...requests.values()]
        .filter((request) => request.agentId === agent.id)
        .map((request) => ({
          ...outcome(c, request),
          want: request.want,
          reason: request.reason,
        })),
    })
  })
  app.post('/_speaker/requests', async (c) => {
    const caller = c.get('caller')
    const input = requestSchema.extend({ agentId: idSchema.optional() }).parse(await c.req.json())
    let agent: Agent | undefined
    if (caller.role === 'host') {
      agent = input.agentId ? agents.get(input.agentId) : undefined
      if (agent?.host !== caller.host.id) throw invalid('Agent not found', undefined, 404)
    } else {
      if (input.agentId && input.agentId !== caller.agent.id) throw invalid('An agent requests only for itself')
      agent = caller.agent
    }
    const result = await ask(c, agent, input)
    return c.json(result, result.status === 'pending' ? 202 : 200)
  })
  // Notes and the caller's current state for one service.
  app.get('/_speaker/help/:name', (c) => {
    const agent = agentCaller(c)
    const name = c.req.param('name')
    if (!Object.hasOwn(services, name)) throw invalid('Unknown service', undefined, 404)
    const service = services[name]
    const until = (expiresAt: string | null) => (expiresAt === null ? 'with no end' : `until ${expiresAt} (UTC)`)
    const access = (write: boolean) => {
      const rule = write ? service.write : service.read
      if (rule === 'open') return 'open: needs no grant.'
      if (rule === 'never') return 'never granted by the owner; do not ask for it.'
      const grant = coverFor(agent.id, name, write)
      return grant
        ? `granted ${until(grant.expiresAt)}.`
        : `needs \`${name}.${write ? 'full' : 'read'}\`; not granted yet.`
    }
    const lines = [
      `# ${name}`,
      '',
      `- Call \`${baseOf(c)}/${name}/<path>\` with your header file. Speaker forwards \`<path>\` to the service's API root and adds the real credential; send no other credentials.`,
      `- Read (GET, HEAD, OPTIONS${service.readPaths?.length ? `, POST to ${service.readPaths.join(', ')}` : ''}): ${access(false)}`,
      `- Everything else (\`${name}.full\`): ${access(true)}`,
      '- Without access, add `Speaker-Wait: 60` (and `Speaker-Reason: <one sentence>`): speaker asks the owner and answers the call once decided. Without that header the call answers at once. `denied` is final.',
      ...(service.mcp
        ? [
            `- MCP server (streamable HTTP) at \`${baseOf(c)}/${name}\`. Listing tools and read-only tools count as read; other tool calls need full.`,
          ]
        : []),
      service.notes
        ? `\n${service.notes.trim()}`
        : '- No notes for this service: use the upstream API documentation for paths.',
    ]
    return c.text(`${lines.join('\n')}\n`, 200, { 'content-type': 'text/markdown; charset=utf-8' })
  })
  app.all('/_speaker/*', (c) => c.json({ error: 'invalid', message: 'Unknown route; see GET /_speaker/help' }, 404))
  app.all('*', async (c) => {
    const incoming = new URL(c.req.url),
      [serviceId, ...parts] = incoming.pathname.slice(1).split('/')
    if (!Object.hasOwn(services, serviceId))
      return c.json({ error: 'invalid', message: 'Unknown service', next: 'GET /_speaker/me' }, 404)
    const service = services[serviceId],
      agent = agentCaller(c),
      method = c.req.method,
      path = `/${parts.join('/')}`
    // MCP POST bodies are buffered (bounded) so speaker can classify them; other bodies stream through.
    let body: ReadableStream<Uint8Array> | string | null = ['GET', 'HEAD'].includes(method) ? null : c.req.raw.body
    const trimmed = (p: string) => p.replace(/\/+$/, '')
    const readPost = method === 'POST' && service.readPaths?.some((p) => trimmed(p) === trimmed(path))
    let write = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !readPost
    let detail = ''
    if (service.mcp && method === 'DELETE') write = false
    if (service.mcp && method === 'POST') {
      if (Number(c.req.header('content-length') ?? 0) > 1_048_576)
        return c.json({ error: 'invalid', message: 'MCP body too large' }, 413)
      const text = await c.req.text()
      if (Buffer.byteLength(text) > 1_048_576) return c.json({ error: 'invalid', message: 'MCP body too large' }, 413)
      body = text
      ;({ write, detail } = await mcpAccess(serviceId, text))
    }
    const item = `${serviceId}.${write ? 'full' : 'read'}`
    const rule = write ? service.write : service.read
    if (rule === 'never')
      return c.json({ error: 'denied', item, next: 'Stop: the owner blocks this; do not request it.' }, 403)
    const secret = credentialOf(serviceId)
    if (secret === undefined) return c.json({ error: 'invalid', message: 'Service has no key configured' }, 503)
    if (rule === 'ask' && !coverFor(agent.id, serviceId, write)) {
      const until = lockedUntil(agent.id, item)
      if (until !== undefined)
        return c.json(
          {
            error: 'denied',
            item,
            next: 'Stop: the owner denied this request.',
            retry_after: new Date(until).toISOString(),
          },
          403,
        )
      // A call files a request for exactly the item its method implies.
      const request = createRequest(
        agent,
        [item],
        [item],
        c.req.header('speaker-reason')?.trim().slice(0, 500) ?? '',
        '2h',
        `${method} ${detail ? `${path} · ${detail}` : path}`,
      )
      await hold(c, () => request.status !== 'pending')
      if (!coverFor(agent.id, serviceId, write)) {
        if (request.status === 'decided')
          return c.json(
            { error: 'denied', item, request: request.id, next: 'Stop: the owner denied this request.' },
            403,
          )
        return c.json(
          {
            error: 'approval_required',
            item,
            request: request.id,
            next: 'Repeat this call with Speaker-Wait: 60 (and Speaker-Reason: <one sentence>)',
            tell_user: tellUser(c, `request-${request.id}`),
          },
          403,
        )
      }
    }
    const grant = rule === 'ask' ? coverFor(agent.id, serviceId, write) : undefined
    const target = upstreamUrl(service, secret, parts, incoming.search)
    if (!target) return c.json({ error: 'invalid', message: 'Invalid service URL' }, 400)
    if (grant) useOf(grant)
    useOf(agent)
    const headers = new Headers(c.req.raw.headers)
    const hopHeaders = [
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]
    const connectionHeaders = (headers.get('connection') ?? '')
      .split(',')
      .map((header) => header.trim())
      .filter(Boolean)
    for (const name of [...headers.keys()])
      if (
        /^(authorization|cookie|host|content-length|x-forwarded-.*|x-auth-request-.*|x-speaker-.*|speaker-.*)$/i.test(
          name,
        ) ||
        hopHeaders.includes(name) ||
        connectionHeaders.includes(name)
      )
        headers.delete(name)
    headers.set('accept-encoding', 'identity')
    applyCredential(service, secret, headers)
    const start = Date.now()
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      duplex: 'half',
      redirect: 'manual',
      signal: c.req.raw.signal,
    } as RequestInit).catch((error: Error) => {
      audit('upstream_failed', { service: serviceId, error: String(error), cause: String(error.cause ?? '') })
      return undefined
    })
    audit('proxy', {
      agent: agent.id,
      service: serviceId,
      method,
      path,
      ...(detail ? { mcp: detail } : {}),
      status: upstream?.status ?? 502,
      latencyMs: Date.now() - start,
      grant: grant?.id ?? null,
      rule,
    })
    if (!upstream) return c.json({ error: 'upstream_unavailable' }, 502)
    const responseHeaders = new Headers(upstream.headers)
    for (const name of [...hopHeaders, 'content-encoding', 'content-length']) responseHeaders.delete(name)
    const location = responseHeaders.get('location')
    if (service.auth.type === 'path' && location?.includes(secret))
      responseHeaders.set('location', location.replaceAll(secret, '<redacted>'))
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  })
  const proxy = config.PROXY_PORT
    ? createProxy({
        authenticate(token, source) {
          if (!store) throw new Refusal(503, `Speaker is locked: the owner signs in at ${config.PUBLIC_URL}/admin`)
          const digest = hash(token)
          if (revoked.has(digest)) throw new Refusal(403, 'The owner revoked this agent: stop and tell the user')
          const agent = [...agents.values()].find((a) => same(a.tokenHash, digest))
          if (!agent || agent.source !== source)
            throw new Refusal(407, 'Unknown token or address: enroll again (GET /_speaker/help)')
          agent.lastSeen = Date.now()
          return { agent: agent.id }
        },
        secrets: secretGrants,
        ca: certificateAuthority,
        log: audit,
      })
    : undefined
  if (proxy) {
    proxy.listen(config.PROXY_PORT, '0.0.0.0')
    await once(proxy, 'listening')
  }
  if (hasStore)
    void notify(
      'Speaker is locked',
      'unlock',
      `Speaker restarted: sign in at ${config.PUBLIC_URL.replace(/\/$/, '')}/admin to unlock`,
    )
  return Object.assign(app, { proxy, stop: () => jump.stop() })
}

if (import.meta.main) {
  const config = (() => {
    try {
      return readConfig()
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      console.error(`speaker: fix the environment and restart:\n${z.prettifyError(error)}`)
      process.exit(1)
    }
  })()
  const app = await createApp(config)
  // Stop the jump server and ssh-agent with speaker: left running, they keep SSH_PORT and block the next start.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => void app.stop().finally(() => process.exit(0)))
  serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0', websocket: { server: wss } }, (info) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'listening', port: info.port })),
  )
}
