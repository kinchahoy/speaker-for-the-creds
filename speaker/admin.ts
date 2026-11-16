import { readFileSync } from 'node:fs'
import { type Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { NONCE, secureHeaders } from 'hono/secure-headers'
import { rateLimiter } from 'hono-rate-limiter'
import { z } from 'zod'
import {
  agentError,
  type Core,
  decisionSchema,
  groupDescriptionSchema,
  groupItemsSchema,
  idSchema,
  newPasswordSchema,
  ownerSecretSchema,
  serviceSchema,
  within,
  urlSchema,
  type View,
} from './core.ts'
import { WrongPassword } from './store.ts'
import { agents, icons, layout, log, setPasswordPage, setup, signInPage } from './ui.ts'

const textLines = (text = '') =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

export function adminApp(core: Core) {
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
  const publicOrigin = new URL(core.config.PUBLIC_URL).origin
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
      return c.text(`Cross-origin form post blocked: send an Origin header matching ${core.config.PUBLIC_URL}.`, 403)
    await next()
  })
  admin.use('*', csrf({ origin: publicOrigin }))
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
  admin.get('/assets/idiomorph.js', cached('text/javascript', asset('idiomorph/dist/idiomorph-ext.min.js')))
  admin.get('/assets/open-props.css', cached('text/css', props))
  admin.get('/assets/icons.svg', cached('image/svg+xml', sprite))
  const sessionLife = 12 * 3600_000
  const sessionCookie = 'speaker_session'
  const current = (id: string | undefined) => id !== undefined && (core.sessions.get(id) ?? 0) > Date.now()
  // Owner API tokens share the session map and lifetime, but are only ever accepted as a bearer token, never as the
  // cookie (and a cookie's id is never accepted as a bearer token).
  const apiTokens = new Set<string>()
  const signedIn = (c: Context) => {
    const id = getCookie(c, sessionCookie)
    return current(id) && !apiTokens.has(id as string)
  }
  const newSession = () => {
    const id = core.rid()
    core.sessions.set(id, Date.now() + sessionLife)
    return id
  }
  const signInLimit = rateLimiter({
    windowMs: 15 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    skipSuccessfulRequests: true,
    keyGenerator: (c) => core.sourceOf(c),
    message: 'Too many failed attempts; wait a few minutes.',
  })
  const passwordBody = z.object({ password: z.string() })
  const signIn = async (c: Context, password: string) => {
    try {
      await core.signIn(password)
    } catch (error) {
      if (!(error instanceof WrongPassword)) throw error
      core.audit('signin_failed', { source: core.sourceOf(c) })
      return false
    }
    core.audit('owner_signed_in')
    return true
  }
  const authPage = (c: Context, error?: string, status: 200 | 400 | 401 = 200) => {
    // Plain HTTP from another machine sends the password in clear.
    const exposed = !core.baseOf(c).startsWith('https:') && !/^(127\.|::1$)/.test(core.sourceOf(c))
    return c.html(core.vault.state !== 'unset' ? signInPage(exposed, error) : setPasswordPage(exposed, error), status)
  }
  const startSession = (c: Context) => {
    setCookie(c, sessionCookie, newSession(), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: core.baseOf(c).startsWith('https:'),
      path: '/admin',
      maxAge: sessionLife / 1000,
    })
    return c.redirect('/admin', 303)
  }
  admin.post('/setup', signInLimit, async (c) => {
    const input = newPasswordSchema.safeParse(await c.req.parseBody())
    if (!input.success) return authPage(c, input.error.issues[0].message, 400)
    await core.createOwnerStore(input.data.password)
    core.audit('owner_password_set')
    return startSession(c)
  })
  admin.post('/signin', signInLimit, async (c) => {
    if (core.vault.state === 'unset') return c.redirect('/admin', 303)
    const { password } = passwordBody.parse(await c.req.parseBody())
    if (!(await signIn(c, password))) return authPage(c, 'Wrong password.', 401)
    return startSession(c)
  })
  // The owner API (the Herdr mod): the same sign-in, then bearer tokens only. The cookie is never accepted here, so a
  // browser page cannot ride the owner's session into it.
  const apiError = (c: Context, status: 401 | 404 | 409, message: string) =>
    agentError(c, status, status === 401 ? 'denied' : status === 404 ? 'not_found' : 'conflict', message)
  admin.post('/api/signin', signInLimit, async (c) => {
    if (core.vault.state === 'unset') return apiError(c, 409, 'Set the owner password at /admin first')
    const { password } = passwordBody.parse(await c.req.json())
    if (!(await signIn(c, password))) return apiError(c, 401, 'Wrong password')
    const token = newSession()
    apiTokens.add(token)
    return c.json({ token, publicUrl: core.config.PUBLIC_URL })
  })
  admin.use('/api/*', async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1]
    if (current(token) && apiTokens.has(token as string)) return await next()
    return apiError(c, 401, 'Sign in with POST /admin/api/signin and send Authorization: Bearer <token>')
  })
  admin.get('/api/pending', (c) => c.json({ pending: core.engine.cards() }))
  admin.get('/api/active', (c) =>
    c.json({
      grants: core.engine.grants().map((g) => ({
        id: g.id,
        subject: g.subject,
        who: core.engine.whoOf(g),
        item: g.item,
        expiresAt: g.expiresAt,
        ...core.engine.describe(g),
      })),
    }),
  )
  const pendingOf = (id: string) => {
    const request = core.engine.requests.get(id)
    return request ? core.engine.outcomeOf(request).pending : []
  }
  admin.post('/api/requests/:id/approve', async (c) => {
    const { duration } = decisionSchema.pick({ duration: true }).parse(await c.req.json())
    const items = pendingOf(c.req.param('id'))
    await core.engine.decide(c.req.param('id'), items, items, duration)
    return c.body(null, 204)
  })
  admin.post('/api/requests/:id/deny', async (c) => {
    await core.engine.decide(c.req.param('id'), [], pendingOf(c.req.param('id')), '2h')
    return c.body(null, 204)
  })
  admin.post('/api/grants/:id/revoke', (c) => {
    core.engine.revoke(c.req.param('id'))
    return c.body(null, 204)
  })
  admin.all('/api/*', (c) => apiError(c, 404, 'No such owner API route'))
  admin.use('*', async (c, next) => {
    if (signedIn(c)) return await next()
    if (c.req.method !== 'GET') return c.text('Sign in at /admin', 401)
    return c.req.path === '/admin' ? authPage(c) : c.redirect('/admin', 303)
  })
  admin.get('/log', async (c) => {
    const query = c.req.query()
    const { grant, agent, service, target, share } = query
    const text = query.q?.trim().toLowerCase()
    const matches = (await core.readLog()).filter(
      (e) =>
        (!text || JSON.stringify(e).toLowerCase().includes(text)) &&
        (!grant || e.grant === grant) &&
        (!agent || e.agent === agent) &&
        (!target || e.target === target) &&
        (!share || e.share === share) &&
        (!service ||
          e.service === service ||
          (Array.isArray(e.items) && e.items.some((i) => String(i).startsWith(`${service}.`)))),
    )
    const now = core.view(),
      ssh = core.jump.setup()
    const ids = (record: object) => Object.keys(record).map((id): [string, string] => [id, id])
    return c.html(
      layout(
        c.get('secureHeadersNonce'),
        'log',
        log(
          matches.slice(0, 500),
          matches.length,
          query,
          {
            agent: now.agents.map((a) => [a.id, a.title ? `${a.label} · ${a.title}` : a.label]),
            grant: now.grants.map((g) => [g.id, `${g.label} · ${g.item}`]),
            service: ids(core.services),
            target: ids(ssh.targets),
            share: ids(ssh.shares),
          },
          Object.fromEntries(now.agents.map((a) => [a.id, a.sandboxHost])),
        ),
        core.engine.cards().length,
      ),
    )
  })
  const panel = (view: View) => agents(view, core.groups, new Set(core.connections.keys()), core.services)
  admin.get('/', (c) => {
    const section = c.req.query('section') ?? (c.req.query('service') ? 'services' : 'agents')
    const nonce = c.get('secureHeadersNonce')
    if (section === 'services' || section === 'groups') {
      const mcp = Object.fromEntries(
        [...core.mcpTools].map(([id, { tools }]) => {
          const list = [...tools.values()]
          const read = list.filter((tool) => tool.readOnly).length
          return [id, { read, write: list.length - read, unannotated: list.filter((tool) => !tool.annotated).length }]
        }),
      )
      const owned = core.ownerConfig.secrets
      const ssh = core.jump.setup(c.req.query('sshError'))
      const data = {
        services: core.services,
        keyed: new Set(Object.keys(core.services).filter((id) => core.credentialOf(id) !== undefined)),
        owned,
        groups: core.groups,
        ssh,
        mcp,
        selected: c.req.query('service'),
        error: c.req.query('error'),
      }
      return c.html(layout(nonce, 'services', setup(data), core.engine.cards().length))
    }
    const view = core.view()
    return c.html(layout(nonce, 'agents', panel(view), view.cards.length))
  })
  // The older inbox and active panels poll the same one.
  admin.get('/panel/:name{inbox|active|agents}', (c) => c.html(panel(core.view())))
  const fields = async (c: Context) => await c.req.parseBody({ all: true })
  const redirect = (c: Context) => c.redirect('/admin', 303)
  admin.post('/services/save', async (c) => {
    const input = z
      .object({
        id: idSchema,
        // A pasted URL after a typed scheme ("https:/https://…") is a valid URL with host "https"; refuse it here only, so a
        // stored one does not stop speaker from starting.
        baseUrl: urlSchema.pipe(
          z.url({ hostname: /^(?!https?$)/, error: 'Write the URL once, starting with https:// or http://' }),
        ),
        authType: z.enum(['none', 'bearer', 'header', 'basic', 'path']),
        headerName: z.string().optional(),
        secret: z.string().optional(),
        keyFrom: z.union([idSchema, z.literal('')]).optional(),
        notes: z.string().optional(),
        read: serviceSchema.shape.read,
        write: serviceSchema.shape.write,
        readPaths: z.string().optional().transform(textLines),
        mcp: z.literal('on').optional(),
      })
      .superRefine(({ secret, authType }, ctx) => {
        if (secret && /[\r\n]/.test(secret))
          ctx.addIssue({ code: 'custom', message: 'Credential must be a single line' })
        if (secret && authType === 'path' && !/^[A-Za-z0-9._~-]+$/.test(secret))
          ctx.addIssue({ code: 'custom', message: 'A path credential must be one URL path segment' })
      })
      .parse(await fields(c))
    const shared = input.authType !== 'none' && input.keyFrom
    const wider = shared ? core.services[shared] : undefined
    if (
      shared &&
      !(
        wider &&
        wider.auth.type !== 'none' &&
        wider.auth.secret === shared &&
        shared !== input.id &&
        within(input.baseUrl, wider.baseUrl)
      )
    )
      throw new HTTPException(400, {
        message: `To use the key of ${shared}, the address must be on the same site and under that service's address, and ${shared} must hold its own key`,
      })
    const service = serviceSchema.parse({
      baseUrl: input.baseUrl,
      notes: input.notes?.trim() || undefined,
      auth: { type: input.authType, secret: shared || input.id, headerName: input.headerName },
      read: input.read,
      write: input.write,
      readPaths: input.readPaths.length ? input.readPaths : undefined,
      mcp: input.mcp ? true : undefined,
    })
    if (input.secret && !shared) {
      core.unlocked().vault.services[input.id] = input.secret
      await core.unlocked().save()
    }
    if ((input.authType === 'none' || shared) && Object.hasOwn(core.unlocked().vault.services, input.id)) {
      delete core.unlocked().vault.services[input.id]
      await core.unlocked().save()
    }
    core.services[input.id] = service
    core.mcpTools.delete(input.id)
    await core.saveConfig()
    core.audit('service_saved', { service: input.id })
    core.engine.reconcile()
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/services/tools', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!core.services[id]?.mcp) throw new HTTPException(404, { message: 'Not an MCP service' })
    const ok = await core.listMcpTools(id).then(
      () => true,
      () => false,
    )
    return c.redirect(`/admin?section=services&service=${id}${ok ? '' : '&error=tools'}`, 303)
  })
  admin.post('/services/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(core.services, id)) throw new HTTPException(404, { message: 'Unknown service' })
    delete core.services[id]
    delete core.unlocked().vault.services[id]
    await core.saveConfig()
    await core.unlocked().save()
    core.audit('service_deleted', { service: id })
    core.engine.reconcile()
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/secrets/save', async (c) => {
    const input = ownerSecretSchema.parse(await fields(c))
    const { vault } = core.unlocked()
    const value = input.value || vault.secrets[input.name]
    if (!value) throw new HTTPException(400, { message: 'A new secret needs a value' })
    vault.secrets[input.name] = value
    core.ownerConfig.secrets[input.name] = { hosts: input.hosts, env: input.env }
    await core.unlocked().save()
    await core.saveConfig()
    core.audit('secret_saved', { secret: input.name })
    // Grants read the hosts live, so a newly allowed host would quietly widen every grant already given: reconcile
    // ends them (their reach grew).
    core.engine.reconcile()
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/secrets/delete', async (c) => {
    const { name } = ownerSecretSchema.pick({ name: true }).parse(await fields(c))
    const { vault } = core.unlocked()
    if (!Object.hasOwn(core.ownerConfig.secrets, name)) throw new HTTPException(404, { message: 'Unknown secret' })
    delete vault.secrets[name]
    delete core.ownerConfig.secrets[name]
    await core.unlocked().save()
    await core.saveConfig()
    core.audit('secret_deleted', { secret: name })
    core.engine.reconcile()
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/password', async (c) => {
    const { current, ...next } = z
      .object({ current: z.string() })
      .and(newPasswordSchema)
      .parse(await fields(c))
    try {
      await core.checkPassword(current)
    } catch (error) {
      if (error instanceof WrongPassword) throw new HTTPException(400, { message: 'The current password is wrong' })
      throw error
    }
    await core.unlocked().setPassword(next.password)
    core.audit('owner_password_changed')
    return c.redirect('/admin?section=services', 303)
  })
  admin.post('/groups/save', async (c) => {
    const back = (error: string) => c.redirect(`/admin?section=groups&error=${error}`, 303)
    const form = await fields(c)
    const input = z.object({ id: idSchema, items: z.string().transform(textLines) }).safeParse(form)
    if (!input.success) return back('id')
    const description = groupDescriptionSchema.safeParse(form.description ?? '')
    if (!description.success) return back('description')
    if (!input.data.items.length) return back('empty')
    const parsed = groupItemsSchema.safeParse(input.data.items)
    if (!parsed.success) return back('line')
    core.groups[input.data.id] = { ...(description.data ? { description: description.data } : {}), items: parsed.data }
    await core.saveConfig()
    core.audit('group_saved', { group: input.data.id })
    return c.redirect('/admin?section=groups', 303)
  })
  admin.post('/groups/delete', async (c) => {
    const { id } = z.object({ id: idSchema }).parse(await fields(c))
    if (!Object.hasOwn(core.groups, id)) throw new HTTPException(404, { message: 'Unknown group' })
    delete core.groups[id]
    await core.saveConfig()
    core.audit('group_deleted', { group: id })
    return c.redirect('/admin?section=groups', 303)
  })
  const hostById = (id: string) => {
    const host = core.hosts.get(id)
    if (!host) throw new HTTPException(404, { message: 'Unknown sandbox host' })
    return host
  }
  admin.post('/hosts/:id/approve', async (c) => {
    const host = hostById(c.req.param('id'))
    const request = [...core.engine.requests.values()].find(
      (r) => r.subject === host.id && core.engine.statusOf(r) === 'pending',
    )
    if (!request) throw new HTTPException(409, { message: 'This sandbox host is already approved' })
    const items = core.engine.outcomeOf(request).pending
    await core.engine.decide(request.id, items, items, 'permanent')
    return redirect(c)
  })
  admin.post('/hosts/:id/remove', (c) => {
    core.engine.endSubject(hostById(c.req.param('id')).id)
    return redirect(c)
  })
  admin.post('/agents/:id/revoke', (c) => {
    core.endAgent(c.req.param('id'))
    return redirect(c)
  })
  // One grant id, or several (an agent's extend-all and revoke-all): each goes through the same per-grant operation.
  const grantIds = async (c: Context) =>
    [z.object({ id: z.union([idSchema, z.array(idSchema)]) }).parse(await fields(c)).id].flat()
  admin.post('/grants/extend', async (c) => {
    for (const id of await grantIds(c)) core.engine.extend(id)
    return redirect(c)
  })
  admin.post('/requests/:id/approve', async (c) => {
    const { duration, items, shown } = decisionSchema.parse(await fields(c))
    await core.engine.decide(c.req.param('id'), items, shown, duration)
    return redirect(c)
  })
  admin.post('/requests/:id/deny', async (c) => {
    const { shown } = decisionSchema.pick({ shown: true }).parse(await fields(c))
    await core.engine.decide(c.req.param('id'), [], shown, '2h')
    return redirect(c)
  })
  admin.post('/grants/revoke', async (c) => {
    for (const id of await grantIds(c)) core.engine.revoke(id)
    return redirect(c)
  })
  core.jump.routes(admin, fields, core.engine.reconcile)
  admin.all('*', (c) => c.json({ error: 'admin_route_not_found' }, 404))
  return admin
}
