import type { Context } from 'hono'
import { type Agent, type Core, type Group, plural } from './core.ts'
import type { Request } from './engine.ts'
import { kindOf } from './items.ts'

// What an agent sees of its own standing: GET /_speaker/catalog, as JSON and as plain markdown.

// Per secret grant, everything the agent needs to use it through the proxy (the value is never shown).
const secretsView = (core: Core, c: Context, agent: Agent) => {
  const { config, baseOf, ownerSecrets, secretGrants } = core
  const base = baseOf(c),
    ca = '${XDG_STATE_HOME:-$HOME/.local/state}/speaker/ca.pem'
  // The gh/git hint only makes sense for a secret that GitHub hosts accept.
  const gitHint = (hosts: string[]) =>
    hosts.some((host) => /(^|\.)github\.com$/.test(host))
      ? { git: 'Run `gh auth setup-git` once so git takes its credentials from gh.' }
      : {}
  const granted = new Map(secretGrants(agent.id).map((secret) => [secret.name, secret]))
  return Object.fromEntries(
    Object.entries(ownerSecrets()).map(([name, { hosts, env, release }]) => {
      const grant = granted.get(name)
      if (release)
        return [
          name,
          grant
            ? { release, state: 'granted', until: grant.until, read: `GET ${base}/_speaker/secrets/${name}` }
            : { release, state: 'ask' },
        ]
      if (!grant) return [name, { hosts, env, state: 'ask' }]
      const { placeholder, until } = grant
      return [
        name,
        agent.host
          ? {
              hosts,
              state: 'granted',
              until,
              environment: { [env]: placeholder },
              ...gitHint(hosts),
              note: "Set the variable on the command that needs it, for example GH_TOKEN=... gh pr list. You need no proxy settings or certificate: your sandbox sends requests to these hosts through speaker's proxy, which swaps the placeholder for the secret.",
            }
          : {
              hosts,
              state: 'granted',
              until,
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
  secrets: Record<string, { hosts?: string[]; env?: string; release?: boolean; read?: string } & Held>
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
      'Secrets (you use them without seeing them, except a released one)',
      Object.entries(input.secrets).map(([name, { hosts, env, release, read, ...held }]) =>
        release
          ? `- secret:${name} — released: once granted you read the value yourself${read ? ` with ${read}` : ''}. ${heldText(held)}`
          : `- secret:${name} — for ${hosts?.join(', ')} (set ${env}). ${heldText(held)}`,
      ),
    ),
    ...section('Websites', input.sandboxed ? ['- site:<any hostname> — any website; ask for the exact hostname.'] : []),
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

// Everything an agent may ask for and where it stands. Open services, targets and shares are never listed.
export function catalogView(
  core: Core,
  c: Context,
  agent: Agent,
  offeredGroups: [string, Group][],
  outcome: (request: Request) => object,
) {
  const { services, engine, connections, jump, credentialOf, coverFor, enforcementOf, baseOf } = core
  const mine = engine.grants(agent.id)
  const requests = [...engine.requests.values()].filter((request) => request.subject === agent.id)
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
  const secrets = secretsView(core, c, agent)
  const groupsView = Object.fromEntries(
    offeredGroups.map(([name, group]) => {
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
  return {
    agent: {
      id: agent.id,
      label: agent.label,
      agent: agent.agent,
      source: agent.source,
      kind: agent.host ? 'sandboxed' : 'direct',
      status: mine.length ? 'active' : requests.some((r) => engine.statusOf(r) === 'pending') ? 'pending' : 'idle',
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
    requests: requests.map((request) => ({ ...outcome(request), want: request.want, reason: request.reason })),
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
  }
}
