import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { WSContext } from 'hono/ws'
import writeFile from 'write-file-atomic'
import { z } from 'zod'
import { createJump } from './jump.ts'
import {
  type GrantEvent,
  type GrantState,
  grantTable,
  hostStates,
  type RequestEvent,
  type RequestState,
  requestTable,
  transition,
} from './lifecycle.ts'
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
export const sshKeySchema = z
  .string()
  .trim()
  .regex(
    /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]*)?$/,
    'Send one ed25519 or ECDSA public key',
  )
export const durations = { '30m': 1800_000, '1h': 3600_000, '2h': 7200_000, '1d': 86_400_000, '30d': 2_592_000_000 }
export const durationSchema = z.enum(['30m', '1h', '2h', '1d', '30d']).default('2h')
export const adminDurationSchema = z.enum([...durationSchema.unwrap().options, 'permanent']).default('2h')
// Three denials of the same item for the same agent within this window lock it: it is answered as denied, without
// asking the owner, until the window after the third denial has passed.
export const denialLimit = 3
export const denialWindow = 15 * 60_000
export const requestLifetime = 2 * 3600_000
export const agentIdleLimit = 7 * 86_400_000
// MCP JSON-RPC methods that only read or manage the protocol session; tools/call is classified per tool.
export const mcpReadMethods = new Set([
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
export const authSchema = z.discriminatedUnion('type', [
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
// Items are strings; the pattern table doubles as the list of accepted forms in error messages.
export const itemPatterns = {
  service: /^[a-zA-Z0-9_-]+\.(read|full)$/,
  site: /^site:(\*\.)?[a-zA-Z0-9.-]+$/,
  secret: /^secret:[A-Za-z0-9_]+(@[^@\s]+)?$/,
  ssh: /^ssh:[a-zA-Z0-9_-]+$/,
  folder: /^folder:[a-zA-Z0-9_-]+(:rw)?$/,
  mcp: /^mcp:[a-zA-Z0-9_-]+$/,
  ext: /^ext:[a-zA-Z0-9_-]+$/,
  group: /^group:[a-zA-Z0-9_-]+$/,
}
export const itemForms = [
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
export const kindOf = (item: string) => Object.entries(itemPatterns).find(([, pattern]) => pattern.test(item))?.[0]
export const itemSchema = z
  .string()
  .trim()
  .refine((item) => kindOf(item) !== undefined, `An item is one of: ${itemForms.join(', ')}`)
// Item kinds a sandbox host may declare it enforces.
export const hostKinds = ['secret', 'site', 'folder', 'mcp', 'ext'] as const
// SHA-256 of the empty string: what a setup that never wrote its token file sends.
export const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
export const hashSchema = z
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
export const groupsSchema = z.record(
  idSchema,
  z.object({ description: groupDescriptionSchema, items: groupItemsSchema }),
)
export const hostSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kinds: z.array(z.enum(hostKinds)).max(hostKinds.length),
  tokenHash: hashSchema,
  status: z.enum(hostStates),
})
export const reasonSchema = z.string().trim().min(1).max(500)
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
export const listSchema = z.union([z.string(), z.array(z.string())]).transform((value) => [value].flat())
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
export type Duration = z.infer<typeof adminDurationSchema>
export type Usage = { uses: number; lastUsedAt: number | null }
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

export type Caller = { role: 'host'; host: Host } | { role: 'agent'; agent: Agent }
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

export async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
export const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
export const invalid = (message: string, accepted?: string[], status: 400 | 404 = 400) =>
  new HTTPException(status, {
    res: Response.json({ error: 'invalid', message, ...(accepted ? { accepted } : {}) }, { status }),
  })

export async function createCore(config: ReturnType<typeof readConfig>) {
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
    mountable: (agentId, share) => {
      const host = agents.get(agentId)?.host
      return Boolean(host && hostShares.get(host)?.some((held) => held.name === share && held.mount))
    },
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
  // A sandbox host mounts its agents' over-SSH folders with `sshfs`, so it hears those grants; every other over-SSH
  // grant is between the agent and the relay alone.
  const snapshot = (hostId: string) => ({
    type: 'snapshot',
    version,
    grants: [...grants.values()]
      .filter(
        (grant) =>
          live(grant) &&
          agents.get(grant.agentId)?.host === hostId &&
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
  function endAgent(id: string) {
    const agent = agents.get(id)
    if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
    revoked.add(agent.tokenHash)
    agents.delete(id)
    revokeGrants((grant) => grant.agentId === id)
    for (const [key, request] of requests) if (request.agentId === id) requests.delete(key)
    audit('agent_revoked', { agent: id, label: agent.label })
  }
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
  // The first visit sets the owner password and creates the store; later sign-ins unwrap it (WrongPassword if not).
  const createOwnerStore = (password: string) =>
    serial(async () => {
      if (hasStore) throw new HTTPException(409, { message: 'The owner password is already set' })
      await unlock(await createStore(storeFile, password, await newVault()))
      hasStore = true
      // Their keys are in the store now: the plaintext files of earlier versions go.
      await rm(join(dataDir, 'secrets'), { recursive: true, force: true })
    })
  const signIn = async (password: string) => {
    const opened = await openStore(storeFile, password)
    if (!store) await unlock(opened)
  }
  const checkPassword = (password: string) => openStore(storeFile, password)
  if (hasStore)
    void notify(
      'Speaker is locked',
      'unlock',
      `Speaker restarted: sign in at ${config.PUBLIC_URL.replace(/\/$/, '')}/admin to unlock`,
    )
  return {
    config,
    skill,
    help,
    services,
    secrets,
    groups,
    hosts,
    agents,
    grants,
    requests,
    revoked,
    sockets,
    applied,
    hostShares,
    sessions,
    logged,
    mcpTools,
    jump,
    proxy,
    get store() {
      return store
    },
    get hasStore() {
      return hasStore
    },
    get version() {
      return version
    },
    unlocked,
    credentialOf,
    persistServiceKeys,
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
    revokeGrants,
    lockedUntil,
    retryAfter,
    decide,
    notify,
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
    grantState,
    view,
    endAgent,
  }
}
export type Core = Awaited<ReturnType<typeof createCore>>
