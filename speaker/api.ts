import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { upgradeWebSocket } from '@hono/node-server'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { etag } from 'hono/etag'
import { HTTPException } from 'hono/http-exception'
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
  itemsWhere,
  noCounts,
  plural,
  type Request,
  requestSchema,
  same,
  statusOf,
  union,
} from './core.ts'
import { type ErrorFields, itemForms, kindOf } from './items.ts'

export function agentApi(app: Hono<Env>, core: Core, admin: Hono) {
  const {
    skill,
    config,
    services,
    groups,
    hosts,
    agents,
    grants,
    requests,
    connections,
    agentById,
    agentByToken,
    resolveAgent,
    jump,
    ownerSecrets,
    lockNotice,
    credentialOf,
    audit,
    rid,
    live,
    push,
    syncJump,
    snapshot,
    serviceItem,
    coverFor,
    secretGrants,
    certificateAuthority,
    useOf,
    lockedUntil,
    retryAfter,
    notify,
    createRequest,
    mcpAccess,
    upstreamUrl,
    applyCredential,
    hostOf,
    saveHosts,
    sourceOf,
    baseOf,
    enforcementOf,
    endAgent,
    tally,
  } = core
  const tellUser = (c: Context, anchor: string) => `Ask the owner to approve at ${baseOf(c)}/admin#${anchor}`
  const withAddress = (c: Context, text: string) => text.replaceAll('$SPEAKER_URL', baseOf(c))
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
    const notice = lockNotice(baseOf(c))
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
    const host = [...hosts.values()].find((item) => same(item.tokenHash, digest))
    if (host && host.source !== sourceOf(c))
      return unauthorized(c, 'register', 'This sandbox host token was registered from another address', {
        next: 'Register again: bottle register',
      })
    if (host?.status === 'approved') c.set('caller', { role: 'host', host })
    else if (host)
      return unauthorized(c, 'approval_required', 'The owner has not approved this sandbox host yet', {
        tell_user: tellUser(c, `host-${host.id}`),
      })
    else {
      const found = resolveAgent(token, sourceOf(c))
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
  const catalogHint = 'GET /_speaker/catalog'
  const list = (names: string[], none: string) => (names.length ? names.join(', ') : none)
  // Expands groups, adds the sites of each extension, and refuses any name this agent may not ask for: the whole call
  // fails with the names it may use (never shares or targets), before anything reaches the owner.
  function resolveItems(want: string[], agent: Agent) {
    const catalog = connections.get(agent.host ?? '')?.catalog
    const items = want.flatMap((item) => {
      if (kindOf(item) !== 'group') return [item]
      const group = offered(agent).find(([name]) => `group:${name}` === item)
      if (!group)
        throw invalid(
          `${item} is not something you can ask for. Groups you can ask for: ${list(
            offered(agent).map(([name]) => `group:${name}`),
            'none',
          )}.`,
          undefined,
          400,
          catalogHint,
        )
      return group[1].items
    })
    const refuse = (item: string, real: string[], what: string, none: string) =>
      invalid(
        `${item} is not something you can ask for. ${what} you can ask for: ${list(real, none)}.`,
        undefined,
        400,
        catalogHint,
      )
    for (const item of items) {
      const kind = kindOf(item) ?? ''
      if (!allowedKinds(agent).includes(kind))
        throw invalid(`${item} is not available to this agent`, itemForms, 400, catalogHint)
      const target = serviceItem(item)
      if (target && (!Object.hasOwn(services, target.id) || credentialOf(target.id) === undefined))
        throw refuse(
          item,
          Object.keys(services)
            .filter((id) => credentialOf(id) !== undefined)
            .flatMap((id) => [`${id}.read`, `${id}.full`]),
          'Services',
          'none',
        )
      if (kind === 'secret') {
        const names = Object.keys(ownerSecrets())
        if (!names.includes(item.slice('secret:'.length))) throw refuse(item, names, 'Secrets', 'none')
      }
      if (kind === 'ext' && !catalog?.extensions.some(({ id }) => `ext:${id}` === item))
        throw refuse(
          item,
          (catalog?.extensions ?? []).map(({ id }) => id),
          'Extensions',
          'none',
        )
      if (kind === 'mcp' && !catalog?.mcps.some(({ id }) => `mcp:${id}` === item))
        throw refuse(
          item,
          (catalog?.mcps ?? []).map(({ id }) => id),
          'MCP servers',
          'none',
        )
      const unknown = jump.unknownName(item)
      if (unknown)
        throw invalid(
          unknown,
          undefined,
          400,
          'Use the exact name your task or the owner gave you; read "Folders and SSH" in GET /_speaker/help',
        )
    }
    // An extension brings the sites it needs, so one approval covers both.
    const sites = items.flatMap((item) =>
      kindOf(item) === 'ext'
        ? (catalog?.extensions.find(({ id }) => `ext:${id}` === item)?.sites ?? []).map((host) => `site:${host}`)
        : [],
    )
    return union(items, sites)
  }
  // Granted items its sandbox host has not yet reported in force: they count as granted for the agent only once it has.
  const applying = (request: Request) =>
    request.grantIds.flatMap((id) => {
      const grant = grants.get(id)
      return grant && live(grant) && enforcementOf(grant) !== 'enforced' ? [grant.item] : []
    })
  // A request as the agent sees it: per-item outcome, and what to do next.
  const outcome = (c: Context, request: Request) => {
    const status = statusOf(request),
      granted = itemsWhere(request, 'granted'),
      denied = itemsWhere(request, 'denied')
    const retry = retryAfter(request.agentId, denied)
    const waiting = applying(request)
    return {
      id: request.id,
      status,
      granted: granted.filter((item) => !waiting.includes(item)),
      denied,
      ...(waiting.length ? { applying: waiting } : {}),
      ...(granted.length ? { expiresAt: request.expiresAt ? new Date(request.expiresAt).toISOString() : null } : {}),
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
    let items: string[]
    try {
      items = resolveItems(input.want, agent)
      // A newer key replaces the older one.
      if (input.sshKey) {
        agent.sshKey = input.sshKey
        syncJump()
      }
      // A folder the agent's sandbox mounts needs no key (and Pi cannot send one); every other ssh: or folder: item does.
      if (
        !agent.sshKey &&
        items.some((item) => ['ssh', 'folder'].includes(kindOf(item) ?? '') && !jump.mounted(agent.id, item))
      )
        throw invalid(
          'ssh: and folder: items need "sshKey": one throwaway public key of yours (ssh-ed25519 …)',
          undefined,
          400,
          'Send "sshKey"; read "Folders and SSH" in GET /_speaker/help',
        )
    } catch (error) {
      // Turned away before the owner saw anything: the owner's page counts it.
      if (error instanceof HTTPException) tally(agent, 'refused', error.message)
      throw error
    }
    const request = createRequest(agent, items, input.want, input.reason, input.duration)
    // `mcp:` and `ext:` take effect when Pi is idle, which this held call prevents, so only the others are waited for.
    await hold(
      c,
      () =>
        statusOf(request) !== 'pending' &&
        !applying(request).some((item) => !['mcp', 'ext'].includes(kindOf(item) ?? '')),
    )
    return outcome(c, request)
  }
  // Enrollment and registration are unauthenticated: one shared budget caps how many identities anyone can create.
  // Behind a reverse proxy every client shares one address anyway, so a per-address key would add nothing.
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
  app.get('/_speaker/health', (c) => c.json({ ok: true }))
  // The proxy's public certificate: agents trust it for the hosts of their secrets.
  if (config.PROXY_PORT)
    app.get('/_speaker/proxy/ca.pem', locked, async (c) =>
      c.text((await certificateAuthority()).cert, 200, { 'content-type': 'application/x-pem-file' }),
    )
  // Public discovery: what speaker is and where the instructions are. Services and groups stay behind auth.
  const markdown = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'max-age=3600' }
  app.use('/skill.md', etag())
  app.use('/_speaker/help', etag())
  app.get('/skill.md', (c) => c.text(withAddress(c, skill), 200, markdown))
  app.get('/_speaker/help', (c) => c.text(withAddress(c, skill), 200, markdown))
  app.get('/', (c) =>
    c.req.header('accept')?.includes('text/html')
      ? c.html(
          '<!doctype html><meta charset="utf-8"><title>Speaker</title><p>Speaker gives AI agents owner-approved access to homelab APIs; agents never see the keys.</p><p>Owner: approve requests at <a href="/admin">/admin</a>.</p><p>Agents: <a href="/skill.md">/skill.md</a>.</p>',
        )
      : c.text(withAddress(c, skill), 200, markdown),
  )
  app.post('/_speaker/agents', locked, enrollmentLimit, async (c) => {
    const { tokenHash, want, reason, duration, sshKey, ...identity } = enrollSchema.parse(await c.req.json())
    let agent = agentByToken(tokenHash)
    // A revoked token stays dead; asking again means a new token, which reaches the owner as a new agent.
    if (agent?.status === 'revoked') return revokedReply(c)
    const source = sourceOf(c)
    if (agent && agent.source !== source)
      throw invalid('This token is already enrolled from another address. Make a new token and enroll again')
    const created = !agent
    if (!agent) {
      const enrolling: Agent = {
        id: rid(),
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
      agents.set(agent.id, agent)
      audit('agent_enrolled', { agent: agent.id, source })
    }
    const result = want.length ? await ask(c, agent, { want, reason: reason ?? '', duration, sshKey }) : undefined
    if (!result && sshKey) agent.sshKey = sshKey
    return c.json(
      { id: agent.id, ...(result ? { request: result } : { next: 'GET /_speaker/catalog' }) },
      created ? 201 : 200,
    )
  })
  app.post('/_speaker/hosts', locked, enrollmentLimit, async (c) => {
    const input = hostSchema.pick({ name: true, kinds: true, tokenHash: true }).parse(await c.req.json())
    const host: Host = { id: rid(), ...input, status: 'pending', source: sourceOf(c) }
    hosts.set(host.id, host)
    await saveHosts()
    audit('host_registered', { host: host.id, name: host.name })
    void notify(`Sandbox host ${host.name} wants to register`, `host-${host.id}`)
    // The ports let the sandbox host find the proxy and jump server without the owner copying them over.
    return c.json({ id: host.id, status: host.status, proxyPort: config.PROXY_PORT, sshPort: config.SSH_PORT }, 201)
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
          connections.get(id)?.ws.close(1000, 'replaced')
          connections.set(id, { ws, applied: new Set(), shares: [] })
          ws.send(JSON.stringify(snapshot(id)))
        },
        onMessage: (event, ws) => {
          const connection = connections.get(id)
          if (connection?.ws !== ws) return
          const message = z
            .discriminatedUnion('type', [
              z.object({ type: z.literal('applied'), grantIds: z.array(z.string()) }),
              z.object({
                type: z.literal('shares'),
                shares: z.array(z.object({ name: idSchema, mount: z.boolean() })),
              }),
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
                    sites: z.array(z.string().refine((host) => kindOf(`site:${host}`) === 'site', 'Not a site name')),
                  }),
                ),
              }),
            ])
            .parse(JSON.parse(String(event.data)))
          if (message.type === 'shares') {
            connection.shares = message.shares
            audit('host_shares', { host: id, shares: message.shares })
            push() // a share's delivery (VM mount or over SSH) follows this report
          } else if (message.type === 'catalog') {
            connection.catalog = { mcps: message.mcps, extensions: message.extensions }
            audit('host_catalog', { host: id, mcps: message.mcps.length, extensions: message.extensions.length })
          } else connection.applied = new Set(message.grantIds)
        },
        onClose: (_event, ws) => {
          if (connections.get(id)?.ws === ws) connections.delete(id)
        },
      }
    }),
  )
  // A sandbox host checking that speaker has approved it (the auth middleware has already refused unapproved ones).
  app.get('/_speaker/hosts/self', (c) => {
    const caller = c.get('caller')
    if (caller.role !== 'host') return agentError(c, 403, 'denied', 'This route is for sandbox host tokens')
    return c.json({ id: caller.host.id, name: caller.host.name, status: caller.host.status })
  })
  app.post('/_speaker/hosts/agents', async (c) => {
    const host = hostCaller(c)
    const identity = identitySchema.parse(await c.req.json())
    const token = randomBytes(32).toString('base64url')
    // The agent's token works only from the sandbox host's address, so a token leaked from a VM is useless elsewhere.
    const agent: Agent = {
      id: rid(),
      tokenHash: hash(token),
      status: 'enrolled',
      ...identity,
      source: sourceOf(c),
      host: host.id,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      uses: 0,
      lastUsedAt: null,
      counts: noCounts(),
    }
    agents.set(agent.id, agent)
    audit('agent_created', { agent: agent.id, host: host.id })
    return c.json({ id: agent.id, token }, 201)
  })
  app.delete('/_speaker/hosts/agents/:id', (c) => {
    const id = c.req.param('id')
    if (agentById(id)?.host !== hostCaller(c).id) throw invalid('Agent not found', undefined, 404)
    endAgent(id)
    return c.json({ ok: true })
  })
  // Per secret grant, everything the agent needs to use it through the proxy (the value is never shown).
  const secretsView = (c: Context, agent: Agent) => {
    const base = baseOf(c),
      ca = '${XDG_STATE_HOME:-$HOME/.local/state}/speaker/ca.pem'
    // The gh/git hint only makes sense for a secret that GitHub hosts accept.
    const gitHint = (hosts: string[]) =>
      hosts.some((host) => /(^|\.)github\.com$/.test(host))
        ? { git: 'Run `gh auth setup-git` once so git takes its credentials from gh.' }
        : {}
    const granted = new Map(secretGrants(agent.id).map((secret) => [secret.name, secret]))
    return Object.fromEntries(
      Object.entries(ownerSecrets()).map(([name, { hosts, env }]) => {
        const grant = granted.get(name)
        if (!grant) return [name, { hosts, env, state: 'ask' }]
        const { placeholder, until } = grant
        return [
          name,
          agent.host
            ? {
                hosts,
                env,
                state: 'granted',
                until,
                placeholder,
                environment: { [env]: placeholder },
                ...gitHint(hosts),
                note: "Set the variable on the command that needs it, for example GH_TOKEN=... gh pr list. You need no proxy settings or certificate: your sandbox sends requests to these hosts through speaker's proxy, which swaps the placeholder for the secret.",
              }
            : {
                hosts,
                env,
                state: 'granted',
                until,
                placeholder,
                environment: {
                  [env]: placeholder,
                  HTTPS_PROXY: `http://agent:<token>@${new URL(base).hostname}:${config.PROXY_PORT}`,
                  SSL_CERT_FILE: ca,
                },
                token: '<token> is the part after "Bearer " in your header file; do not print it',
                certificate: `Run once: curl -s ${base}/_speaker/proxy/ca.pem -o "${ca}". SSL_CERT_FILE is for gh. For git, set GIT_SSL_CAINFO to the same file, or run git config --global http.sslCAInfo "${ca}".`,
                ...gitHint(hosts),
                note: 'Set these only on the command that needs them, for example HTTPS_PROXY=... gh pr list. The proxy refuses every host except these.',
              },
        ]
      }),
    )
  }
  type Held = { state: string; until?: string | null }
  const heldText = ({ state, until }: Held) =>
    state === 'granted'
      ? until
        ? `Granted until ${until} (UTC).`
        : 'Granted, with no end.'
      : state === 'never'
        ? 'The owner never grants this.'
        : 'Not granted.'
  // The catalog as plain markdown for a weak model; the sandbox tool pastes it into its own description, so it names no
  // routes and assumes nothing else was read.
  function catalogText(input: {
    services: { id: string; mcp: boolean; read: Held; full: Held }[]
    secrets: Record<string, { hosts: string[]; env: string } & Held>
    groups: Record<string, { description?: string; items: string[]; also?: string }>
    sandboxed: boolean
    extensions: Record<string, { label: string; description: string; tools: string[]; sites: string[] } & Held>
    mcp: Record<string, { label: string; tools: string[] } & Held>
  }) {
    const section = (title: string, lines: string[]) => (lines.length ? ['', `${title}:`, ...lines] : [])
    const tools = (names: string[]) => (names.length ? ` Tools: ${names.join(', ')}.` : '')
    return [
      'Things you can ask the owner for, and where each stands now. Name them exactly as written.',
      ...section(
        'Services',
        input.services.map(
          ({ id, mcp, read, full }) =>
            `- ${id}.read — read${mcp ? ' (remote MCP server)' : ''}. ${heldText(read)} ${id}.full — read and change. ${heldText(full)}`,
        ),
      ),
      ...section(
        'Secrets (you use them without seeing them)',
        Object.entries(input.secrets).map(
          ([name, { hosts, env, ...held }]) =>
            `- secret:${name} — for ${hosts.join(', ')} (set ${env}). ${heldText(held)}`,
        ),
      ),
      ...section(
        'Websites',
        input.sandboxed ? ['- site:<any hostname> — any website; ask for the exact hostname.'] : [],
      ),
      ...section('Folders and SSH', [
        '- folder:<share> and ssh:<target> — names are not listed; use the exact name your task or the owner gave you.',
      ]),
      ...section(
        'Groups (one decision for several items)',
        Object.entries(input.groups).map(
          ([name, { description, items, also }]) =>
            `- group:${name} — ${description ? `${description}. ` : ''}Contains: ${[...items, ...(also ? [also] : [])].join(', ')}.`,
        ),
      ),
      ...section(
        'Extensions',
        Object.entries(input.extensions).map(
          ([id, { label, description, tools: names, sites, ...held }]) =>
            `- ext:${id} — ${label}: ${description}${tools(names)}${sites.length ? ` Needs sites: ${sites.join(', ')}.` : ''} ${heldText(held)}`,
        ),
      ),
      ...section(
        'MCP servers',
        Object.entries(input.mcp).map(
          ([id, { label, tools: names, ...held }]) => `- mcp:${id} — ${label}.${tools(names)} ${heldText(held)}`,
        ),
      ),
    ].join('\n')
  }
  // Everything an agent may ask for and where it stands. Open services, targets and shares are never listed.
  app.get('/_speaker/catalog', (c) => {
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
    const listed = Object.entries(services).filter(
      ([id, service]) => credentialOf(id) !== undefined && (service.read !== 'open' || coverFor(agent.id, id, false)),
    )
    const secrets = config.PROXY_PORT ? secretsView(c, agent) : {}
    const groupsView = Object.fromEntries(
      offered(agent).map(([name, group]) => {
        // Targets and shares are never named to agents, not even inside a group: only a count shows.
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
    )
    // The host's in-VM MCP servers and Pi extensions, each with this agent's state.
    const hostEntry = (item: string) => {
      const grant = mine.find((held) => held.item === item)
      return grant ? { state: 'granted', until: grant.expiresAt } : { state: 'ask' }
    }
    const reported = connections.get(agent.host ?? '')?.catalog
    const extensions = Object.fromEntries(
      (reported?.extensions ?? []).map(({ id, ...rest }) => [id, { ...rest, ...hostEntry(`ext:${id}`) }]),
    )
    const mcp = Object.fromEntries(
      (reported?.mcps ?? []).map(({ id, ...rest }) => [id, { ...rest, ...hostEntry(`mcp:${id}`) }]),
    )
    return c.json({
      agent: {
        id: agent.id,
        label: agent.label,
        agent: agent.agent,
        source: agent.source,
        kind: agent.host ? 'sandboxed' : 'direct',
        status: mine.length
          ? 'active'
          : [...requests.values()].some((r) => r.agentId === agent.id && statusOf(r) === 'pending')
            ? 'pending'
            : 'idle',
      },
      services: Object.fromEntries(
        listed.map(([id, service]) => [
          id,
          { read: state(id, false), full: state(id, true), ...(service.mcp ? { mcp: true } : {}) },
        ]),
      ),
      grants: mine.map((grant) => ({
        item: grant.item,
        expiresAt: grant.expiresAt,
        ...(enforcementOf(grant) === 'enforced' ? {} : { applying: true }),
      })),
      secrets,
      ...(agent.host ? { extensions, mcp } : {}),
      // Complete command lines for the agent's SSH and folder grants.
      ssh: jump.commands(agent.id, new URL(baseOf(c)).hostname.replace(/^\[|\]$/g, '')),
      groups: groupsView,
      requests: [...requests.values()]
        .filter((request) => request.agentId === agent.id)
        .map((request) => ({
          ...outcome(c, request),
          want: request.want,
          reason: request.reason,
        })),
      text: catalogText({
        services: listed.map(([id, service]) => ({
          id,
          mcp: Boolean(service.mcp),
          read: state(id, false),
          full: state(id, true),
        })),
        secrets,
        groups: groupsView,
        sandboxed: Boolean(agent.host),
        extensions,
        mcp,
      }),
    })
  })
  app.post('/_speaker/requests', async (c) => {
    const caller = c.get('caller')
    const input = requestSchema.extend({ agentId: idSchema.optional() }).parse(await c.req.json())
    let agent: Agent | undefined
    if (caller.role === 'host') {
      agent = input.agentId ? agentById(input.agentId) : undefined
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
      if (rule === 'never') return 'never granted by the owner. Do not ask for it.'
      const grant = coverFor(agent.id, name, write)
      return grant
        ? `granted ${until(grant.expiresAt)}.`
        : `needs \`${name}.${write ? 'full' : 'read'}\`; not granted yet.`
    }
    const lines = [
      `# ${name}`,
      '',
      `- Call \`${baseOf(c)}/${name}/<path>\` with your header file. Speaker sends \`<path>\` to the service's API root and adds the real credential. Send no other credentials.`,
      `- Read (GET, HEAD, OPTIONS${service.readPaths?.length ? `, POST to ${service.readPaths.join(', ')}` : ''}): ${access(false)}`,
      `- Everything else (\`${name}.full\`): ${access(true)}`,
      '- Without access, add `Speaker-Wait: 60` (and `Speaker-Reason: <one sentence>`). Speaker asks the owner and answers the call once they decide. Without that header, the call answers at once. `denied` is final.',
      ...(service.mcp
        ? [
            `- MCP server (streamable HTTP) at \`${baseOf(c)}/${name}\`. Listing tools and read-only tools count as read. Other tool calls need full.`,
          ]
        : []),
      service.notes
        ? `\n${service.notes.trim()}`
        : '- No notes for this service. Use the upstream API documentation for paths.',
    ]
    return c.text(`${lines.join('\n')}\n`, 200, { 'content-type': 'text/markdown; charset=utf-8' })
  })
  app.all('/_speaker/*', (c) =>
    agentError(c, 404, 'not_found', 'Unknown route', { next: 'Read "Asking" in GET /_speaker/help' }),
  )
  app.all('*', async (c) => {
    const incoming = new URL(c.req.url),
      [serviceId, ...parts] = incoming.pathname.slice(1).split('/')
    if (!Object.hasOwn(services, serviceId))
      return agentError(c, 404, 'not_found', 'Unknown service', { next: 'GET /_speaker/catalog' })
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
        return agentError(c, 413, 'invalid', 'MCP body too large', { next: 'Send a smaller MCP request' })
      const text = await c.req.text()
      if (Buffer.byteLength(text) > 1_048_576)
        return agentError(c, 413, 'invalid', 'MCP body too large', { next: 'Send a smaller MCP request' })
      body = text
      ;({ write, detail } = await mcpAccess(serviceId, text))
    }
    const item = `${serviceId}.${write ? 'full' : 'read'}`
    const rule = write ? service.write : service.read
    if (rule === 'never') {
      tally(agent, 'blocked', `${method} ${serviceId}: the owner blocks ${item}`)
      return agentError(c, 403, 'denied', `The owner blocks ${item}`, {
        item,
        next: 'Stop: the owner blocks this; do not request it.',
      })
    }
    const secret = credentialOf(serviceId)
    if (secret === undefined)
      return agentError(c, 503, 'no_key', `${serviceId} has no key configured yet`, {
        tell_user: `The owner adds a key for ${serviceId} at ${baseOf(c)}/admin?section=services`,
      })
    if (rule === 'ask' && !coverFor(agent.id, serviceId, write)) {
      const until = lockedUntil(agent.id, item)
      if (until !== undefined) {
        tally(
          agent,
          'blocked',
          `${method} ${serviceId}: ${item} denied by the owner, locked until ${new Date(until).toISOString()}`,
        )
        return agentError(c, 403, 'denied', `The owner denied ${item}`, {
          item,
          next: 'Stop: the owner denied this request.',
          retry_after: new Date(until).toISOString(),
        })
      }
      // A call files a request for exactly the item its method implies.
      const request = createRequest(
        agent,
        [item],
        [item],
        c.req.header('speaker-reason')?.trim().slice(0, 500) ?? '',
        '2h',
        `${method} ${detail ? `${path} · ${detail}` : path}`,
      )
      await hold(c, () => statusOf(request) !== 'pending')
      if (!coverFor(agent.id, serviceId, write)) {
        tally(agent, 'blocked', `${method} ${serviceId}: no grant for ${item}`)
        if (statusOf(request) === 'decided')
          return agentError(c, 403, 'denied', `The owner denied ${item}`, {
            item,
            request: request.id,
            next: 'Stop: the owner denied this request.',
          })
        return agentError(c, 403, 'approval_required', `${item} needs the owner's approval`, {
          item,
          request: request.id,
          next: 'Repeat this call with Speaker-Wait: 60 (and Speaker-Reason: <one sentence>)',
          tell_user: tellUser(c, `request-${request.id}`),
        })
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
    if (!upstream)
      return agentError(c, 502, 'upstream_unavailable', `${serviceId} did not answer`, {
        next: 'Try again shortly; if it keeps failing, tell the user',
      })
    const responseHeaders = new Headers(upstream.headers)
    for (const name of [...hopHeaders, 'content-encoding', 'content-length']) responseHeaders.delete(name)
    const location = responseHeaders.get('location')
    if (service.auth.type === 'path' && location?.includes(secret))
      responseHeaders.set('location', location.replaceAll(secret, '<redacted>'))
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  })
}
