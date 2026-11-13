import { readFileSync } from 'node:fs'
import { type Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { NONCE, secureHeaders } from 'hono/secure-headers'
import { rateLimiter } from 'hono-rate-limiter'
import { z } from 'zod'
import {
  type Core,
  decisionSchema,
  groupDescriptionSchema,
  groupItemsSchema,
  idSchema,
  newPasswordSchema,
  ownerSecretSchema,
  serviceSchema,
  urlSchema,
} from './core.ts'
import { hostTable, transition } from './lifecycle.ts'
import { WrongPassword } from './store.ts'
import { active, icons, inbox, layout, live, log, setPasswordPage, setup, signInPage, unchanged } from './ui.ts'

export function adminApp(core: Core) {
  const {
    config,
    services,
    secrets,
    groups,
    hosts,
    agents,
    grants,
    requests,
    sockets,
    sessions,
    logged,
    mcpTools,
    jump,
    unlocked,
    persistServiceKeys,
    createOwnerStore,
    signIn,
    checkPassword,
    audit,
    rid,
    push,
    revokeGrants,
    decide,
    listMcpTools,
    saveHosts,
    saveServices,
    saveGroups,
    sourceOf,
    baseOf,
    view,
    endAgent,
  } = core
  const admin = new Hono()
  admin.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'"],
        scriptSrc: ["'self'", NONCE],
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
  // Form posts and JSON clients alike must send an Origin matching PUBLIC_URL. Fetch Metadata identifies browser
  // same-origin requests even when TLS ends at a reverse proxy. Hono's csrf below stays as the backstop.
  const publicOrigin = new URL(config.PUBLIC_URL).origin
  admin.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    const form = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/i.test(
      c.req.header('content-type') ?? '',
    )
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      (origin ? origin !== publicOrigin : form) &&
      c.req.header('sec-fetch-site') !== 'same-origin'
    )
      return c.text(`Cross-origin form post blocked: send an Origin header matching ${config.PUBLIC_URL}.`, 403)
    await next()
  })
  admin.use('*', csrf({ origin: publicOrigin }))
  // Assets from the installed packages: htmx, Open Props' colour, shadow, border, size and font tokens, and the Lucide
  // sprite cut down to the icons in ui.ts.
  const asset = (path: string) => readFileSync(new URL(import.meta.resolve(path)), 'utf8')
  const cached = (type: string, body: string) => (c: Context) =>
    c.body(body, 200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'max-age=86400' })
  const props = ['colors', 'shadows', 'borders', 'sizes', 'fonts'].map((f) => asset(`open-props/${f}.min.css`)).join('')
  const lucide = asset('lucide-static/sprite.svg')
  const symbol = ([kind, [icon]]: [string, [string, number]]) => {
    const found = lucide.match(new RegExp(`<symbol id="${icon}"[\\s\\S]*?</symbol>`))
    if (!found) throw new Error(`lucide-static has no icon named ${icon} (used for ${kind} in ui.ts)`)
    return found[0].replace(`"${icon}"`, `"i-${kind}"`)
  }
  const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${Object.entries(icons).map(symbol).join('')}</defs></svg>`
  admin.get('/assets/htmx.js', cached('text/javascript', asset('htmx.org/dist/htmx.min.js')))
  admin.get('/assets/open-props.css', cached('text/css', props))
  admin.get('/assets/icons.svg', cached('image/svg+xml', sprite))
  // Owner sessions live in memory only: a restart signs the owner out.
  const sessionLife = 12 * 3600_000
  const sessionCookie = 'speaker_session'
  const signedIn = (c: Context) => {
    const id = getCookie(c, sessionCookie)
    return id !== undefined && (sessions.get(id) ?? 0) > Date.now()
  }
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
    return c.html(core.hasStore ? signInPage(exposed, error) : setPasswordPage(exposed, error), status)
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
    await createOwnerStore(input.data.password)
    audit('owner_password_set')
    return startSession(c)
  })
  admin.post('/signin', signInLimit, async (c) => {
    if (!core.hasStore) return c.redirect('/admin', 303)
    const { password } = z.object({ password: z.string() }).parse(await c.req.parseBody())
    try {
      await signIn(password)
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
  // Newest entries first, optionally narrowed to one grant, agent, service, target or share.
  admin.get('/log', (c) => {
    const query = c.req.query()
    const { grant, agent, service, target, share } = query
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
    const now = view(),
      ssh = jump.setup()
    const ids = (record: object) => Object.keys(record).map((id): [string, string] => [id, id])
    return c.html(
      layout(
        c.get('secureHeadersNonce'),
        'log',
        log(entries, query, {
          agent: now.agents.map((a) => [a.id, a.label]),
          grant: now.grants.map((g) => [g.id, `${g.label} · ${g.item}`]),
          service: ids(services),
          target: ids(ssh.targets),
          share: ids(ssh.shares),
        }),
      ),
    )
  })
  const panels = {
    inbox: () => inbox(view(), groups, unlocked().vault.secrets),
    active: () => active(view()),
  }
  admin.get('/', (c) => {
    const section = c.req.query('section') ?? (c.req.query('service') ? 'services' : 'approvals')
    const nonce = c.get('secureHeadersNonce')
    if (section === 'services' || section === 'groups') {
      const mcp = Object.fromEntries(
        [...mcpTools].map(([id, { tools }]) => {
          const list = [...tools.values()]
          const read = list.filter((tool) => tool.readOnly).length
          return [id, { read, write: list.length - read, unannotated: list.filter((tool) => !tool.annotated).length }]
        }),
      )
      const owned = Object.fromEntries(
        Object.entries(unlocked().vault.secrets).map(([name, { hosts, env }]) => [name, { hosts, env }]),
      )
      const ssh = jump.setup(c.req.query('sshError'))
      const data = {
        services,
        secrets,
        owned,
        groups,
        ssh,
        mcp,
        selected: c.req.query('service'),
        error: c.req.query('error'),
      }
      return c.html(layout(nonce, 'services', setup(data)))
    }
    if (['active', 'grants', 'agents'].includes(section))
      return c.html(layout(nonce, 'active', live('active', panels.active())))
    return c.html(layout(nonce, 'approvals', live('inbox', panels.inbox())))
  })
  // A live panel again, or 204 when it shows the same as the hash the page holds.
  admin.get('/panel/:name{inbox|active}', (c) => {
    const name = c.req.param('name') as keyof typeof panels
    const inner = panels[name]()
    return unchanged(inner, c.req.query('h')) ? c.body(null, 204) : c.html(live(name, inner))
  })
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
    await saveServices()
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
    await saveServices()
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
      await checkPassword(current)
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
    await saveGroups()
    audit('group_saved', { group: input.data.id })
    return c.redirect('/admin?section=groups', 303)
  })
  admin.post('/groups/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(groups, id)) throw new HTTPException(404, { message: 'Unknown group' })
    delete groups[id]
    await saveGroups()
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
  return admin
}
