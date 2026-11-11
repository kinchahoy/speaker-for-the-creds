import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { serve, upgradeWebSocket } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { csrf } from 'hono/csrf'
import { etag } from 'hono/etag'
import { HTTPException } from 'hono/http-exception'
import { NONCE, secureHeaders } from 'hono/secure-headers'
import type { WSContext } from 'hono/ws'
import writeFile from 'write-file-atomic'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { adminPage, livePanels } from './ui.ts'

const idSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id))
const urlSchema = z.url().refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, 'Use an HTTP(S) URL without credentials, query, or fragment')
const ruleSchema = z.enum(['always', 'approval', 'deny'])
const durationSchema = z.enum(['15m', '30m', '1h', '1d', '7d', '30d', '90d']).default('15m')
const adminDurationSchema = z.enum([...durationSchema.unwrap().options, 'permanent']).default('15m')
const durations = {
  '15m': 900_000,
  '30m': 1800_000,
  '1h': 3600_000,
  '1d': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  '90d': 7_776_000_000,
}
// An agent may extend a grant itself this many times, each by at most the span the owner approved.
const autoExtensions = 3
// A denied request is answered as denied, without asking the owner again, for this long.
const deniedCooldown = durations['15m']
// An `always` policy grants a session access without a request, for at most this long after its approval.
const alwaysLimit = durations['90d']
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
const providerSchema = z.object({
  baseUrl: urlSchema,
  guide: z.string().max(20_000).optional(),
  auth: authSchema,
  policy: z.object({ read: ruleSchema, write: ruleSchema }),
  // Streamable-HTTP MCP server: POST bodies are classified by JSON-RPC method and tool annotations.
  mcp: z.boolean().optional(),
})
const kinds = ['credential', 'secret', 'site', 'folder', 'mcp', 'extension'] as const
// SHA-256 of the empty string: what a setup that never wrote its token file sends.
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const hashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'tokenHash must be 64 lowercase hex characters (SHA-256 of the token)')
  .refine((value) => value !== emptyHash, 'tokenHash is the hash of an empty token; write the token first')
const statusSchema = z.enum(['pending', 'approved', 'denied'])
const capabilitySchema = z.object({ kind: z.string(), ref: z.string().trim().min(1).max(500) })
const bundleMembersSchema = z.array(capabilitySchema.extend({ kind: z.enum(kinds) }))
const bundleDescriptionSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[^\r\n]*$/)
  .optional()
// bundles.json maps a name to `{ description, members }`; the older bare members array is still accepted.
const bundlesSchema = z.record(
  idSchema,
  z
    .union([bundleMembersSchema, z.object({ description: bundleDescriptionSchema, members: bundleMembersSchema })])
    .transform((value) => (Array.isArray(value) ? { members: value } : value)),
)
const enforcerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kinds: z.array(z.enum(kinds)).max(kinds.length),
  tokenHash: hashSchema,
  status: statusSchema,
})
const sessionSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(200),
  llmName: z.string().trim().min(1).max(120).optional(),
  harness: z.string().trim().min(1).max(120).optional(),
  tokenHash: hashSchema,
  duration: durationSchema,
  status: statusSchema,
  expiresAt: z.string().nullable(),
  approvedAt: z.string().optional(),
  // Address the session enrolled from; its token is refused from anywhere else.
  source: z.string().max(100).optional(),
  enrolledAt: z.string().optional(),
  // Span the owner approved, and how many times the agent extended it without asking.
  grantedMs: z.number().int().positive().optional(),
  extensions: z.number().int().nonnegative().optional(),
})
const requestInputSchema = z
  .object({
    capability: capabilitySchema.optional(),
    bundle: idSchema.optional(),
    reason: z.string().trim().min(1).max(500),
    duration: durationSchema,
  })
  .refine((value) => Boolean(value.capability) !== Boolean(value.bundle), 'Send either capability or bundle')
const sessionEnrollmentSchema = sessionSchema
  .pick({ label: true, tokenHash: true, duration: true, harness: true })
  .extend({ llmName: z.string().trim().min(1).max(120), request: requestInputSchema.optional() })
