import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { serve, upgradeWebSocket } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { bearerAuth } from 'hono/bearer-auth'
import { csrf } from 'hono/csrf'
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
const durationSchema = z.enum(['15m', '30m', '1h', '1d', '7d', '30d']).default('15m')
const adminDurationSchema = z.enum([...durationSchema.unwrap().options, 'permanent']).default('15m')
const durations = {
  '15m': 900_000,
  '30m': 1800_000,
  '1h': 3600_000,
  '1d': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
}
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
])
const providerSchema = z.object({
  baseUrl: urlSchema,
  guide: z.string().max(20_000).optional(),
  auth: authSchema,
  policy: z.object({ read: ruleSchema, write: ruleSchema }),
})
const kinds = ['credential', 'secret', 'site', 'folder', 'mcp'] as const
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const statusSchema = z.enum(['pending', 'approved', 'denied'])
const capabilitySchema = z.object({ kind: z.string(), ref: z.string().trim().min(1).max(500) })
const bundlesSchema = z.record(idSchema, z.array(capabilitySchema.extend({ kind: z.enum(kinds) })))
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
  tokenHash: hashSchema,
  duration: durationSchema,
  status: statusSchema,
  expiresAt: z.string().nullable(),
})
const sessionEnrollmentSchema = sessionSchema
  .pick({ label: true, tokenHash: true, duration: true })
  .extend({ llmName: z.string().trim().min(1).max(120) })
