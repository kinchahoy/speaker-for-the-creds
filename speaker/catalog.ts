import type { Context } from 'hono'
import { type Agent, type Core, type Group, plural } from './core.ts'
import type { Request } from './engine.ts'
import { kindOf } from './items.ts'

// What an agent sees of its own standing: GET /_speaker/catalog, as JSON.

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
              certificate: `Run once: curl -s ${base}/_speaker/proxy/ca.pem -o "${ca}". SSL_CERT_FILE is for gh. For git, set GIT_SSL_CAINFO to the same file, or run git config --global http.sslCAInfo "${ca}".`,
              ...gitHint(hosts),
            },
      ]
    }),
  )
}

// The services an agent sees: those with a key, unless open and not held. Their names are all it can learn of a service.
export const visibleServices = ({ services, credentialOf, coverFor }: Core, agent: Agent) =>
  Object.entries(services).filter(
    ([id, service]) => credentialOf(id) !== undefined && (service.read !== 'open' || coverFor(agent.id, id, false)),
  )

// Everything an agent may ask for and where it stands. Open services, targets and shares are never listed.
export function catalogView(
  core: Core,
  c: Context,
  agent: Agent,
  offeredGroups: [string, Group][],
  outcome: (request: Request) => object,
) {
  const { services, engine, connections, jump, coverFor, enforcementOf, baseOf } = core
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
  const listed = visibleServices(core, agent)
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
  }
}