const subjectSchema = z.object({ id: idSchema, label: z.string(), enforcer: idSchema, tokenHash: hashSchema })
const leaseSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  kind: z.string(),
  ref: z.string(),
  expiresAt: z.string().nullable(),
  grantedMs: z.number().int().positive().optional(),
  extensions: z.number().int().nonnegative().optional(),
})
const usageSchema = z.object({
  uses: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
})
const usageStoreSchema = z.object({
  leases: z.record(idSchema, usageSchema).default({}),
  identities: z.record(idSchema, usageSchema).default({}),
})
export type Provider = z.infer<typeof providerSchema>
export type Capability = z.infer<typeof capabilitySchema>
export type Bundle = z.infer<typeof bundlesSchema>[string]
export type Enforcer = z.infer<typeof enforcerSchema>
export type Session = z.infer<typeof sessionSchema>
export type Lease = z.infer<typeof leaseSchema>
type Usage = { uses: number; lastUsedAt: number | null }
export type LeaseView = Lease & Usage & { label: string; llmName?: string; state: 'active' | 'granted' | 'waiting' }
type EnforcerView = Enforcer & Usage
type SessionView = Session & Usage
const decisionSchema = z.object({ duration: adminDurationSchema, permanent: z.literal('on').optional() })
type Duration = z.infer<typeof adminDurationSchema>
export type Pending = {
  id: string
  subjectId: string
  label: string
  llmName?: string
  harness?: string
  enforcer?: string
  members: Capability[]
  // Filed with the session's enrollment; approving the session approves it too.
  atEnrollment?: boolean
  bundle?: string
  method?: string
  path?: string
  reason: string
  duration: z.infer<typeof durationSchema>
  status: 'pending' | 'approved' | 'denied' | 'expired'
  notification: 'disabled' | 'sending' | 'sent' | 'failed'
  createdAt: number
  decidedAt?: number
}
export type View = {
  enforcers: EnforcerView[]
  sessions: SessionView[]
  requests: Pending[]
  leases: LeaseView[]
  // Providers any approved session may read without a request (shown when approving a session).
  always: string[]
}
export type LogEntry = {
  time: string
  event: string
  subject?: string
  enforcerId?: string
  label?: string
  llmName?: string
  harness?: string
  [field: string]: unknown
}
const logLimit = 5 * 1024 * 1024
type Caller = { role: 'enforcer'; enforcer: Enforcer } | { role: 'subject'; id: string; kinds: string[] }
type Env = { Variables: { caller: Caller } }
const demoSecret = 'speaker-demo-credential-not-for-real-services'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const audit = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ADMIN_USER: z.string().min(1).default('admin'),
      ADMIN_PASSWORD: z
        .string()
        .min(1)
        .refine((value) => value !== 'change-this-password', 'Set a real admin password'),
      DATA_DIR: z.string().default('./data'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      PUBLIC_URL: urlSchema.default('http://localhost:3000'),
      NTFY_URL: urlSchema.optional(),
      NTFY_TOPIC: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
      NTFY_TOKEN: z.string().optional(),
      // When on, GET /_speaker/providers answers without a token (names, auth type and policy only).
      PUBLIC_PROVIDERS: z
        .enum(['0', '1', 'false', 'true'])
        .default('0')
        .transform((value) => value === '1' || value === 'true'),
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

export async function createApp(config: ReturnType<typeof readConfig>) {
  const dataDir = resolve(config.DATA_DIR)
  const skill = await readFile(new URL('./skill/SKILL.md', import.meta.url), 'utf8')
  const helpDir = new URL('./skill/help/', import.meta.url)
  const help = new Map(
    await Promise.all(
      (await readdir(helpDir))
        .filter((name) => name.endsWith('.md'))
        .map(async (name) => [name.slice(0, -3), await readFile(new URL(name, helpDir), 'utf8')] as const),
    ),
  )
  const secretPath = (id: string) => join(dataDir, 'secrets', id)
  await mkdir(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 })
  const file = (name: string) => join(dataDir, name)
  const providersFile = file('providers.json')
  const starter = z
    .record(idSchema, providerSchema)
    .parse(JSON.parse(await readFile(new URL('./providers.example.json', import.meta.url), 'utf8')))
  starter.demo.baseUrl = `http://127.0.0.1:${config.PORT}/_demo-upstream`
  const stored = await optionalFile(providersFile),
    imported = file('.starter-providers-imported')
  const providers = stored === undefined ? starter : z.record(idSchema, providerSchema).parse(JSON.parse(stored))
  // Preserve the existing one-time starter import; never resurrect providers deleted in the UI.
  if (stored === undefined || (await optionalFile(imported)) === undefined) {
    for (const [id, provider] of Object.entries(starter)) {
      if (!Object.hasOwn(providers, id)) providers[id] = provider
    }
    await save(providersFile, providers)
    if (providers.demo && (await optionalFile(secretPath('demo'))) === undefined)
      await writeFile(secretPath('demo'), demoSecret, { mode: 0o600 })
    await writeFile(imported, 'done', { mode: 0o600 })
  }
  const loadList = async <T extends z.ZodType<{ id: string }>>(name: string, schema: T) =>
    new Map(
      z
        .array(schema)
        .parse(JSON.parse((await optionalFile(file(name))) ?? '[]'))
        .map((item) => [item.id, item as z.infer<T>]),
    )
  const saveList = (name: string, items: Map<string, unknown>) => save(file(name), [...items.values()])
  const bundles = bundlesSchema.parse(JSON.parse((await optionalFile(file('bundles.json'))) ?? '{}'))
  const enforcers = await loadList('enforcers.json', enforcerSchema)
  const sessions = await loadList('sessions.json', sessionSchema)
  const subjects = await loadList('subjects.json', subjectSchema)
  let leases = await loadList('permanent-leases.json', leaseSchema)
  const storedUsage = usageStoreSchema.parse(JSON.parse((await optionalFile(file('usage.json'))) ?? '{}'))
  const secrets = new Map(
    await Promise.all(
      Object.entries(providers).map(
        async ([id, provider]) => [id, await optionalFile(secretPath(provider.auth.secret))] as const,
      ),
    ),
  )
  const pending = new Map<string, Pending>()
  const sockets = new Map<string, WSContext>()
  const applied = new Map<string, Set<string>>()
  const leaseUsage = new Map(Object.entries(storedUsage.leases))
  const identityUsage = new Map(Object.entries(storedUsage.identities))
  const emptyUsage = (): Usage => ({ uses: 0, lastUsedAt: null })
  const useStats = (map: Map<string, Usage>, id: string) => map.get(id) ?? emptyUsage()
  let usageWrites: Promise<unknown> = Promise.resolve()
  const persistUsage = () => {
    const result = usageWrites.then(() =>
      save(file('usage.json'), {
        leases: Object.fromEntries(leaseUsage),
        identities: Object.fromEntries(identityUsage),
      }),
    )
    usageWrites = result.catch(() => {})
    return result
  }
  let version = 0
  const rid = () => randomBytes(16).toString('hex')
  const unexpired = (item: { expiresAt: string | null }) =>
    item.expiresAt === null || Date.parse(item.expiresAt) > Date.now()
  const expiry = (duration: Duration) =>
    duration === 'permanent' ? null : new Date(Date.now() + durations[duration]).toISOString()
  const liveSession = (session: Session) => session.status === 'approved' && unexpired(session)
  // Sessions approved before approvedAt existed start their `always` window now rather than never ending it.
  for (const session of sessions.values())
    if (session.status === 'approved' && !session.approvedAt) session.approvedAt = new Date().toISOString()
  // When an approved session's `always` access ends: 90 days after approval, or sooner if the session ends first.
  // Enforcer subjects (sandboxes) are bounded by their task and have no such window.
  const alwaysEnds = (callerId: string) => {
    const session = sessions.get(callerId)
    if (!session?.approvedAt) return null
    const cap = Date.parse(session.approvedAt) + alwaysLimit
    return new Date(session.expiresAt === null ? cap : Math.min(cap, Date.parse(session.expiresAt))).toISOString()
  }
  // `always` turns into `approval` once the caller's window has passed.
  const ruleFor = (provider: Provider, group: 'read' | 'write', callerId: string) => {
    const rule = provider.policy[group]
    const end = alwaysEnds(callerId)
    return rule === 'always' && end !== null && Date.parse(end) <= Date.now() ? 'approval' : rule
  }
  // The upstream URL for an agent-facing path, or undefined when it would leave the provider's base path.
  const upstreamUrl = (provider: Provider, secret: string, parts: string[], search: string) => {
    const base = new URL(provider.baseUrl),
      target = new URL(base.origin)
    const prefix = `${base.pathname.replace(/\/$/, '')}/`
    const rest = parts.join('/')
    target.pathname =
      provider.auth.type === 'path'
        ? `${prefix}${encodeURIComponent(secret)}${parts.length ? `/${rest}` : ''}`
        : prefix + rest
    target.search = search
    return target.origin === base.origin && target.pathname.startsWith(prefix) ? target : undefined
  }
  const applyCredential = (provider: Provider, secret: string, headers: Headers) => {
    if (provider.auth.type === 'path') return
    if (provider.auth.type === 'header') headers.set(provider.auth.headerName, secret)
    else
      headers.set(
        'authorization',
        provider.auth.type === 'basic' ? `Basic ${Buffer.from(secret).toString('base64')}` : `Bearer ${secret}`,
      )
  }
  type McpTool = { readOnly: boolean; destructive: boolean; annotated: boolean }
  const mcpTools = new Map<string, { at: number; tools: Map<string, McpTool> }>()
  // Lists an MCP provider's tools with speaker's own credentialed session (initialize, tools/list, close).
  async function listMcpTools(id: string) {
    const provider = providers[id],
      secret = secrets.get(id)
    if (!provider || secret === undefined) throw new Error('MCP provider or credential missing')
    const url = upstreamUrl(provider, secret, [], '')
    if (!url) throw new Error('Invalid MCP provider URL')
    let sessionId: string | undefined
    let version: string | undefined
    const rpc = async (body: { id?: number; method: string; params?: object }, method = 'POST') => {
      const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
      if (sessionId) headers.set('mcp-session-id', sessionId)
      if (version) headers.set('mcp-protocol-version', version)
      applyCredential(provider, secret, headers)
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
    audit('mcp_tools_listed', { provider: id, tools: tools.size })
    return tools
  }
  // Cached tool annotations, refreshed every 10 minutes or when an unknown tool is called (at most every 30s).
  async function mcpTool(id: string, name: string) {
    const cached = mcpTools.get(id)
    const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY
    if (age > 600_000 || (!cached?.tools.has(name) && age > 30_000))
      await listMcpTools(id).catch(() => audit('mcp_tools_failed', { provider: id }))
    return mcpTools.get(id)?.tools.get(name)
  }
  // Classifies one MCP POST body: protocol housekeeping and read-only tools are reads; anything else is a write.
  async function mcpAccess(id: string, body: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { group: 'write' as const, detail: 'unparseable MCP body' }
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
    return { group: notes.length ? ('write' as const) : ('read' as const), detail: notes.join(', ') }
  }

  const snapshot = (enforcerId: string) => ({
    type: 'snapshot',
    version,
    leases: [...leases.values()].filter((l) => unexpired(l) && subjects.get(l.subjectId)?.enforcer === enforcerId),
    requests: [...pending.values()]
      .filter((r) => subjects.get(r.subjectId)?.enforcer === enforcerId)
      .map((r) => ({
        id: r.id,
        subjectId: r.subjectId,
        status: requestStatus(r),
        what: r.bundle ? `bundle ${r.bundle}` : r.members.map((m) => `${m.kind} ${m.ref}`).join(', '),
        reason: r.reason,
      })),
  })
  const push = () => {
    for (const [id, ws] of sockets) ws.send(JSON.stringify(snapshot(id)))
  }
  setInterval(push, 10_000).unref()

  // Serialize read/modify/write operations, including approval decisions. A failed
  // write reaches its caller without poisoning subsequent operations in the queue.
  let leaseWrites: Promise<unknown> = Promise.resolve()
  function serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = leaseWrites.then(operation)
    leaseWrites = result.catch(() => {})
    return result
  }
  async function commitLeases(next: Map<string, Lease>) {
    await save(
      file('permanent-leases.json'),
      [...next.values()].filter((lease) => lease.expiresAt === null),
    )
    leases = next
    version++
    push()
  }
  const matchingLease = (subjectId: string, kind: string, ref: string) =>
    [...leases.values()].find((l) => unexpired(l) && l.subjectId === subjectId && l.kind === kind && l.ref === ref)
  const hasLease = (subjectId: string, kind: string, ref: string) => Boolean(matchingLease(subjectId, kind, ref))
  // Counts a proxied call for the caller (and its enforcer), and for the lease when one authorized it.
  // `always` calls have no lease but still count as the identity's use.
  const recordUse = async (leaseId: string | undefined, subjectId: string) => {
    const now = Date.now()
    for (const [map, id] of [
      [leaseUsage, leaseId],
      [identityUsage, subjectId],
    ] as const) {
      if (id === undefined) continue
      const previous = useStats(map, id)
      map.set(id, { uses: previous.uses + 1, lastUsedAt: now })
    }
    const enforcerId = subjects.get(subjectId)?.enforcer
    if (enforcerId) {
      const previous = useStats(identityUsage, enforcerId)
      identityUsage.set(enforcerId, { uses: previous.uses + 1, lastUsedAt: now })
    }
    await persistUsage()
  }
  // Append-only JSONL access log next to the audit stdout lines; one queue keeps lines from interleaving.
  const logPath = file('access-log.jsonl'),
    logOld = file('access-log.1.jsonl')
  let logQueue: Promise<unknown> = Promise.resolve()
  const logEvent = (event: string, subjectId: string | undefined, fields: Record<string, unknown>) => {
    const known = subjectId !== undefined && (subjects.has(subjectId) || sessions.has(subjectId))
    const who = known ? owner(subjectId) : undefined
    const line = `${JSON.stringify({
      time: new Date().toISOString(),
      event,
      subject: subjectId,
      enforcerId: subjects.get(subjectId ?? '')?.enforcer,
      label: who?.label,
      llmName: who?.llmName,
      harness: who?.harness,
      ...fields,
    })}\n`
    logQueue = logQueue
      .then(async () => {
        const size = await stat(logPath).then(
          (s) => s.size,
          () => 0,
        )
        if (size > logLimit) await rename(logPath, logOld)
        await appendFile(logPath, line, { mode: 0o600 })
      })
      .catch((error) => console.error(`access log write failed: ${error.message}`))
    return logQueue
  }
  const readLog = async (match: (entry: LogEntry) => boolean, limit = 200) => {
    await logQueue
    const found: LogEntry[] = []
    for (const path of [logPath, logOld]) {
      const text = await optionalFile(path)
      if (text === undefined) continue
      const lines = text.split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
        const entry = JSON.parse(lines[i]) as LogEntry
        if (match(entry)) found.push(entry)
      }
      if (found.length >= limit) break
    }
    return found
  }
  const removeLeases = (matches: (lease: Lease) => boolean) =>
    serial(() => commitLeases(new Map([...leases].filter(([, lease]) => !matches(lease)))))
  const owner = (subjectId: string) => {
    const subject = subjects.get(subjectId)
    if (subject)
      return {
        label: subject.label,
        llmName: undefined,
        harness: undefined,
        enforcer: enforcers.get(subject.enforcer)?.name,
      }
    const session = sessions.get(subjectId)
    if (session)
      return { label: session.label, llmName: session.llmName, harness: session.harness, enforcer: undefined }
    throw new HTTPException(404, { message: 'Unknown subject' })
  }
  const requestStatus = (request: Pending) => {
    if (request.status === 'pending' && Date.now() - request.createdAt >= durations['15m']) return 'expired'
    if (request.status === 'approved' && request.members.some((m) => !hasLease(request.subjectId, m.kind, m.ref)))
      return 'expired'
    return request.status
  }
  function leaseState(lease: Lease): LeaseView['state'] {
    const enforcerId = subjects.get(lease.subjectId)?.enforcer
    if (lease.kind === 'credential' || !enforcerId) return 'active'
    if (!sockets.has(enforcerId)) return 'waiting'
    return applied.get(enforcerId)?.has(lease.id) ? 'active' : 'granted'
  }
  const view = (): View => ({
    enforcers: [...enforcers.values()].map((enforcer) => ({ ...enforcer, ...useStats(identityUsage, enforcer.id) })),
    sessions: [...sessions.values()].map((session) => ({ ...session, ...useStats(identityUsage, session.id) })),
    requests: [...pending.values()].map((request) => ({ ...request, status: requestStatus(request) })),
    leases: [...leases.values()].filter(unexpired).map((lease) => {
      const { label, llmName } = owner(lease.subjectId)
      return { ...lease, ...useStats(leaseUsage, lease.id), label, llmName, state: leaseState(lease) }
    }),
    always: Object.entries(providers)
      .filter(([, provider]) => provider.policy.read === 'always')
      .map(([id]) => id),
  })
  function pendingRequest(id: string) {
    const request = pending.get(id)
    if (!request || requestStatus(request) !== 'pending')
      throw new HTTPException(409, { message: 'Request is no longer pending' })
    const session = sessions.get(request.subjectId)
    if (
      !(subjects.has(request.subjectId) || (session && liveSession(session))) ||
      request.members.some((m) => m.kind === 'credential' && !Object.hasOwn(providers, m.ref.split('.')[0]))
    )
      throw new HTTPException(409, { message: 'Subject or provider was removed' })
    return request
  }
  function approve(id: string, duration: Duration) {
    return serial(async () => {
      const request = pendingRequest(id)
      const expiresAt = expiry(duration)
      const next = new Map(leases)
      for (const { kind, ref } of request.members) {
        for (const [key, lease] of next)
          if (lease.subjectId === request.subjectId && lease.kind === kind && lease.ref === ref) next.delete(key)
        const lease: Lease = { id: rid(), subjectId: request.subjectId, kind, ref, expiresAt }
        if (duration !== 'permanent') lease.grantedMs = durations[duration]
        next.set(lease.id, lease)
      }
      await commitLeases(next)
      request.status = 'approved'
      audit('request_approved', { requestId: id, subject: request.subjectId, expiresAt })
      void logEvent('request_approved', request.subjectId, {
        requestId: id,
        capability: request.bundle ?? request.members,
        reason: request.reason,
        expiresAt,
      })
    })
  }
  function deny(id: string) {
    return serial(() => {
      const request = pendingRequest(id)
      request.status = 'denied'
      request.decidedAt = Date.now()
      audit('request_denied', { requestId: id, subject: request.subjectId })
      void logEvent('request_denied', request.subjectId, {
        requestId: id,
        capability: request.bundle ?? request.members,
        reason: request.reason,
      })
      push()
    })
  }
  async function deleteSubject(id: string) {
    subjects.delete(id)
    await saveList('subjects.json', subjects)
    await removeLeases((lease) => lease.subjectId === id)
    for (const [key, request] of pending) if (request.subjectId === id) pending.delete(key)
    audit('subject_deleted', { subject: id })
  }
  async function notify(title: string, anchor: string): Promise<'disabled' | 'sent' | 'failed'> {
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
          message: 'Open the approval page to decide.',
          click: `${config.PUBLIC_URL.replace(/\/$/, '')}/admin#${anchor}`,
        }),
      })
      if (!response.ok) throw new Error('Notification rejected')
      await response.body?.cancel()
      return 'sent'
    } catch {
      audit('notification_failed', { anchor })
      return 'failed'
    }
  }
  // Create a request, or return the identical pending one (adding the agent's reason when it supplies one).
  function createRequest(
    subjectId: string,
    members: Capability[],
    bundle: string | undefined,
    reason: string,
    duration: Pending['duration'],
    method?: string,
    path?: string,
  ) {
    for (const [id, request] of pending) if (requestStatus(request) === 'expired') pending.delete(id)
    const matches = (r: Pending) =>
      r.subjectId === subjectId && r.bundle === bundle && JSON.stringify(r.members) === JSON.stringify(members)
    // A recent denial stands: answer with it instead of asking the owner again.
    const denied = [...pending.values()].find(
      (r) => matches(r) && r.status === 'denied' && Date.now() - (r.decidedAt ?? r.createdAt) < deniedCooldown,
    )
    if (denied) return denied
    const existing = [...pending.values()].find((r) => matches(r) && r.status === 'pending')
    if (existing) {
      if (reason) Object.assign(existing, { reason, duration })
      return existing
    }
    const request: Pending = {
      id: rid(),
      subjectId,
      ...owner(subjectId),
      members,
      bundle,
      method,
      path,
      reason,
      duration,
      status: 'pending',
      notification: config.NTFY_URL ? 'sending' : 'disabled',
      createdAt: Date.now(),
    }
    pending.set(request.id, request)
    push()
    audit('request_created', { requestId: request.id, subject: subjectId, members })
    void logEvent('request_created', subjectId, {
      requestId: request.id,
      capability: bundle ?? members,
      reason,
    })
    void notify(
      `${request.label} requests ${bundle ?? members.map((m) => m.ref).join(', ')}`,
      `request-${request.id}`,
    ).then((state) => {
      request.notification = state
    })
    return request
  }

  const app = new Hono<Env>()
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // Agent routes answer in JSON; admin pages keep their plain-text messages.
      if (error.res || c.req.path.startsWith('/admin')) return error.getResponse()
      return c.json({ error: error.message || 'request_failed' }, error.status)
    }
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: 'invalid_request',
          fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
        400,
      )
    if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
    audit('request_failed', { type: error.name })
    return c.json({ error: 'internal_error' }, 500)
  })

  const base = config.PUBLIC_URL.replace(/\/$/, '')
  const tellUser = (anchor: string) => `Ask the owner to approve at ${base}/admin#${anchor}`
  // The caller's address: the first X-Forwarded-For hop (speaker runs behind the owner's reverse proxy), else the socket.
  const sourceOf = (c: Context) =>
    (c.req.header('x-forwarded-for')?.split(',')[0].trim() || getConnInfo(c).remote.address || 'unknown').replace(
      /^::ffff:/,
      '',
    )
  // Every agent-facing 401 names its cause and the next step, and points at the skill.
  const unauthorized = (c: Context, error: string, fields: Record<string, string>) => {
    c.header('www-authenticate', 'Bearer realm="speaker"')
    c.header('link', '</skill.md>; rel="help"')
    return c.json({ error, ...fields, help: '/skill.md' }, 401)
  }
  const enroll = 'Enroll a new session with a new token: GET /_speaker/help/setup'
  // Resolves a bearer token to an enforcer, a live session, or a subject of an approved enforcer.
  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const token = /^Bearer +(\S+) *$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) return unauthorized(c, 'unauthorized', { next: 'Send Authorization: Bearer <token>. ' + enroll })
    const digest = hash(token)
    const byToken = <T extends { tokenHash: string }>(items: Map<string, T>) =>
      [...items.values()].find((item) => same(item.tokenHash, digest))
    const enforcer = byToken(enforcers),
      session = byToken(sessions),
      subject = byToken(subjects)
    const parent = subject && enforcers.get(subject.enforcer)
    if (enforcer?.status === 'approved') c.set('caller', { role: 'enforcer', enforcer })
    else if (session) {
      if (session.source && session.source !== sourceOf(c))
        return unauthorized(c, 'source_mismatch', { next: `This token works only from ${session.source}. ${enroll}` })
      if (session.status === 'pending')
        return unauthorized(c, 'session_pending', {
          next: `GET /_speaker/sessions/${session.id}?wait=60`,
          tell_user: tellUser(`session-${session.id}`),
        })
      if (session.status === 'denied')
        return unauthorized(c, 'session_denied', { next: 'Stop: the owner denied this session.' })
      if (!liveSession(session)) return unauthorized(c, 'session_expired', { next: enroll })
      c.set('caller', { role: 'subject', id: session.id, kinds: ['credential'] })
    } else if (subject && parent?.status === 'approved')
      c.set('caller', { role: 'subject', id: subject.id, kinds: ['credential', ...parent.kinds] })
    else if (enforcer?.status === 'pending')
      return unauthorized(c, 'enforcer_pending', { tell_user: tellUser(`enforcer-${enforcer.id}`) })
    else return unauthorized(c, 'unknown_token', { next: enroll })
    await next()
  }
  const enforcerOf = (c: Context<Env>) => {
    const caller = c.get('caller')
    if (caller.role !== 'enforcer') throw new HTTPException(403, { message: 'Enforcer token required' })
    return caller.enforcer
  }
  const subjectOf = (c: Context<Env>) => {
    const caller = c.get('caller')
    if (caller.role !== 'subject') throw new HTTPException(403, { message: 'Session or subject token required' })
    return caller
  }

  app.get('/_speaker/health', (c) => c.json({ ok: true }))
  // Public discovery: what speaker is and where the instructions are. Providers and policies stay behind auth.
  const markdown = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'max-age=3600' }
  app.use('/skill.md', etag())
  app.use('/SKILL.md', etag())
  app.use('/_speaker/help/*', etag())
  for (const route of ['/skill.md', '/SKILL.md']) app.get(route, (c) => c.text(skill, 200, markdown))
  app.get('/_speaker/help/:topic', (c) => {
    const text = help.get(c.req.param('topic'))
    if (text === undefined)
      return c.json({ error: 'unknown_help_topic', topics: [...help.keys()].map((t) => `/_speaker/help/${t}`) }, 404)
    return c.text(text, 200, markdown)
  })
  const intro = [
    'speaker: owner-approved access to homelab APIs. Agents never get upstream keys.',
    'agents: read /skill.md. More: /_speaker/help/<topic>',
    'humans: /admin',
    '',
  ].join('\n')
  app.get('/', (c) =>
    c.req.header('accept')?.includes('text/html')
      ? c.html(
          '<!doctype html><meta charset="utf-8"><title>Speaker</title><p>Speaker gives AI agents owner-approved access to homelab APIs; agents never see the keys.</p><p>Owner: approve requests at <a href="/admin">/admin</a>.</p><p>Agents: <a href="/skill.md">/skill.md</a>.</p>',
        )
      : c.text(intro),
  )
  app.get('/llms.txt', (c) => c.text(intro))
  app.get('/.well-known/speaker.json', (c) =>
    c.json({ version: 2, skill: '/skill.md', help: '/_speaker/help/<topic>', auth: 'bearer', admin: '/admin' }),
  )
  // Holds a call for up to `?wait=` seconds (or `seconds`; max 60) until `settled` turns true, so agents poll once.
  const settle = async (c: Context<Env>, settled: () => boolean, seconds = Number(c.req.query('wait'))) => {
    const until = Date.now() + Math.min(seconds || 0, 60) * 1000
    while (!settled() && Date.now() < until && !c.req.raw.signal.aborted) await sleep(500)
  }
  // Resolves a capability or bundle request body to its members, refusing kinds the caller may not request.
  const membersFor = (input: z.infer<typeof requestInputSchema>, allowedKinds: string[]) => {
    const members = input.bundle ? bundles[input.bundle]?.members : input.capability ? [input.capability] : undefined
    if (!members) throw new HTTPException(404, { message: 'Unknown bundle' })
    for (const { kind, ref } of members) {
      if (!allowedKinds.includes(kind))
        throw new HTTPException(400, { res: Response.json({ error: 'unsupported_kind', kind }, { status: 400 }) })
      if (kind === 'credential' && !/^[a-zA-Z0-9_-]+\.(read|write)$/.test(ref))
        throw new HTTPException(400, { message: 'Credential ref must be <provider>.read or <provider>.write' })
      if (kind === 'credential' && !Object.hasOwn(providers, ref.split('.')[0]))
        throw new HTTPException(400, { message: 'Unknown provider' })
      if (kind === 'credential' && secrets.get(ref.split('.')[0]) === undefined)
        throw new HTTPException(400, { message: 'provider_not_configured' })
    }
    return members
  }
  // Agents see only providers that have a key; the rest cannot serve a call.
  const providerList = () =>
    Object.fromEntries(
      Object.entries(providers)
        .filter(([id]) => secrets.get(id) !== undefined)
        .map(([id, provider]) => [id, { policy: provider.policy, ...(provider.mcp ? { mcp: true } : {}) }]),
    )
  if (config.PUBLIC_PROVIDERS) app.get('/_speaker/providers', (c) => c.json(providerList()))
  app.get(
    '/_speaker/enforcers/ws',
    auth,
    async (c, next) => {
      enforcerOf(c)
      await next()
    },
    upgradeWebSocket((c) => {
      const id = enforcerOf(c).id
      return {
        onOpen: (_event, ws) => {
          sockets.get(id)?.close(1000, 'replaced')
          sockets.set(id, ws)
          applied.delete(id)
          ws.send(JSON.stringify(snapshot(id)))
        },
        onMessage: (event, ws) => {
          if (sockets.get(id) !== ws) return
          const message = z
            .object({ type: z.literal('applied'), leaseIds: z.array(z.string()) })
            .parse(JSON.parse(String(event.data)))
          applied.set(id, new Set(message.leaseIds))
        },
        onClose: (_event, ws) => {
          if (sockets.get(id) !== ws) return
          sockets.delete(id)
          applied.delete(id)
        },
      }
    }),
  )
  app.post('/_speaker/enforcers', async (c) => {
    const input = enforcerSchema.pick({ name: true, kinds: true, tokenHash: true }).parse(await c.req.json())
    const enforcer: Enforcer = { id: rid(), ...input, status: 'pending' }
    enforcers.set(enforcer.id, enforcer)
    await saveList('enforcers.json', enforcers)
    audit('enforcer_registered', { enforcer: enforcer.id, name: enforcer.name })
    void notify(`Enforcer ${enforcer.name} wants to register`, `enforcer-${enforcer.id}`)
    return c.json({ id: enforcer.id, status: enforcer.status }, 201)
  })
  app.post('/_speaker/sessions', async (c) => {
    const { request: wanted, ...input } = sessionEnrollmentSchema.parse(await c.req.json())
    // Validate the optional first request before storing anything; a session may request credentials only.
    const members = wanted ? membersFor(wanted, ['credential']) : undefined
    if ([...sessions.values()].some((s) => s.tokenHash === input.tokenHash))
      throw new HTTPException(409, { message: 'token_in_use: make a new token for a new session' })
    const session: Session = {
      id: rid(),
      ...input,
      status: 'pending',
      expiresAt: null,
      source: sourceOf(c),
      enrolledAt: new Date().toISOString(),
    }
    sessions.set(session.id, session)
    await saveList('sessions.json', sessions)
    audit('session_enrolled', { session: session.id, label: session.label, llmName: session.llmName })
    const request =
      wanted && members ? createRequest(session.id, members, wanted.bundle, wanted.reason, wanted.duration) : undefined
    if (request) request.atEnrollment = true
    else void notify(`Session "${session.label}" (${session.llmName}) wants access`, `session-${session.id}`)
    return c.json(
      {
        id: session.id,
        ...(request ? { requestId: request.id } : {}),
        next: `GET /_speaker/sessions/${session.id}?wait=60`,
        tell_user: tellUser(`session-${session.id}`),
      },
      201,
    )
  })
  app.get('/_speaker/sessions/:id', async (c) => {
    const session = sessions.get(c.req.param('id'))
    if (!session) throw new HTTPException(404, { message: 'Session not found' })
    await settle(c, () => session.status !== 'pending')
    return c.json({ status: session.status, expiresAt: session.expiresAt })
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
  admin.use('*', basicAuth({ username: config.ADMIN_USER, password: config.ADMIN_PASSWORD, realm: 'Speaker' }))
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
  // Newest entries first, optionally narrowed to one lease, identity (session, subject or enforcer) or provider.
  admin.get('/log', async (c) => {
    const { lease, identity, provider } = c.req.query()
    const members = (entry: LogEntry) => (Array.isArray(entry.capability) ? (entry.capability as Capability[]) : [])
    const entries = await readLog(
      (e) =>
        (!lease || e.leaseId === lease) &&
        (!identity || e.subject === identity || e.enforcerId === identity) &&
        (!provider ||
          e.provider === provider ||
          members(e).some((m) => m.kind === 'credential' && m.ref.startsWith(`${provider}.`))),
    )
    return c.html(
      adminPage(
        providers,
        secrets,
        view(),
        undefined,
        c.get('secureHeadersNonce'),
        'log',
        bundles,
        undefined,
        {},
        {
          entries,
          filter: lease ? `lease ${lease}` : identity ? `identity ${identity}` : provider ? `provider ${provider}` : '',
        },
      ),
    )
  })
  admin.get('/', (c) =>
    c.html(
      adminPage(
        providers,
        secrets,
        view(),
        c.req.query('provider'),
        c.get('secureHeadersNonce'),
        c.req.query('section'),
        bundles,
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
      ),
    ),
  )
  admin.get('/live', (c) => c.json(livePanels(view())))
  const fields = async (c: Context) => await c.req.parseBody()
  const redirect = (c: Context) => c.redirect('/admin', 303)
  admin.post('/providers/save', async (c) => {
    const input = z
      .object({
        id: idSchema,
        baseUrl: urlSchema,
        authType: z.enum(['bearer', 'header', 'basic', 'path']),
        headerName: z.string().optional(),
        secret: z.string().optional(),
        guide: z.string().optional(),
        read: ruleSchema,
        write: ruleSchema,
        mcp: z.literal('on').optional(),
      })
      .parse(await fields(c))
    const provider = providerSchema.parse({
      baseUrl: input.baseUrl,
      guide: input.guide?.trim() || undefined,
      auth: { type: input.authType, secret: input.id, headerName: input.headerName },
      policy: { read: input.read, write: input.write },
      mcp: input.mcp ? true : undefined,
    })
    if (input.secret) {
      if (/[\r\n]/.test(input.secret)) throw new HTTPException(400, { message: 'Credential must be a single line' })
      if (input.authType === 'path' && !/^[A-Za-z0-9._~-]+$/.test(input.secret))
        throw new HTTPException(400, { message: 'A path credential must be one URL path segment' })
      await writeFile(secretPath(input.id), input.secret, { mode: 0o600 })
      secrets.set(input.id, input.secret)
    }
    providers[input.id] = provider
    mcpTools.delete(input.id)
    await save(providersFile, providers)
    audit('provider_saved', { provider: input.id })
    return c.redirect('/admin?section=providers', 303)
  })
  // Lists an MCP provider's tools now, so the editor shows how they classify (read-only vs write).
  admin.post('/providers/tools', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!providers[id]?.mcp) throw new HTTPException(404, { message: 'Not an MCP provider' })
    const ok = await listMcpTools(id).then(
      () => true,
      () => false,
    )
    return c.redirect(`/admin?section=providers&provider=${id}${ok ? '' : '&error=tools'}`, 303)
  })
  admin.post('/providers/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(providers, id)) throw new HTTPException(404, { message: 'Unknown provider' })
    const secret = providers[id].auth.secret
    delete providers[id]
    secrets.delete(id)
    await save(providersFile, providers)
    await rm(secretPath(secret), { force: true })
    await removeLeases((lease) => lease.kind === 'credential' && lease.ref.startsWith(`${id}.`))
    for (const [key, request] of pending)
      if (request.members.some((m) => m.kind === 'credential' && m.ref.startsWith(`${id}.`))) pending.delete(key)
    audit('provider_deleted', { provider: id })
    return c.redirect('/admin?section=providers', 303)
  })
  const bundleFile = file('bundles.json')
  admin.post('/bundles/save', async (c) => {
    const back = (error: string) => c.redirect(`/admin?section=bundles&error=${error}`, 303)
    const form = await fields(c)
    const input = z.object({ id: idSchema, members: z.string() }).safeParse(form)
    if (!input.success) return back('id')
    const description = bundleDescriptionSchema.safeParse(form.description ?? '')
    if (!description.success) return back('description')
    const lines = input.data.members
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const parsed = bundleMembersSchema.safeParse(
      lines.map((line) => ({ kind: line.split(/\s+/)[0], ref: line.replace(/^\S+\s*/, '') })),
    )
    if (!lines.length) return back('empty')
    if (!parsed.success) return back('line')
    bundles[input.data.id] = { ...(description.data ? { description: description.data } : {}), members: parsed.data }
    await save(bundleFile, bundles)
    audit('bundle_saved', { bundle: input.data.id })
    return c.redirect('/admin?section=bundles', 303)
  })
  admin.post('/bundles/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(bundles, id)) throw new HTTPException(404, { message: 'Unknown bundle' })
    delete bundles[id]
    await save(bundleFile, bundles)
    audit('bundle_deleted', { bundle: id })
    return c.redirect('/admin?section=bundles', 303)
  })
  const pendingIdentity = <T extends { status: string }>(store: Map<string, T>, id: string) => {
    const item = store.get(id)
    if (item?.status !== 'pending') throw new HTTPException(409, { message: 'Not pending' })
    return item
  }
  admin.post('/enforcers/:id/approve', async (c) => {
    pendingIdentity(enforcers, c.req.param('id')).status = 'approved'
    await saveList('enforcers.json', enforcers)
    return redirect(c)
  })
  // Deny works on pending and approved enforcers; a denied enforcer's subjects stop authenticating.
  admin.post('/enforcers/:id/deny', async (c) => {
    const enforcer = enforcers.get(c.req.param('id'))
    if (!enforcer) throw new HTTPException(404, { message: 'Unknown enforcer' })
    enforcer.status = 'denied'
    sockets.get(enforcer.id)?.close(1008, 'denied')
    await saveList('enforcers.json', enforcers)
    audit('enforcer_denied', { enforcer: enforcer.id })
    return redirect(c)
  })
  admin.post('/sessions/:id/approve', async (c) => {
    const { duration, permanent } = decisionSchema.parse(await fields(c))
    const session = pendingIdentity(sessions, c.req.param('id'))
    session.status = 'approved'
    session.expiresAt = expiry(permanent ? 'permanent' : duration)
    session.approvedAt = new Date().toISOString()
    session.grantedMs = permanent || duration === 'permanent' ? undefined : durations[duration]
    await saveList('sessions.json', sessions)
    // The session card showed its first request; approving the session grants that too, for the duration asked.
    for (const request of [...pending.values()])
      if (request.subjectId === session.id && request.atEnrollment && requestStatus(request) === 'pending')
        await approve(request.id, request.duration)
    return redirect(c)
  })
  admin.post('/sessions/:id/deny', async (c) => {
    const session = sessions.get(c.req.param('id'))
    if (!session) throw new HTTPException(404, { message: 'Unknown session' })
    session.status = 'denied'
    await saveList('sessions.json', sessions)
    await removeLeases((lease) => lease.subjectId === session.id)
    for (const [key, request] of pending) if (request.subjectId === session.id) pending.delete(key)
    audit('session_denied', { session: session.id })
    return redirect(c)
  })
  // Browser forms and JSON clients share exactly the same approval/revocation implementation.
  for (const api of [false, true]) {
    const prefix = api ? '/api' : ''
    const body = (c: Context) => (api ? c.req.json() : fields(c))
    admin.post(`${prefix}/requests/:id/approve`, async (c) => {
      const { duration, permanent } = decisionSchema.parse(await body(c))
      await approve(c.req.param('id'), permanent ? 'permanent' : duration)
      return api ? c.json({ ok: true }) : redirect(c)
    })
    admin.post(`${prefix}/requests/:id/deny`, async (c) => {
      await deny(c.req.param('id'))
      return api ? c.json({ ok: true }) : redirect(c)
    })
    admin.post(api ? '/api/leases/:id/revoke' : '/leases/revoke', async (c) => {
      const id = api ? c.req.param('id') : z.object({ id: idSchema }).parse(await fields(c)).id
      const revoked = leases.get(id)
      await removeLeases((lease) => lease.id === id)
      audit('lease_revoked', { leaseId: id })
      void logEvent('lease_revoked', revoked?.subjectId, {
        leaseId: id,
        capability: revoked && [{ kind: revoked.kind, ref: revoked.ref }],
      })
      return api ? c.json({ ok: true }) : redirect(c)
    })
  }
  admin.get('/api/requests', (c) => c.json(view().requests))
  admin.get('/api/leases', (c) => c.json(view().leases))
  admin.all('*', (c) => c.json({ error: 'admin_route_not_found' }, 404))
  app.route('/admin', admin)

  app.use('*', auth)
  app.get('/_speaker/providers', (c) => {
    subjectOf(c)
    return c.json(providerList())
  })
  // Every provider gets a short generated guide for this caller (policy, lease and session expiry in UTC),
  // followed by the owner's provider-specific guide when one is configured.
  app.get('/_speaker/providers/:name/guide', (c) => {
    const caller = subjectOf(c)
    const name = c.req.param('name')
    if (!Object.hasOwn(providers, name)) throw new HTTPException(404, { message: 'Unknown provider' })
    const provider = providers[name]
    const until = (expiresAt: string | null) => (expiresAt === null ? 'with no expiry' : `until ${expiresAt} (UTC)`)
    const access = (group: 'read' | 'write') => {
      const rule = ruleFor(provider, group, caller.id)
      if (rule === 'always') {
        const end = alwaysEnds(caller.id)
        return `allowed without a request${end === null ? '' : ` until ${end} (UTC)`}.`
      }
      if (rule === 'deny') return 'denied by the owner; do not request it.'
      const lease = matchingLease(caller.id, 'credential', `${name}.${group}`)
      return lease ? `approved ${until(lease.expiresAt)}.` : `needs \`credential ${name}.${group}\`; not approved yet.`
    }
    const session = sessions.get(caller.id)
    const lines = [
      `# ${name}`,
      '',
      `- Call \`$SPEAKER_URL/${name}/<path>\` with \`Authorization: Bearer <your speaker token>\`. Speaker forwards \`<path>\` to the provider's API root and adds the real credential; send no other credentials.`,
      `- Read (GET, HEAD, OPTIONS): ${access('read')}`,
      `- Write (other methods): ${access('write')}`,
      ...(session ? [`- Your session is approved ${until(session.expiresAt)}.`] : []),
      '- Without access, send the call with `Speaker-Wait: 60` (and `Speaker-Reason: <one sentence>`): speaker asks the owner and answers the call once approved. Otherwise a `403` names the `next` step. `denied` is final.',
      '- Running out of time: `POST /_speaker/requests/<id>/extend` with `{"duration":"15m"}`.',
      ...(provider.mcp
        ? [
            `- MCP server (streamable HTTP) at \`$SPEAKER_URL/${name}\`. Listing tools and read-only tools count as read; other tool calls count as write.`,
          ]
        : []),
      provider.guide
        ? `\n${provider.guide.trim()}`
        : '- No provider-specific guide: use the upstream API documentation for paths.',
    ]
    return c.text(`${lines.join('\n')}\n`, 200, { 'content-type': 'text/markdown; charset=utf-8' })
  })
  app.post('/_speaker/subjects', async (c) => {
    const enforcer = enforcerOf(c)
    const { label } = z.object({ label: z.string().trim().min(1).max(200) }).parse(await c.req.json())
    const token = randomBytes(32).toString('base64url')
    const subject = { id: rid(), label, enforcer: enforcer.id, tokenHash: hash(token) }
    subjects.set(subject.id, subject)
    await saveList('subjects.json', subjects)
    audit('subject_created', { subject: subject.id, enforcer: enforcer.id })
    return c.json({ id: subject.id, token }, 201)
  })
  app.delete('/_speaker/subjects/:id', async (c) => {
    const id = c.req.param('id')
    if (subjects.get(id)?.enforcer !== enforcerOf(c).id) throw new HTTPException(404, { message: 'Subject not found' })
    await deleteSubject(id)
    return c.json({ ok: true })
  })
  const kindsOf = (caller: Caller) =>
    caller.role === 'enforcer' ? ['credential', ...caller.enforcer.kinds] : caller.kinds
  // Lists only bundles whose every member the caller may request, since a request with any other member is refused whole.
  app.get('/_speaker/bundles', (c) => {
    const allowed = kindsOf(c.get('caller'))
    return c.json(
      Object.fromEntries(
        Object.entries(bundles).filter(([, bundle]) => bundle.members.every((m) => allowed.includes(m.kind))),
      ),
    )
  })
  app.post('/_speaker/requests', async (c) => {
    const input = requestInputSchema.and(z.object({ subjectId: idSchema.optional() })).parse(await c.req.json())
    const caller = c.get('caller')
    let subjectId: string
    if (caller.role === 'enforcer') {
      if (!input.subjectId || subjects.get(input.subjectId)?.enforcer !== caller.enforcer.id)
        throw new HTTPException(404, { message: 'Subject not found' })
      subjectId = input.subjectId
    } else {
      if (input.subjectId && input.subjectId !== caller.id)
        throw new HTTPException(403, { message: 'A session or subject requests only for itself' })
      subjectId = caller.id
    }
    const members = membersFor(input, kindsOf(caller))
    const request = createRequest(subjectId, members, input.bundle, input.reason, input.duration)
    const status = requestStatus(request)
    return c.json(
      {
        id: request.id,
        status,
        ...(status === 'pending'
          ? { next: `GET /_speaker/requests/${request.id}?wait=60`, tell_user: tellUser(`request-${request.id}`) }
          : status === 'denied'
            ? { next: 'Stop: the owner denied this recently.' }
            : {}),
      },
      201,
    )
  })
  // Status of one request; once approved it carries when the access ends (earliest member lease, null = never).
  const requestReply = (request: Pending) => {
    const status = requestStatus(request)
    const what = request.bundle
      ? `bundle ${request.bundle}`
      : request.members.map((m) => `${m.kind} ${m.ref}`).join(', ')
    if (status !== 'approved') return { id: request.id, what, status }
    const ends = request.members
      .map((m) => matchingLease(request.subjectId, m.kind, m.ref)?.expiresAt)
      .filter((end): end is string => typeof end === 'string')
      .sort()
    return { id: request.id, what, status, expiresAt: ends[0] ?? null }
  }
  // A session or subject lists its own requests, so it can see what is pending or granted without re-asking.
  app.get('/_speaker/requests', (c) => {
    const caller = subjectOf(c)
    return c.json([...pending.values()].filter((r) => r.subjectId === caller.id).map(requestReply))
  })
  const ownRequest = (c: Context<Env>) => {
    const request = pending.get(c.req.param('id') ?? ''),
      caller = c.get('caller')
    const mine =
      request &&
      (caller.role === 'enforcer'
        ? subjects.get(request.subjectId)?.enforcer === caller.enforcer.id
        : caller.id === request.subjectId)
    if (!request || !mine) throw new HTTPException(404, { message: 'Request not found' })
    return request
  }
  app.get('/_speaker/requests/:id', async (c) => {
    const request = ownRequest(c)
    await settle(c, () => requestStatus(request) !== 'pending')
    return c.json(requestReply(request))
  })
  const extendInput = async (c: Context) =>
    z.object({ duration: durationSchema }).parse(await c.req.json().catch(() => ({}))).duration
  // Extends an approved request's leases from now. Small extensions (at most the span the owner approved, a few
  // times) need no owner; a larger one files a new request for the same access.
  app.post('/_speaker/requests/:id/extend', async (c) => {
    const request = ownRequest(c),
      duration = await extendInput(c)
    if (requestStatus(request) !== 'approved')
      return c.json({ error: 'not_active', next: 'Request the access again (POST /_speaker/requests)' }, 409)
    const owned = request.members.map((m) => matchingLease(request.subjectId, m.kind, m.ref) as Lease)
    const wanted = durations[duration]
    if (owned.every((l) => l.expiresAt === null)) return c.json({ status: 'approved', expiresAt: null })
    if (owned.some((l) => l.grantedMs === undefined || wanted > l.grantedMs || (l.extensions ?? 0) >= autoExtensions)) {
      const again = createRequest(request.subjectId, request.members, request.bundle, 'extend access', duration)
      return c.json(
        {
          status: requestStatus(again),
          requestId: again.id,
          next: `GET /_speaker/requests/${again.id}?wait=60`,
          tell_user: tellUser(`request-${again.id}`),
        },
        202,
      )
    }
    const expiresAt = await serial(async () => {
      const next = new Map(leases)
      const until = Date.now() + wanted
      for (const lease of owned) {
        if (lease.expiresAt === null) continue
        const end = new Date(Math.max(until, Date.parse(lease.expiresAt))).toISOString()
        next.set(lease.id, { ...lease, expiresAt: end, extensions: (lease.extensions ?? 0) + 1 })
      }
      await commitLeases(next)
      return requestReply(request).expiresAt
    })
    void logEvent('lease_extended', request.subjectId, { requestId: request.id, expiresAt })
    return c.json({ status: 'approved', expiresAt })
  })
  // A session extends itself the same way; beyond the automatic limit it enrolls again.
  app.post('/_speaker/sessions/:id/extend', async (c) => {
    const caller = subjectOf(c),
      session = sessions.get(c.req.param('id'))
    if (!session || session.id !== caller.id) throw new HTTPException(404, { message: 'Session not found' })
    const wanted = durations[await extendInput(c)]
    if (session.expiresAt === null) return c.json({ status: 'approved', expiresAt: null })
    if (session.grantedMs === undefined || wanted > session.grantedMs || (session.extensions ?? 0) >= autoExtensions)
      return c.json({ error: 'extension_needs_approval', next: enroll }, 403)
    session.expiresAt = new Date(Math.max(Date.now() + wanted, Date.parse(session.expiresAt))).toISOString()
    session.extensions = (session.extensions ?? 0) + 1
    await saveList('sessions.json', sessions)
    void logEvent('session_extended', session.id, { expiresAt: session.expiresAt })
    return c.json({ status: 'approved', expiresAt: session.expiresAt })
  })
  app.all('/_speaker/*', (c) => c.json({ error: 'unknown_control_route' }, 404))
  app.all('*', async (c) => {
    const incoming = new URL(c.req.url),
      [providerId, ...parts] = incoming.pathname.slice(1).split('/')
    if (!Object.hasOwn(providers, providerId)) return c.json({ error: 'unknown_provider' }, 404)
    const provider = providers[providerId],
      caller = subjectOf(c),
      method = c.req.method,
      path = `/${parts.join('/')}`
    // MCP POST bodies are buffered (bounded) so speaker can classify them; other bodies stream through.
    let body: ReadableStream<Uint8Array> | string | null = ['GET', 'HEAD'].includes(method) ? null : c.req.raw.body
    let group: 'read' | 'write' = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write'
    let detail = ''
    if (provider.mcp && method === 'DELETE') group = 'read'
    if (provider.mcp && method === 'POST') {
      if (Number(c.req.header('content-length') ?? 0) > 1_048_576) return c.json({ error: 'mcp_body_too_large' }, 413)
      const text = await c.req.text()
      if (Buffer.byteLength(text) > 1_048_576) return c.json({ error: 'mcp_body_too_large' }, 413)
      body = text
      ;({ group, detail } = await mcpAccess(providerId, text))
    }
    const capability = `${providerId}.${group}`
    const rule = ruleFor(provider, group, caller.id)
    if (rule === 'deny')
      return c.json({ error: 'denied', capability, next: 'Stop: the owner blocks this; do not request it.' }, 403)
    const secret = secrets.get(providerId)
    if (secret === undefined) return c.json({ error: 'provider_not_configured' }, 503)
    if (rule === 'approval' && !hasLease(caller.id, 'credential', capability)) {
      const request = createRequest(
        caller.id,
        [{ kind: 'credential', ref: capability }],
        undefined,
        c.req.header('speaker-reason')?.trim().slice(0, 500) ?? '',
        '15m',
        method,
        detail ? `${path} · ${detail}` : path,
      )
      // `Speaker-Wait: <seconds>` holds this call until the owner decides, then forwards it: one call, no retry.
      await settle(c, () => requestStatus(request) !== 'pending', Number(c.req.header('speaker-wait')))
      const status = requestStatus(request)
      if (status === 'denied')
        return c.json(
          { error: 'denied', capability, requestId: request.id, next: 'Stop: the owner denied this request.' },
          403,
        )
      if (!hasLease(caller.id, 'credential', capability))
        return c.json(
          {
            error: 'approval_required',
            capability,
            requestId: request.id,
            next: `GET /_speaker/requests/${request.id}?wait=60, then repeat this call (or repeat it with Speaker-Wait: 60)`,
            tell_user: tellUser(`request-${request.id}`),
          },
          403,
        )
    }
    const lease = rule === 'approval' ? matchingLease(caller.id, 'credential', capability) : undefined
    const target = upstreamUrl(provider, secret, parts, incoming.search)
    if (!target) return c.json({ error: 'invalid_provider_url' }, 400)
    await recordUse(lease?.id, caller.id)
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
    applyCredential(provider, secret, headers)
    const start = Date.now()
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      duplex: 'half',
      redirect: 'manual',
      signal: c.req.raw.signal,
    } as RequestInit).catch(() => undefined)
    // Log the agent-facing path: a path-auth upstream URL contains the secret.
    audit('proxy_request', {
      subject: caller.id,
      provider: providerId,
      method,
      path,
      ...(detail ? { mcp: detail } : {}),
      status: upstream?.status ?? 502,
      latencyMs: Date.now() - start,
    })
    await logEvent('proxy', caller.id, {
      provider: providerId,
      method,
      path,
      ...(detail ? { mcp: detail } : {}),
      status: upstream?.status ?? 502,
      latencyMs: Date.now() - start,
      leaseId: lease?.id ?? null,
      rule,
    })
    if (!upstream) return c.json({ error: 'upstream_unavailable' }, 502)
    const responseHeaders = new Headers(upstream.headers)
    for (const name of [...hopHeaders, 'content-encoding', 'content-length']) responseHeaders.delete(name)
    const location = responseHeaders.get('location')
    if (provider.auth.type === 'path' && location?.includes(secret))
      responseHeaders.set('location', location.replaceAll(secret, '<redacted>'))
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  })
  return app
}

if (import.meta.main) {
  const config = readConfig()
  const app = await createApp(config)
  serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0', websocket: { server: wss } }, (info) =>
    audit('listening', { port: info.port }),
  )
}