const subjectSchema = z.object({ id: idSchema, label: z.string(), enforcer: idSchema, tokenHash: hashSchema })
const leaseSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  kind: z.string(),
  ref: z.string(),
  expiresAt: z.string().nullable(),
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
  enforcer?: string
  members: Capability[]
  bundle?: string
  method?: string
  path?: string
  reason: string
  duration: z.infer<typeof durationSchema>
  status: 'pending' | 'approved' | 'denied' | 'expired'
  notification: 'disabled' | 'sending' | 'sent' | 'failed'
  createdAt: number
}
export type View = { enforcers: EnforcerView[]; sessions: SessionView[]; requests: Pending[]; leases: LeaseView[] }
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
  const recordUse = async (leaseId: string, subjectId: string) => {
    const now = Date.now()
    for (const [map, id] of [
      [leaseUsage, leaseId],
      [identityUsage, subjectId],
    ] as const) {
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
  const removeLeases = (matches: (lease: Lease) => boolean) =>
    serial(() => commitLeases(new Map([...leases].filter(([, lease]) => !matches(lease)))))
  const owner = (subjectId: string) => {
    const subject = subjects.get(subjectId)
    if (subject) return { label: subject.label, llmName: undefined, enforcer: enforcers.get(subject.enforcer)?.name }
    const session = sessions.get(subjectId)
    if (session) return { label: session.label, llmName: session.llmName, enforcer: undefined }
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
        const lease = { id: rid(), subjectId: request.subjectId, kind, ref, expiresAt }
        next.set(lease.id, lease)
      }
      await commitLeases(next)
      request.status = 'approved'
      audit('request_approved', { requestId: id, subject: request.subjectId, expiresAt })
    })
  }
  function deny(id: string) {
    return serial(() => {
      const request = pendingRequest(id)
      request.status = 'denied'
      audit('request_denied', { requestId: id, subject: request.subjectId })
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
    const existing = [...pending.values()].find(
      (r) =>
        r.subjectId === subjectId &&
        r.bundle === bundle &&
        JSON.stringify(r.members) === JSON.stringify(members) &&
        r.status === 'pending',
    )
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
    if (error instanceof HTTPException) return error.getResponse()
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

  // Resolves a bearer token to an enforcer, a live session, or a subject of an approved enforcer.
  const unauthorized = { message: { error: 'unauthorized' } }
  const auth = bearerAuth<Env>({
    verifyToken: (token, c) => {
      const digest = hash(token)
      const byToken = <T extends { tokenHash: string }>(items: Map<string, T>) =>
        [...items.values()].find((item) => same(item.tokenHash, digest))
      const enforcer = byToken(enforcers),
        session = byToken(sessions),
        subject = byToken(subjects)
      const parent = subject && enforcers.get(subject.enforcer)
      if (enforcer?.status === 'approved') c.set('caller', { role: 'enforcer', enforcer })
      else if (session && liveSession(session))
        c.set('caller', { role: 'subject', id: session.id, kinds: ['credential'] })
      else if (subject && parent?.status === 'approved')
        c.set('caller', { role: 'subject', id: subject.id, kinds: ['credential', ...parent.kinds] })
      else return false
      return true
    },
    noAuthenticationHeader: unauthorized,
    invalidAuthenticationHeader: unauthorized,
    invalidToken: unauthorized,
  })
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
  app.get('/skill.md', (c) => c.text(skill, 200, { 'content-type': 'text/markdown; charset=utf-8' }))
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
    const input = sessionEnrollmentSchema.parse(await c.req.json())
    const session: Session = { id: rid(), ...input, status: 'pending', expiresAt: null }
    sessions.set(session.id, session)
    await saveList('sessions.json', sessions)
    audit('session_enrolled', { session: session.id, label: session.label, llmName: session.llmName })
    void notify(`Session "${session.label}" (${session.llmName}) wants access`, `session-${session.id}`)
    return c.json({ id: session.id }, 201)
  })
  app.get('/_speaker/sessions/:id', (c) => {
    const session = sessions.get(c.req.param('id'))
    if (!session) throw new HTTPException(404, { message: 'Session not found' })
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
        authType: z.enum(['bearer', 'header', 'basic']),
        headerName: z.string().optional(),
        secret: z.string().optional(),
        guide: z.string().optional(),
        read: ruleSchema,
        write: ruleSchema,
      })
      .parse(await fields(c))
    const provider = providerSchema.parse({
      baseUrl: input.baseUrl,
      guide: input.guide?.trim() || undefined,
      auth: { type: input.authType, secret: input.id, headerName: input.headerName },
      policy: { read: input.read, write: input.write },
    })
    if (input.secret) {
      if (/[\r\n]/.test(input.secret)) throw new HTTPException(400, { message: 'Credential must be a single line' })
      await writeFile(secretPath(input.id), input.secret, { mode: 0o600 })
      secrets.set(input.id, input.secret)
    }
    providers[input.id] = provider
    await save(providersFile, providers)
    audit('provider_saved', { provider: input.id })
    return redirect(c)
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
    return redirect(c)
  })
  const bundleFile = file('bundles.json')
  admin.post('/bundles/save', async (c) => {
    const input = z.object({ id: idSchema, members: z.string() }).parse(await fields(c))
    const lines = input.members
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const parsed = z
      .array(capabilitySchema.extend({ kind: z.enum(kinds) }))
      .min(1, 'List at least one member, one per line as "kind ref"')
      .safeParse(lines.map((line) => ({ kind: line.split(/\s+/)[0], ref: line.replace(/^\S+\s*/, '') })))
    if (!parsed.success)
      throw new HTTPException(400, { message: `Each line must be "kind ref" with kind one of ${kinds.join(', ')}` })
    bundles[input.id] = parsed.data
    await save(bundleFile, bundles)
    audit('bundle_saved', { bundle: input.id })
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
    await saveList('sessions.json', sessions)
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
      await removeLeases((lease) => lease.id === id)
      audit('lease_revoked', { leaseId: id })
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
    return c.json(
      Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => [
          id,
          {
            auth: provider.auth.type,
            policy: provider.policy,
            secretConfigured: secrets.get(id) !== undefined,
            hasGuide: Boolean(provider.guide),
          },
        ]),
      ),
    )
  })
  app.get('/_speaker/providers/:name/guide', (c) => {
    subjectOf(c)
    const name = c.req.param('name')
    const guide = Object.hasOwn(providers, name) ? providers[name].guide : undefined
    if (!guide) throw new HTTPException(404, { message: 'No guide for this provider' })
    return c.text(guide, 200, { 'content-type': 'text/markdown; charset=utf-8' })
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
        Object.entries(bundles).filter(([, members]) => members.every((m) => allowed.includes(m.kind))),
      ),
    )
  })
  app.post('/_speaker/requests', async (c) => {
    const input = z
      .object({
        subjectId: idSchema.optional(),
        capability: capabilitySchema.optional(),
        bundle: idSchema.optional(),
        reason: z.string().trim().min(1).max(500),
        duration: durationSchema,
      })
      .refine((value) => Boolean(value.capability) !== Boolean(value.bundle), 'Send either capability or bundle')
      .parse(await c.req.json())
    const caller = c.get('caller')
    const allowedKinds = kindsOf(caller)
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
    const members = input.bundle ? bundles[input.bundle] : input.capability ? [input.capability] : undefined
    if (!members) throw new HTTPException(404, { message: 'Unknown bundle' })
    for (const { kind, ref } of members) {
      if (!allowedKinds.includes(kind))
        throw new HTTPException(400, { res: Response.json({ error: 'unsupported_kind', kind }, { status: 400 }) })
      if (kind === 'credential' && !/^[a-zA-Z0-9_-]+\.(read|write)$/.test(ref))
        throw new HTTPException(400, { message: 'Credential ref must be <provider>.read or <provider>.write' })
      if (kind === 'credential' && !Object.hasOwn(providers, ref.split('.')[0]))
        throw new HTTPException(400, { message: 'Unknown provider' })
    }
    const request = createRequest(subjectId, members, input.bundle, input.reason, input.duration)
    return c.json({ id: request.id, status: requestStatus(request) }, 201)
  })
  app.get('/_speaker/requests/:id', (c) => {
    const request = pending.get(c.req.param('id')),
      caller = c.get('caller')
    const mine =
      request &&
      (caller.role === 'enforcer'
        ? subjects.get(request.subjectId)?.enforcer === caller.enforcer.id
        : caller.id === request.subjectId)
    if (!request || !mine) throw new HTTPException(404, { message: 'Request not found' })
    return c.json({ id: request.id, status: requestStatus(request) })
  })
  app.all('/_speaker/*', (c) => c.json({ error: 'unknown_control_route' }, 404))
  app.all('*', async (c) => {
    const incoming = new URL(c.req.url),
      [providerId, ...parts] = incoming.pathname.slice(1).split('/')
    if (!Object.hasOwn(providers, providerId)) return c.json({ error: 'unknown_provider' }, 404)
    const provider = providers[providerId],
      caller = subjectOf(c),
      method = c.req.method
    const group = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write'
    const capability = `${providerId}.${group}`
    const rule = provider.policy[group]
    if (rule === 'deny') return c.json({ error: 'denied' }, 403)
    const secret = secrets.get(providerId)
    if (secret === undefined) return c.json({ error: 'provider_credential_missing' }, 503)
    if (rule === 'approval' && !hasLease(caller.id, 'credential', capability)) {
      const request = createRequest(
        caller.id,
        [{ kind: 'credential', ref: capability }],
        undefined,
        '',
        '15m',
        method,
        `/${parts.join('/')}`,
      )
      return c.json({ error: 'approval_required', capability, requestId: request.id }, 403)
    }
    const lease = rule === 'approval' ? matchingLease(caller.id, 'credential', capability) : undefined
    const base = new URL(provider.baseUrl),
      target = new URL(base.origin)
    const prefix = `${base.pathname.replace(/\/$/, '')}/`
    target.pathname = prefix + parts.join('/')
    target.search = incoming.search
    if (target.origin !== base.origin || !target.pathname.startsWith(prefix))
      return c.json({ error: 'invalid_provider_url' }, 400)
    if (lease) await recordUse(lease.id, caller.id)
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
        /^(authorization|cookie|host|content-length|x-forwarded-.*|x-auth-request-.*|x-speaker-.*)$/i.test(name) ||
        hopHeaders.includes(name) ||
        connectionHeaders.includes(name)
      )
        headers.delete(name)
    headers.set('accept-encoding', 'identity')
    if (provider.auth.type === 'header') headers.set(provider.auth.headerName, secret)
    else
      headers.set(
        'authorization',
        provider.auth.type === 'basic' ? `Basic ${Buffer.from(secret).toString('base64')}` : `Bearer ${secret}`,
      )
    const start = Date.now()
    const upstream = await fetch(target, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : c.req.raw.body,
      duplex: 'half',
      redirect: 'manual',
      signal: c.req.raw.signal,
    } as RequestInit).catch(() => undefined)
    audit('proxy_request', {
      subject: caller.id,
      provider: providerId,
      method,
      path: target.pathname,
      status: upstream?.status ?? 502,
      latencyMs: Date.now() - start,
    })
    if (!upstream) return c.json({ error: 'upstream_unavailable' }, 502)
    const responseHeaders = new Headers(upstream.headers)
    for (const name of [...hopHeaders, 'content-encoding', 'content-length']) responseHeaders.delete(name)
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
