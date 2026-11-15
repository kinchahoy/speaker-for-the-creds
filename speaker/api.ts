import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { upgradeWebSocket } from '@hono/node-server'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { etag } from 'hono/etag'
import { HTTPException } from 'hono/http-exception'
import { proxy } from 'hono/proxy'
import { rateLimiter } from 'hono-rate-limiter'
import { z } from 'zod'
import {
  type Agent,
  agentError,
  type Core,
  demoSecret,
  type Env,
  enrollSchema,
  type Host,
  hash,
  hostSchema,
  identitySchema,
  idSchema,
  invalid,
  noCounts,
  requestSchema,
  same,
  union,
} from './core.ts'
import { catalogView } from './catalog.ts'
import type { Approval, Request } from './engine.ts'
import { type ErrorFields, itemForms, kindOf } from './items.ts'

export type SpeakerApi = ReturnType<typeof agentApi>

export function agentApi(app: Hono<Env>, core: Core, admin: Hono) {
  const tellUser = (c: Context, anchor: string) => `Ask the owner to approve at ${core.baseOf(c)}/admin#${anchor}`
  const withAddress = (c: Context, text: string) => text.replaceAll('$SPEAKER_URL', core.baseOf(c))
  // Every agent-facing 401 names the next step and points at the skill.
  const unauthorized = (
    c: Context,
    error: 'enroll' | 'register' | 'approval_required',
    message: string,
    fields: ErrorFields,
  ) => {
    c.header('www-authenticate', 'Bearer realm="speaker"')
    c.header('link', '</skill.md>; rel="help"')
    return agentError(c, 401, error, message, { ...fields, help: '/skill.md' })
  }
  // Until the owner has set a password and signed in (after every restart too), every agent, sandbox-host and proxy
  // call is refused: the same rule (lockNotice) gates the proxy and the certificate route.
  const locked: MiddlewareHandler<Env> = async (c, next) => {
    const notice = core.lockNotice(core.baseOf(c))
    if (notice)
      return agentError(c, 503, 'locked', notice.message, {
        next: 'Wait until the owner has signed in, then repeat the call',
        tell_user: notice.tell_user,
      })
    await next()
  }
  const enrollNext = 'Enroll again with a new token: read "Set up" in GET /_speaker/help'
  const revokedReply = (c: Context<Env>) =>
    agentError(c, 403, 'denied', 'The owner revoked this agent', {
      next: 'Stop: the owner revoked this agent. Tell the user.',
    })
  // Resolves a bearer token to an approved sandbox host or an agent. Every token, host or agent, only works from the
  // address it registered or enrolled from.
  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const token = /^Bearer +(\S+) *$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token)
      return unauthorized(c, 'enroll', 'No bearer token was sent', {
        next: `Send Authorization: Bearer <token>. ${enrollNext}`,
      })
    const digest = hash(token)
    const host = [...core.hosts.values()].find((item) => same(item.tokenHash, digest))
    if (host && host.source !== core.sourceOf(c))
      return unauthorized(c, 'register', 'This sandbox host token was registered from another address', {
        next: 'Register again: bottle register',
      })
    if (host && core.hostGrant(host.id)) c.set('caller', { role: 'host', host })
    else if (host)
      return unauthorized(c, 'approval_required', 'The owner has not approved this sandbox host yet', {
        tell_user: tellUser(c, `host-${host.id}`),
      })
    else {
      const found = core.resolveAgent(token, core.sourceOf(c))
      if ('agent' in found) c.set('caller', { role: 'agent', agent: found.agent })
      else if (found.refused === 'revoked') return revokedReply(c)
      else return unauthorized(c, 'enroll', 'This token is not enrolled for this address', { next: enrollNext })
    }
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
  // Each look waits for a decision in progress, so a grant is seen only once it is in place.
  const hold = async (c: Context<Env>, settled: () => boolean) => {
    const until = Date.now() + Math.min(Number(c.req.header('speaker-wait')) || 0, 120) * 1000
    while (!(await core.engine.serial(settled)) && Date.now() < until && !c.req.raw.signal.aborted) await sleep(500)
  }
  // A group is offered only if every member is a kind the agent can use.
  const offered = (agent: Agent) =>
    Object.entries(core.groups).filter(([, group]) =>
      group.items.every((item) => core.allowedKinds(agent).includes(kindOf(item) ?? '')),
    )
  const catalogHint = 'GET /_speaker/catalog'
  // Expands groups, adds the sites each extension needs (remembering which extension brought them), and asks each kind
  // whether the name is real: one name the agent may not ask for fails the whole call, with the names it may use
  // (never shares or targets), before anything reaches the owner.
  function resolveItems(want: string[], agent: Agent) {
    const items = want.flatMap((item) => {
      if (kindOf(item) !== 'group') return [item]
      const group = offered(agent).find(([name]) => `group:${name}` === item)
      if (!group)
        throw invalid(
          `${item} is not something you can ask for. Groups you can ask for: ${
            offered(agent)
              .map(([name]) => `group:${name}`)
              .join(', ') || 'none'
          }.`,
          undefined,
          400,
          catalogHint,
        )
      return group[1].items
    })
    for (const item of items) {
      const kind = kindOf(item) ?? ''
      if (!core.allowedKinds(agent).includes(kind))
        throw invalid(`${item} is not available to this agent`, itemForms, 400, catalogHint)
      const refused = core.kinds[kind].validate(item, agent.id)
      if (refused) throw invalid(refused.message, undefined, 400, refused.next)
    }
    // An extension brings the sites it needs, so one approval covers both. A site brought only by an extension (not
    // asked for itself) is recorded against it: it ends with that extension's grant.
    const catalog = core.connections.get(agent.host ?? '')?.catalog
    const bundled: Record<string, string> = {}
    for (const item of items)
      if (kindOf(item) === 'ext')
        for (const host of catalog?.extensions.find(({ id }) => `ext:${id}` === item)?.sites ?? [])
          if (!items.includes(`site:${host}`)) bundled[`site:${host}`] ??= item
    return { items: union(items, Object.keys(bundled)), bundled }
  }
  // Granted items its sandbox host has not yet reported in force: they count as granted for the agent only once it has.
  const applying = (request: Request) =>
    core.engine
      .outcomeOf(request)
      .approved.filter((grant) => core.engine.live(grant) && core.enforcementOf(grant) !== 'enforced')
      .map((grant) => grant.item)
  // A request as the agent sees it: per-item outcome, and what to do next.
  const outcome = (c: Context, request: Request) => {
    const status = core.engine.statusOf(request),
      { granted, denied, expiresAt } = core.engine.outcomeOf(request)
    const retry = core.engine.retryAfter(request.subject, denied)
    const waiting = applying(request)
    return {
      id: request.id,
      status,
      granted: granted.filter((item) => !waiting.includes(item)),
      denied,
      ...(waiting.length ? { applying: waiting } : {}),
      ...(granted.length ? { expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null } : {}),
      ...(retry ? { retry_after: retry } : {}),
      ...(status === 'pending'
        ? {
            next: 'Repeat this call with Speaker-Wait: 60 to keep waiting for the owner',
            tell_user: tellUser(c, `request-${request.id}`),
          }
        : status === 'expired'
          ? { next: 'The owner did not decide in time. POST /_speaker/requests again if the task still needs it' }
          : denied.length
            ? { next: 'Stop asking for the denied items and tell the user' }
            : waiting.length
              ? { next: 'Granted; the sandbox is applying it. Retry what was blocked in a few seconds' }
              : {}),
    }
  }
  // Files the request, holds for the owner when asked to, and answers with the per-item outcome.
  async function ask(c: Context<Env>, agent: Agent, input: z.infer<typeof requestSchema>) {
    let items: string[], bundled: Record<string, string>
    try {
      ;({ items, bundled } = resolveItems(input.want, agent))
      // A newer key replaces the older one.
      if (input.sshKey) {
        agent.sshKey = input.sshKey
        core.syncJump()
      }
      if (!agent.sshKey && items.some((item) => ['ssh', 'folder'].includes(kindOf(item) ?? '')))
        throw invalid(
          'ssh: and folder: items need "sshKey": one throwaway public key of yours (ssh-ed25519 …)',
          undefined,
          400,
          'Send "sshKey"; read "Folders and SSH" in GET /_speaker/help',
        )
    } catch (error) {
      // Turned away before the owner saw anything: the owner's page counts it.
      if (error instanceof HTTPException) core.tally(agent, 'refused', error.message)
      throw error
    }
    const request = core.engine.request('agent', agent.id, items, { ...input, bundled })
    await hold(c, () => settled(request))
    return core.engine.serial(() => outcome(c, request))
  }
  // Decided, and in force on the sandbox. `mcp:` and `ext:` take effect when Pi is idle, which a held call prevents, so
  // only the others are waited for.
  const settled = (request: Request) =>
    core.engine.statusOf(request) !== 'pending' &&
    !applying(request).some((item) => !['mcp', 'ext'].includes(kindOf(item) ?? ''))
  // The one flow for a call that needs an item (Layer 2): the item's admission, then the agent's grant for any item in
  // `covers`; without one, a request for `item` (joined if already pending), held up to Speaker-Wait, then the grant
  // or what to do next. Resolves to the grant (undefined for an open item) or the refusal to answer with.
  async function gate(
    c: Context<Env>,
    agent: Agent,
    item: string,
    covers: string[],
    call: string,
    trigger: string,
  ): Promise<{ grant?: Approval } | Response> {
    const admission = core.kinds[kindOf(item) ?? ''].admission(item, agent.id)
    // `why` is the line on the owner's page; `message` is the agent's.
    const blocked = (why: string, error: 'denied' | 'approval_required', message: string, fields: ErrorFields) => {
      core.tally(agent, 'blocked', `${call}: ${why}`)
      return agentError(c, 403, error, message, { item, ...fields })
    }
    if (admission.to === 'open') return {}
    if (admission.to !== 'ask') {
      const why = admission.to === 'never' ? `the owner blocks ${item}` : `${item} is unavailable: ${admission.why}`
      return blocked(why, 'denied', `${why[0].toUpperCase()}${why.slice(1)}`, {
        next: 'Stop: the owner blocks this; do not request it.',
      })
    }
    const held = core.engine.held(agent.id, covers)
    if (held) return { grant: held }
    const until = core.engine.lockedUntil(agent.id, item)
    if (until !== undefined)
      return blocked(
        `${item} denied by the owner, locked until ${new Date(until).toISOString()}`,
        'denied',
        `The owner denied ${item}`,
        { next: 'Stop: the owner denied this request.', retry_after: new Date(until).toISOString() },
      )
    const request = core.engine.request('agent', agent.id, [item], {
      reason: c.req.header('speaker-reason')?.trim().slice(0, 500) ?? '',
      duration: '2h',
      trigger,
    })
    await hold(c, () => core.engine.statusOf(request) !== 'pending')
    const grant = await core.engine.serial(() => core.engine.held(agent.id, covers))
    if (grant) return { grant }
    return core.engine.statusOf(request) === 'decided'
      ? blocked(`no grant for ${item}`, 'denied', `The owner denied ${item}`, {
          request: request.id,
          next: 'Stop: the owner denied this request.',
        })
      : blocked(`no grant for ${item}`, 'approval_required', `${item} needs the owner's approval`, {
          request: request.id,
          next: 'Repeat this call with Speaker-Wait: 60 (and Speaker-Reason: <one sentence>)',
          tell_user: tellUser(c, `request-${request.id}`),
        })
  }
  // Enrollment and registration are unauthenticated: one shared budget caps how many identities anyone can create.
  // Behind a reverse proxy every client shares one address anyway, so a per-address key would add nothing.
  // Declares a route's JSON body type for the typed client; the handler still parses it itself.
  const json =
    <T>(): MiddlewareHandler<Env, string, { in: { json: T } }> =>
    (_c, next) =>
      next()
  const hostBody = hostSchema.pick({ name: true, kinds: true, tokenHash: true })
  const requestBody = requestSchema.extend({ agentId: idSchema.optional() })
  const enrollmentLimit = rateLimiter<Env>({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    keyGenerator: () => 'enrollment',
    message: {
      error: 'rate_limited',
      message: 'Too many enrollments from this network',
      next: 'Wait a few minutes before enrolling again',
    },
  })
  const markdown = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'max-age=3600' }
  // The routes are one chain so that `SpeakerApi` carries their paths to bottle's typed client.
  return (
    app
      .get('/_speaker/health', (c) => c.json({ ok: true }))
      // The proxy's public certificate: agents trust it for the hosts of their secrets.
      .get('/_speaker/proxy/ca.pem', locked, async (c) =>
        c.text((await core.certificateAuthority()).cert, 200, { 'content-type': 'application/x-pem-file' }),
      )
      // Public discovery: what speaker is and where the instructions are. Services and groups stay behind auth.
      .use('/skill.md', etag())
      .use('/_speaker/help', etag())
      .get('/skill.md', (c) => c.text(withAddress(c, core.skill), 200, markdown))
      .get('/_speaker/help', (c) => c.text(withAddress(c, core.skill), 200, markdown))
      .get('/', (c) =>
        c.req.header('accept')?.includes('text/html')
          ? c.html(
              '<!doctype html><meta charset="utf-8"><title>Speaker</title><p>Speaker gives AI agents owner-approved access to homelab APIs; agents never see the keys.</p><p>Owner: approve requests at <a href="/admin">/admin</a>.</p><p>Agents: <a href="/skill.md">/skill.md</a>.</p>',
            )
          : c.text(withAddress(c, core.skill), 200, markdown),
      )
      .post('/_speaker/agents', locked, enrollmentLimit, async (c) => {
        const { tokenHash, want, reason, duration, sshKey, ...identity } = enrollSchema.parse(await c.req.json())
        let agent = core.agentByToken(tokenHash)
        // A revoked token stays dead; asking again means a new token, which reaches the owner as a new agent.
        if (agent?.status === 'revoked') return revokedReply(c)
        const source = core.sourceOf(c)
        if (agent && agent.source !== source)
          throw invalid('This token is already enrolled from another address. Make a new token and enroll again')
        const created = !agent
        if (!agent) {
          const enrolling: Agent = {
            id: core.rid(),
            tokenHash,
            status: 'enrolled',
            ...identity,
            source,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            uses: 0,
            lastUsedAt: null,
            counts: noCounts(),
          }
          // Refuse unknown names before enrolling, so a bad first request leaves no token behind.
          if (want.length) resolveItems(want, enrolling)
          agent = enrolling
          core.agents.set(agent.id, agent)
          core.audit('agent_enrolled', { agent: agent.id, source })
        }
        const result = want.length ? await ask(c, agent, { want, reason: reason ?? '', duration, sshKey }) : undefined
        if (!result && sshKey) agent.sshKey = sshKey
        return c.json(
          { id: agent.id, ...(result ? { request: result } : { next: 'GET /_speaker/catalog' }) },
          created ? 201 : 200,
        )
      })
      .post('/_speaker/hosts', locked, enrollmentLimit, json<z.input<typeof hostBody>>(), async (c) => {
        const input = hostBody.parse(await c.req.json())
        const host: Host = { id: core.rid(), ...input, source: core.sourceOf(c), registeredAt: Date.now() }
        core.audit('host_registered', { host: host.id, name: host.name })
        core.registerHost(host)
        // The ports let the sandbox host find the proxy and jump server without the owner copying them over.
        return c.json(
          { id: host.id, status: 'pending' as const, proxyPort: core.config.PROXY_PORT, sshPort: core.config.SSH_PORT },
          201,
        )
      })
      .all('/_demo-upstream/*', async (c) => {
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
      .route('/admin', admin)
      .use('*', locked, auth)
      .get(
        '/_speaker/hosts/ws',
        async (c, next) => {
          hostCaller(c)
          await next()
        },
        upgradeWebSocket((c) => {
          const id = hostCaller(c).id
          return {
            onOpen: (_event, ws) => {
              core.connections.get(id)?.ws.close(1000, 'replaced')
              core.connections.set(id, { ws, applied: new Set() })
              ws.send(JSON.stringify(core.snapshot(id)))
            },
            onMessage: (event, ws) => {
              const connection = core.connections.get(id)
              if (connection?.ws !== ws) return
              const message = z
                .discriminatedUnion('type', [
                  z.object({ type: z.literal('applied'), grantIds: z.array(z.string()) }),
                  z.object({
                    type: z.literal('catalog'),
                    mcps: z.array(z.object({ id: idSchema, label: z.string(), tools: z.array(z.string()) })),
                    extensions: z.array(
                      z.object({
                        id: idSchema,
                        label: z.string(),
                        description: z.string(),
                        tools: z.array(z.string()),
                        // Each site becomes a `site:` item, so it must be a valid one.
                        sites: z.array(
                          z.string().refine((host) => kindOf(`site:${host}`) === 'site', 'Not a site name'),
                        ),
                      }),
                    ),
                  }),
                ])
                .parse(JSON.parse(String(event.data)))
              if (message.type === 'catalog') {
                connection.catalog = { mcps: message.mcps, extensions: message.extensions }
                core.audit('host_catalog', {
                  host: id,
                  mcps: message.mcps.length,
                  extensions: message.extensions.length,
                })
              } else connection.applied = new Set(message.grantIds)
            },
            onClose: (_event, ws) => {
              if (core.connections.get(id)?.ws === ws) core.connections.delete(id)
            },
          }
        }),
      )
      // A sandbox host checking that speaker has approved it (the auth middleware has already refused unapproved ones).
      .get('/_speaker/hosts/self', (c) => {
        const caller = c.get('caller')
        if (caller.role !== 'host') return agentError(c, 403, 'denied', 'This route is for sandbox host tokens')
        return c.json({ id: caller.host.id, name: caller.host.name, status: 'approved' as const })
      })
      .post('/_speaker/hosts/agents', json<z.input<typeof identitySchema>>(), async (c) => {
        const host = hostCaller(c)
        const identity = identitySchema.parse(await c.req.json())
        const token = randomBytes(32).toString('base64url')
        // The agent's token works only from the sandbox host's address, so a token leaked from a VM is useless elsewhere.
        const agent: Agent = {
          id: core.rid(),
          tokenHash: hash(token),
          status: 'enrolled',
          ...identity,
          source: core.sourceOf(c),
          host: host.id,
          createdAt: Date.now(),
          lastSeen: Date.now(),
          uses: 0,
          lastUsedAt: null,
          counts: noCounts(),
        }
        core.agents.set(agent.id, agent)
        core.audit('agent_created', { agent: agent.id, host: host.id })
        return c.json({ id: agent.id, token }, 201)
      })
      .delete('/_speaker/hosts/agents/:id', (c) => {
        const id = c.req.param('id')
        if (core.agentById(id)?.host !== hostCaller(c).id) throw invalid('Agent not found', undefined, 404)
        core.endAgent(id)
        return c.json({ ok: true })
      })
      .get('/_speaker/catalog', (c) =>
        c.json(catalogView(core, c, agentCaller(c), offered(agentCaller(c)), (request) => outcome(c, request))),
      )
      .post('/_speaker/requests', json<z.input<typeof requestBody>>(), async (c) => {
        const caller = c.get('caller')
        const input = requestBody.parse(await c.req.json())
        let agent: Agent | undefined
        if (caller.role === 'host') {
          agent = input.agentId ? core.agentById(input.agentId) : undefined
          if (agent?.host !== caller.host.id) throw invalid('Agent not found', undefined, 404)
        } else {
          if (input.agentId && input.agentId !== caller.agent.id) throw invalid('An agent requests only for itself')
          agent = caller.agent
        }
        const result = await ask(c, agent, input)
        return c.json(result, result.status === 'pending' ? 202 : 200)
      })
      // One request's outcome by id, held like POST with `Speaker-Wait`. Watching an open request this way never files a
      // new one, even after it was decided.
      .get('/_speaker/requests/:id', async (c) => {
        const caller = c.get('caller')
        const request = core.engine.requests.get(c.req.param('id'))
        const mine =
          request !== undefined &&
          (caller.role === 'host'
            ? core.agentById(request.subject)?.host === caller.host.id
            : request.subject === caller.agent.id)
        if (!request || !mine)
          throw invalid(
            'No such request (decided requests are kept for a day)',
            undefined,
            404,
            'POST /_speaker/requests',
          )
        await hold(c, () => settled(request))
        const result = outcome(c, request)
        return c.json(result, result.status === 'pending' ? 202 : 200)
      })
      // Notes and the caller's current state for one service.
      .get('/_speaker/help/:name', (c) => {
        const agent = agentCaller(c)
        const name = c.req.param('name')
        if (!Object.hasOwn(core.services, name)) throw invalid('Unknown service', undefined, 404)
        const service = core.services[name]
        const until = (expiresAt: string | null) => (expiresAt === null ? 'with no end' : `until ${expiresAt} (UTC)`)
        const access = (write: boolean) => {
          const rule = write ? service.write : service.read
          if (rule === 'open') return 'open: needs no grant.'
          if (rule === 'never') return 'never granted by the owner. Do not ask for it.'
          const grant = core.coverFor(agent.id, name, write)
          return grant
            ? `granted ${until(grant.expiresAt)}.`
            : `needs \`${name}.${write ? 'full' : 'read'}\`; not granted yet.`
        }
        const lines = [
          `# ${name}`,
          '',
          `- Call \`${core.baseOf(c)}/${name}/<path>\` with your header file. Speaker sends \`<path>\` to the service's API root and adds the real credential. Send no other credentials.`,
          `- Read (GET, HEAD, OPTIONS${service.readPaths?.length ? `, POST to ${service.readPaths.join(', ')}` : ''}): ${access(false)}`,
          `- Everything else (\`${name}.full\`): ${access(true)}`,
          '- Without access, add `Speaker-Wait: 60` (and `Speaker-Reason: <one sentence>`). Speaker asks the owner and answers the call once they decide. Without that header, the call answers at once. `denied` is final.',
          ...(service.mcp
            ? [
                `- MCP server (streamable HTTP) at \`${core.baseOf(c)}/${name}\`. Listing tools and read-only tools count as read. Other tool calls need full.`,
              ]
            : []),
          service.notes
            ? `\n${service.notes.trim()}`
            : '- No notes for this service. Use the upstream API documentation for paths.',
        ]
        return c.text(`${lines.join('\n')}\n`, 200, { 'content-type': 'text/markdown; charset=utf-8' })
      })
      .all('/_speaker/*', (c) =>
        agentError(c, 404, 'not_found', 'Unknown route', { next: 'Read "Asking" in GET /_speaker/help' }),
      )
      .all('*', async (c) => {
        const incoming = new URL(c.req.url),
          [serviceId, ...parts] = incoming.pathname.slice(1).split('/')
        if (!Object.hasOwn(core.services, serviceId))
          return agentError(c, 404, 'not_found', 'Unknown service', { next: 'GET /_speaker/catalog' })
        const service = core.services[serviceId],
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
            return agentError(c, 413, 'invalid', 'MCP body too large', { next: 'Send a smaller MCP request' })
          const text = await c.req.text()
          if (Buffer.byteLength(text) > 1_048_576)
            return agentError(c, 413, 'invalid', 'MCP body too large', { next: 'Send a smaller MCP request' })
          body = text
          ;({ write, detail } = await core.mcpAccess(serviceId, text))
        }
        // A call needs exactly the item its method implies; `.full` also covers a read.
        const item = `${serviceId}.${write ? 'full' : 'read'}`
        const secret = core.credentialOf(serviceId)
        if (secret === undefined)
          return agentError(c, 503, 'no_key', `${serviceId} has no key configured yet`, {
            tell_user: `The owner adds a key for ${serviceId} at ${core.baseOf(c)}/admin?section=services`,
          })
        const gated = await gate(
          c,
          agent,
          item,
          write ? [item] : [`${serviceId}.full`, item],
          `${method} ${serviceId}`,
          `${method} ${detail ? `${path} · ${detail}` : path}`,
        )
        if (gated instanceof Response) return gated
        const { grant } = gated
        const target = core.upstreamUrl(service, secret, parts, incoming.search)
        if (!target) return c.json({ error: 'invalid', message: 'Invalid service URL' }, 400)
        if (grant) core.useOf(grant)
        core.useOf(agent)
        const headers = new Headers(c.req.raw.headers)
        const connectionHeaders = (headers.get('connection') ?? '')
          .split(',')
          .map((header) => header.trim())
          .filter(Boolean)
        for (const name of [...headers.keys()])
          if (
            /^(authorization|cookie|host|content-length|x-forwarded-.*|x-auth-request-.*|x-speaker-.*|speaker-.*|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i.test(
              name,
            ) ||
            connectionHeaders.includes(name)
          )
            headers.delete(name)
        core.applyCredential(service, secret, headers)
        const start = Date.now()
        // proxy() validates a malformed Connection header (400), drops response hop-by-hop headers and content-encoding.
        const upstream = await proxy(target, {
          raw: c.req.raw,
          strictConnectionProcessing: true,
          method,
          headers,
          body,
          redirect: 'manual',
          signal: c.req.raw.signal,
        } as RequestInit).catch((error: Error) => {
          if (error instanceof HTTPException) throw error
          core.audit('upstream_failed', { service: serviceId, error: String(error), cause: String(error.cause ?? '') })
          return undefined
        })
        core.audit('proxy', {
          agent: agent.id,
          service: serviceId,
          method,
          path,
          ...(detail ? { mcp: detail } : {}),
          status: upstream?.status ?? 502,
          latencyMs: Date.now() - start,
          grant: grant?.id ?? null,
          rule: service[write ? 'write' : 'read'],
        })
        if (!upstream)
          return agentError(c, 502, 'upstream_unavailable', `${serviceId} did not answer`, {
            next: 'Try again shortly; if it keeps failing, tell the user',
          })
        const location = upstream.headers.get('location')
        if (service.auth.type === 'path' && location?.includes(secret))
          upstream.headers.set('location', location.replaceAll(secret, '<redacted>'))
        return upstream
      })
  )
}
