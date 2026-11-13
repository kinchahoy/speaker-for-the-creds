// The owner's pages: Hono's html templates styled by Pico's classless CSS, with htmx for live panels, confirmations
// and form posts. The Inbox and Active panels poll every 5 seconds and are replaced only when their content changed.
import { createHash } from 'node:crypto'
import { html, raw } from 'hono/html'
import type { Group, LogEntry, Service, View } from './core.ts'
import type { SshSetup } from './jump.ts'
import type { OwnerSecret } from './store.ts'

type Html = ReturnType<typeof html>
type Owned = Record<string, Pick<OwnerSecret, 'hosts' | 'env'>>
export type McpSummary = Record<string, { read: number; write: number; unannotated: number }>
export type Setup = {
  services: Record<string, Service>
  secrets: Map<string, string>
  owned: Owned
  groups: Record<string, Group>
  ssh: SshSetup
  mcp: McpSummary
  selected?: string
  error?: string
}

const css = `
main{max-width:1100px}nav a[aria-current]{font-weight:700;text-decoration:underline}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:1rem;align-items:start}
article{margin:0}article>header>small{display:block}
fieldset label{display:flex;gap:.5rem;align-items:flex-start;padding:.25rem .5rem;border-radius:.25rem}label.risky{background:var(--pico-mark-background-color)}
fieldset input[type=checkbox],fieldset input[type=checkbox]:checked{appearance:auto;background:none;flex:none;width:1.1rem;height:1.1rem;margin:.15rem 0 0;accent-color:var(--pico-primary)}
button.secondary{background:transparent;color:var(--pico-muted-color);border-color:var(--pico-muted-border-color)}
button.deny{background:transparent;color:var(--pico-del-color);border-color:var(--pico-del-color)}
.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.actions form,.actions button{margin:0;width:auto}
ul.rows{padding:0}ul.rows>li{list-style:none;border-top:1px solid var(--pico-muted-border-color);padding:.5rem 0}
.warn{color:var(--pico-del-color)}small{color:var(--pico-muted-color)}
`
// The page's only script (htmx is loaded without eval): a ticked group box ticks its members; the filter bar hides
// cards and rows by kind and text; times show in the viewer's zone, with a live countdown where data-left is set.
// Filtering and times are re-applied after every swap and then every second.
const pageScript = `document.addEventListener('change', (e) => {
  if (e.target.matches('[data-all]')) e.target.closest('fieldset').querySelectorAll('input[name=items]').forEach((i) => { i.checked = e.target.checked })
})
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })
const units = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]
const tick = () => {
  const kind = document.querySelector('[name=kind]:checked')?.value
  const q = document.querySelector('[name=q]')?.value.toLowerCase() ?? ''
  document.querySelectorAll('[data-kind]').forEach((el) => {
    el.hidden = !((!kind || el.dataset.kind.split(' ').includes(kind)) && el.textContent.toLowerCase().includes(q))
  })
  document.querySelectorAll('time[data-local]').forEach((t) => {
    const at = new Date(t.dateTime)
    const secs = Math.max(0, Math.round((at - Date.now()) / 1000))
    const [unit, size] = units.find(([, size]) => secs >= size) ?? units[3]
    t.textContent = at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ('left' in t.dataset ? ' (' + rtf.format(Math.floor(secs / size), unit).replace(/^in /, '') + ' left)' : '')
  })
}
document.addEventListener('input', tick)
document.addEventListener('htmx:afterSwap', tick)
document.addEventListener('DOMContentLoaded', tick)
setInterval(tick, 1000)`
const htmxConfig = JSON.stringify({
  includeIndicatorStyles: false,
  allowEval: false,
  allowScriptTags: false,
  // Every answer is shown (a refused form shows its message) except 204, which means the panel is unchanged.
  responseHandling: [
    { code: '204', swap: false },
    { code: '.*', swap: true },
  ],
})
const head = (nonce = '') =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="htmx-config" content="${htmxConfig}"><title>Speaker</title><link rel="stylesheet" href="/admin/assets/pico.css"><style>${raw(css)}</style><script src="/admin/assets/htmx.js"></script><script nonce="${nonce}">${raw(pageScript)}</script></head>`

const sections = [
  ['approvals', 'Inbox', '/admin'],
  ['active', 'Active', '/admin?section=active'],
  ['services', 'Setup', '/admin?section=services'],
  ['log', 'Log', '/admin/log'],
] as const
export type Section = (typeof sections)[number][0]
const kinds = {
  service: 'services',
  site: 'sites',
  secret: 'secrets',
  folder: 'folders',
  ssh: 'SSH',
  mcp: 'MCP',
  ext: 'extensions',
}
// Kind chips and a text box that narrow the cards and rows of the live panels (see pageScript).
const filterBar = html`<div class="actions" role="search"><label><input type="radio" name="kind" value="" checked>all</label>${Object.entries(kinds).map(([k, text]) => html`<label><input type="radio" name="kind" value="${k}">${text}</label>`)}<input type="text" name="q" placeholder="Search" aria-label="Search"></div>`
export const layout = (nonce: string | undefined, section: Section, body: Html | string) =>
  html`${head(nonce)}<body hx-boost="true"><header><nav><ul><li><strong>Speaker</strong></li></ul><ul>${sections.map(
    ([id, label, href]) =>
      html`<li><a href="${href}" ${raw(id === section ? 'aria-current="page"' : '')}>${label}</a></li>`,
  )}</ul></nav></header><main>${section === 'approvals' || section === 'active' ? filterBar : ''}${typeof body === 'string' ? raw(body) : body}</main></body></html>`

// Sign-in and first-run pages: just one form.
const authPage = (
  heading: string,
  intro: string,
  fields: Html,
  button: string,
  action: string,
  exposed: boolean,
  error?: string,
) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Speaker</title><link rel="stylesheet" href="/admin/assets/pico.css"></head><body><main><article><h2>${heading}</h2><p>${intro}</p>${exposed ? html`<p class="warn" role="note">This page uses plain HTTP, so your password crosses the network unencrypted.</p>` : ''}${error ? html`<p class="warn" role="alert">${error}</p>` : ''}<form method="post" action="${action}">${fields}<button>${button}</button></form></article></main></body></html>`
const password = (name: string, label: string, autocomplete: string) =>
  html`<label>${label}<input name="${name}" type="password" autocomplete="${autocomplete}" required></label>`
export const signInPage = (exposed: boolean, error?: string) =>
  authPage(
    'Sign in',
    'Signing in unlocks the keys speaker stores.',
    password('password', 'Owner password', 'current-password'),
    'Sign in',
    '/admin/signin',
    exposed,
    error,
  )
export const setPasswordPage = (exposed: boolean, error?: string) =>
  authPage(
    'Set the owner password',
    'It protects every key speaker stores, and you sign in with it after each restart. Use at least 8 characters.',
    html`${password('password', 'Owner password', 'new-password')}${password('confirm', 'Repeat the password', 'new-password')}`,
    'Set password',
    '/admin/setup',
    exposed,
    error,
  )

const labels: Record<string, string> = {
  permanent: 'Until revoked',
  none: 'None (keyless)',
  ask: 'Ask the owner',
  open: 'Open (any agent may read)',
  never: 'Never',
  vm: 'VM mount',
  ssh: 'Over SSH',
  both: 'VM mount or over SSH',
}
const hidden = (name: string, value: string) => html`<input name="${name}" type="hidden" value="${value}">`
const input = (name: string, label: string, type = 'text', value = '') =>
  html`<label>${label}<input name="${name}" type="${type}" value="${value}" ${raw(type === 'password' ? 'autocomplete="new-password"' : '')}></label>`
const select = (name: string, label: string, values: readonly string[], chosen = '') =>
  html`<label>${label}<select name="${name}">${values.map((value) => html`<option value="${value}" ${raw(value === chosen ? 'selected' : '')}>${labels[value] ?? value}</option>`)}</select></label>`
const area = (name: string, label: string, value = '', rows = 2) =>
  html`<label>${label}<textarea name="${name}" rows="${rows}">${value}</textarea></label>`
// One button posting `fields`; with `confirm`, htmx asks first.
const button = (action: string, fields: Html | string, label: string, confirm = '', kind = 'secondary') =>
  html`<form method="post" action="${action}" ${raw(confirm ? `hx-confirm="${String(html`${confirm}`)}"` : '')}>${fields}<button class="${kind}">${label}</button></form>`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
// A time the page rewrites into the viewer's zone (UTC until the script runs); `countdown` adds the time left.
const local = (ms: number, countdown = false) =>
  html`<time datetime="${new Date(ms).toISOString()}" data-local ${raw(countdown ? 'data-left' : '')}>${time(ms)} UTC</time>`
const kindOf = (item: string) => (item.includes(':') ? item.split(':')[0] : 'service')
// Items that can change things (or reach out with a credential) are tinted on the card.
const risky = (item: string) => /^(ssh|secret):|\.full$|^folder:.+:rw$/.test(item)
const empty = (text: string) => html`<p><small>${text}</small></p>`

// A live panel: htmx asks again every 5 seconds with the hash of what it shows; an unchanged panel answers 204.
// Request cards are hx-preserve: a refresh keeps the cards still pending as they are, so unticked items and a chosen duration stay.
const digest = (inner: string) => createHash('sha256').update(inner).digest('hex').slice(0, 16)
export const live = (id: string, inner: string) =>
  `<section id="${id}" hx-get="/admin/panel/${id}?h=${digest(inner)}" hx-trigger="every 5s" hx-swap="outerHTML">${inner}</section>`
export const unchanged = (inner: string, hash?: string) => hash === digest(inner)

// --- Inbox: sandbox hosts waiting to register and access requests, one card each ---
export function inbox({ hosts, agents, requests, details }: View, groups: Record<string, Group>, owned: Owned) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  // An agent whose identity (same label and agent string) enrolled in the 30 minutes before it.
  const twin = (a: View['agents'][number]) => {
    const earlier = agents.filter(
      (o) =>
        o.id !== a.id &&
        o.label === a.label &&
        o.agent === a.agent &&
        a.createdAt - o.createdAt > 0 &&
        a.createdAt - o.createdAt < 1_800_000,
    )
    return earlier.length
      ? html` <mark>same agent enrolled ${Math.round((a.createdAt - Math.max(...earlier.map((o) => o.createdAt))) / 60_000)} min earlier</mark>`
      : ''
  }
  // A secret's row names the hosts its value will be sent to: granting it opens those hosts.
  const sentTo = (item: string) => {
    const name = item.slice('secret:'.length)
    return Object.hasOwn(owned, name)
      ? ` · sent to ${owned[name].hosts.join(', ')}`
      : ' · not set up: it will do nothing'
  }
  const pick = (agentId: string, item: string) => {
    const detail = details[`${agentId} ${item}`]
    return html`<label class="${risky(item) ? 'risky' : ''}"><input type="checkbox" name="items" value="${item}" checked><span><code>${item}</code> <small>${detail ? detail.text : kindOf(item)}${item.startsWith('secret:') ? sentTo(item) : ''}</small>${detail?.warning ? html` <mark>${detail.warning}</mark>` : ''}</span></label>`
  }
  const hostCards = hosts
    .filter((h) => h.status === 'pending')
    .map(
      (h) =>
        html`<article id="host-${h.id}"><header><strong>Sandbox host ${h.name}</strong> <small>wants to register</small></header><p>Approving lets this sandbox host create agents and enforce grants for ${h.kinds.join(', ') || 'no item kinds'}.</p><form method="post" action="/admin/hosts/${h.id}/approve" class="actions"><button>Approve</button><button class="deny" formaction="/admin/hosts/${h.id}/remove">Deny</button></form></article>`,
    )
  const requestCards = requests
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => {
      const agent = byId.get(r.agentId)
      const label = agent?.label ?? 'Unknown agent'
      // The groups the request asked for, each with the members still pending, then the items asked for on their own.
      const asked = r.want
        .filter((w) => w.startsWith('group:') && Object.hasOwn(groups, w.slice(6)))
        .map((w) => ({
          name: w.slice(6),
          ...groups[w.slice(6)],
          members: groups[w.slice(6)].items.filter((i) => r.items.includes(i)),
        }))
        .filter((g) => g.members.length)
      const loose = r.items.filter((item) => !asked.some((g) => g.members.includes(item)))
      const notice = {
        disabled: '',
        sending: 'Sending phone notification…',
        sent: 'Phone notification sent',
        failed: 'Phone notification failed. Access stays locked.',
      }[r.notification]
      return html`<article id="request-${r.id}" hx-preserve data-kind="${[...new Set(r.items.map(kindOf))].join(' ')}"><header><strong>${label}</strong>${agent ? html`<small>says it is ${agent.agent}${agent.sandboxHost ? ` · via ${agent.sandboxHost}` : ''}</small><small>from ${agent.source} · key ${agent.tokenHash.slice(0, 8)}${twin(agent)}</small>` : ''}<small>asked ${local(r.createdAt)}</small></header><p><small>Reason:</small> ${r.reason || html`<small>none supplied yet</small>`}</p><form method="post" action="/admin/requests/${r.id}/approve">${r.items.map((item) => hidden('shown', item))}${asked.map(
        (g) =>
          html`<fieldset><legend><label><input type="checkbox" data-all checked><strong>${g.name}</strong> <small>${g.description ? `${g.description} · ` : ''}${plural(g.members.length, 'item', 'items')}</small></label></legend>${g.members.map((item) => pick(r.agentId, item))}</fieldset>`,
      )}${loose.length ? html`<fieldset>${asked.length ? html`<legend>Not in a group</legend>` : ''}${loose.map((item) => pick(r.agentId, item))}</fieldset>` : ''}${select('duration', 'Allow access for', ['30m', '1h', '2h', '1d', '30d', 'permanent'], r.duration)}<div class="actions"><button>Approve</button><button class="deny" formaction="/admin/requests/${r.id}/deny">Deny</button></div></form>${r.trigger || notice ? html`<footer><small>${r.trigger ? html`Triggered by <code>${r.trigger}</code> ` : ''}${notice}</small></footer>` : ''}</article>`
    })
  const cards = [...hostCards, ...requestCards]
  return String(
    html`<h2>Inbox${cards.length ? ` (${cards.length} pending)` : ''}</h2>${cards.length ? html`<div class="cards">${cards}</div>` : empty('Nothing to approve. New requests appear here as soon as an agent asks for access.')}`,
  )
}

// --- Active: agents with their grants and open SSH sessions, and the approved sandbox hosts ---
const chips = { active: '', granted: 'granted, not yet applied', waiting: 'waiting for sandbox host' }
const uses = (n: number, query: string) =>
  n ? html`<a href="/admin/log?${query}">${plural(n, 'use', 'uses')}</a>` : 'unused'
// One line of counts: what the agent asked, what was decided, and what speaker turned away (warned when non-zero).
const tallies = ({ counts: c }: View['agents'][number]) => {
  const warn = (n: number, word: string) => (n ? html`<span class="warn">${n} ${word}</span>` : `${n} ${word}`)
  return html`<br><small title="${c.lastRefusal ?? ''}">${c.requests} ${c.requests === 1 ? 'request' : 'requests'} · ${c.granted} granted · ${c.denied} denied · ${warn(c.refused, 'refused')} · ${warn(c.blocked, 'blocked')}</small>`
}
const span = (ms: number) =>
  ms % 86_400_000 === 0
    ? `${ms / 86_400_000}d`
    : ms % 3_600_000 === 0
      ? `${ms / 3_600_000}h`
      : `${Math.round(ms / 60_000)}m`
export function active({ hosts, agents, grants, sessions, details }: View) {
  const end = (g: { expiresAt: string | null }) => (g.expiresAt ? Date.parse(g.expiresAt) : Number.POSITIVE_INFINITY)
  const soonest = (id: string) => Math.min(Number.POSITIVE_INFINITY, ...grants.filter((g) => g.agentId === id).map(end))
  const grantRow = (g: View['grants'][number]) => {
    const detail = details[`${g.agentId} ${g.item}`]
    return html`<li id="grant-${g.id}" data-kind="${kindOf(g.item)}"><code>${g.item}</code> ${detail ? html`<small>${detail.text}</small>${detail.warning ? html` <mark>${detail.warning}</mark>` : ''}` : ''}<br><small>${g.expiresAt === null ? html`<mark>Until revoked</mark>` : html`expires ${local(Date.parse(g.expiresAt), true)}`}${chips[g.state] ? html` · <mark data-state="${g.state}">${chips[g.state]}</mark>` : ''}${kindOf(g.item) === 'service' ? html` · ${uses(g.uses, `grant=${encodeURIComponent(g.id)}`)}` : ''}</small><div class="actions">${g.expiresAt !== null && g.grantedMs !== undefined ? button('/admin/grants/extend', hidden('id', g.id), `Extend ${span(g.grantedMs)}`) : ''}${button('/admin/grants/revoke', hidden('id', g.id), 'Revoke', `Revoke ${g.item} for ${g.label}? Calls using it are blocked immediately.`)}</div></li>`
  }
  const blocks = [...agents]
    .sort((a, b) => soonest(a.id) - soonest(b.id))
    .map((a) => {
      const mine = grants.filter((g) => g.agentId === a.id).sort((x, y) => end(x) - end(y))
      const open = sessions.filter((s) => s.agent === a.id)
      return html`<article id="agent-${a.id}" data-kind="${[...new Set([...mine.map((g) => kindOf(g.item)), ...open.map(() => 'ssh')])].join(' ')}"><header class="actions"><span><strong>${a.label}</strong> <small>${a.agent}${a.sandboxHost ? ` · via ${a.sandboxHost}` : ''} · ${uses(a.uses, `agent=${encodeURIComponent(a.id)}`)}${a.lastUsedAt ? html` · last used ${local(a.lastUsedAt)}` : ''}</small>${tallies(a)}</span>${button(`/admin/agents/${a.id}/revoke`, '', 'Revoke agent', `Revoke agent ${a.label}? Its token and all its grants end immediately.`)}</header><ul class="rows">${mine.map(grantRow)}${open.map((s) => html`<li data-kind="ssh"><code>${s.what}</code> <small>SSH session open since ${local(s.started)}</small>${button('/admin/ssh/sessions/end', hidden('id', s.id), 'End', `End this SSH session now? ${s.what}`)}</li>`)}</ul></article>`
    })
  const hostBlocks = hosts
    .filter((h) => h.status === 'approved')
    .map(
      (h) =>
        html`<article><header class="actions"><span><strong>Sandbox host ${h.name}</strong> <small>${h.kinds.join(', ') || 'no item kinds'}${h.shares.length ? ` · shares: ${h.shares.map((s) => `${s.name} (${s.mount ? 'VM mount' : 'no VM mount'})`).join(', ')}` : ''}</small></span>${button(`/admin/hosts/${h.id}/remove`, '', 'Remove', `Remove sandbox host ${h.name}? Its agents and their grants end immediately.`)}</header></article>`,
    )
  return String(
    html`<h2>Active ${grants.length ? html`<small>${plural(grants.length, 'grant', 'grants')}</small>` : ''}</h2>${blocks.length || hostBlocks.length ? html`<div class="cards">${[...blocks, ...hostBlocks]}</div>` : empty('Nothing active. Agents and the access you granted are listed here until they expire or you revoke them.')}<p><small>Expiry and revocation block new calls; a response already streaming may finish.</small></p>`,
  )
}

// --- Setup: services, secrets, groups, SSH targets and shares, the owner password ---
const groupErrors: Record<string, string> = {
  empty: 'Group not saved: list at least one item, one per line.',
  line: 'Group not saved: each line must be an item: <service>.read, <service>.full, site:<host>, secret:<NAME>, ssh:<target>, folder:<share>[:rw], mcp:<id> or ext:<id>.',
  id: 'Group not saved: the id may use letters, numbers, - and _ (up to 64 characters).',
  description: 'Group not saved: keep the description to one line of at most 200 characters.',
}
export function setup({ services, secrets, owned, groups, ssh, mcp, selected, error }: Setup) {
  const chosen = selected && Object.hasOwn(services, selected) ? services[selected] : undefined
  const serviceForm = html`<form method="post" action="/admin/services/save">${input('id', 'Service id', 'text', chosen ? selected : '')}${input('baseUrl', 'Upstream base URL', 'url', chosen?.baseUrl)}${select('authType', 'Authentication (path = secret is a URL segment, e.g. a webhook id; none = keyless service)', ['bearer', 'header', 'basic', 'path', 'none'], chosen?.auth.type ?? 'bearer')}${input('headerName', 'Credential header', 'text', chosen?.auth.type === 'header' ? chosen.auth.headerName : '')}${input('secret', 'Credential (blank keeps current)', 'password')}${select('read', 'Read rule (GET / HEAD / OPTIONS)', ['ask', 'open', 'never'], chosen?.read ?? 'ask')}${select('write', 'Write rule (all other methods)', ['ask', 'never'], chosen?.write ?? 'ask')}${area('readPaths', 'POST paths that only read, one per line (for example a search endpoint)', chosen?.readPaths?.join('\n'))}<label><input type="checkbox" name="mcp" ${raw(chosen?.mcp ? 'checked' : '')}> MCP server (streamable HTTP): classify tool calls by their read-only hints</label>${area('notes', 'Notes for agents (markdown, optional)', chosen?.notes, 5)}<button>Save service</button></form>`
  const tools = (id: string) =>
    html`<div class="actions">${error === 'tools' ? html`<p class="warn" role="alert">Could not list tools; check the URL and credential.</p>` : ''}<small>${mcp[id] ? `Tools: ${mcp[id].read} read · ${mcp[id].write} write${mcp[id].unannotated ? ` (${mcp[id].unannotated} without hints, treated as write)` : ''}` : 'Tools not listed yet'}</small>${button('/admin/services/tools', hidden('id', id), 'Refresh tools')}</div>`
  const serviceRows = Object.entries(services).map(([id, s]) => {
    const keyed = s.auth.type === 'none' || secrets.get(id) !== undefined
    return html`<li><strong>${id}</strong> <code>${s.baseUrl}</code><br><small><span class="${keyed ? '' : 'warn'}">${s.auth.type === 'none' ? 'No credential' : `Credential: ${secrets.get(id) !== undefined ? 'configured' : 'missing'}`}</span> · read ${s.read} · write ${s.write} · notes ${s.notes ? 'yes' : 'no'}${s.mcp ? ' · MCP' : ''}${s.auth.type === 'path' ? ' · path secret' : ''}</small><div class="actions"><a href="/admin?section=services&amp;service=${encodeURIComponent(id)}">Edit</a><a href="/admin/log?service=${encodeURIComponent(id)}">Log</a>${button('/admin/services/delete', hidden('id', id), 'Delete', `Delete service ${id}? Its credential is erased and its grants and pending requests are removed.`)}</div></li>`
  })
  const secretRows = Object.entries(owned).map(
    ([name, { hosts, env }]) =>
      html`<li><strong>${name}</strong> <small>Agent sees <code>${env}</code> · sent only to ${hosts.join(', ')}</small>${button('/admin/secrets/delete', hidden('name', name), 'Delete', `Delete secret ${name}? Its value is erased.`)}</li>`,
  )
  const targets = Object.entries(ssh.targets)
  const sshPanel = !ssh.enabled
    ? html`<p><small>SSH and folders over SSH are off. Set <code>SSH_PORT</code> and restart speaker to turn them on.</small></p>`
    : html`${ssh.error ? html`<p class="warn" role="alert">${ssh.error}</p>` : ''}<p><small>Speaker's public key is <code>${ssh.publicKey ?? 'available after sign-in'}</code>. On each target, add <code>from="&lt;speaker's address&gt;",restrict &lt;that key&gt;</code> to the <code>authorized_keys</code> of the account speaker should use; a limited account (not root, no sudo) is best. Adding a target pins its host key, so add the line first.</small></p><ul class="rows">${targets.map(
        ([alias, t]) =>
          html`<li><strong>${alias}</strong> <small>${t.account}@${t.host}:${t.port}</small> ${t.sudo ? html`<mark>passwordless sudo works</mark> ` : ''}${t.account === 'root' ? html`<mark>root</mark> ` : ''}<br><small>${t.sftp ? html`sftp-server <code>${t.sftp}</code>` : html`<span class="warn">no sftp-server found: folders over SSH are unavailable</span>`} · host key <code>${t.fingerprint}</code> · authorized_keys line: <code>${t.line}</code></small><form method="post" action="/admin/ssh/targets/from" class="actions">${hidden('alias', alias)}${input('from', 'Addresses speaker connects from (comma-separated)', 'text', t.from)}<button class="secondary">Save addresses</button></form>${button('/admin/ssh/targets/delete', hidden('alias', alias), 'Delete', `Delete target ${alias}? Its shares go too, and open sessions and grants for them end.`)}</li>`,
      )}</ul><details><summary>Add a target</summary><form method="post" action="/admin/ssh/targets/add">${input('alias', 'Name agents ask for (ssh:NAME)')}${input('host', 'Host name or address')}${input('port', 'SSH port', 'number', '22')}${input('account', 'Account speaker uses there')}${input('from', 'Addresses speaker connects from (blank: detected)')}${input('sftp', 'sftp-server path (blank: probed)')}<label><input type="checkbox" name="confirmRoot"> I understand: root has no limits</label><button>Add target</button></form></details><h3>Shares</h3><ul class="rows">${Object.entries(
        ssh.shares,
      ).map(
        ([name, share]) =>
          html`<li><strong>${name}</strong> <small>${share.target}:${share.path} · ${labels[share.delivery]}</small>${ssh.targets[share.target]?.home === share.path ? html` <mark>home directory</mark>` : ''}${button('/admin/ssh/shares/delete', hidden('name', name), 'Delete', `Delete share ${name}? Open sessions and grants for it end.`)}</li>`,
      )}</ul><details><summary>Add a share</summary><form method="post" action="/admin/ssh/shares/save">${input('name', 'Name agents ask for (folder:NAME)')}${select(
        'target',
        'Target',
        targets.map(([alias]) => alias),
      )}${input('path', 'Absolute path on the target')}${select('delivery', 'Delivery', ['ssh', 'vm', 'both'], 'ssh')}<button>Save share</button></form></details>`
  const groupForm = (id: string, group: Group) =>
    html`<form method="post" action="/admin/groups/save">${input('id', 'Group id', 'text', id)}${input('description', 'Description (one line, optional)', 'text', group.description)}${area('items', 'Items, one per line', group.items.join('\n'), 5)}<button>Save group</button></form>`
  const groupRows = Object.entries(groups).map(
    ([id, group]) =>
      html`<li><strong>${id}</strong> ${group.description ? html`<small>${group.description}</small>` : ''}<br><small>${plural(group.items.length, 'item', 'items')}, granted together by one approval: ${group.items.join(', ')}</small><details><summary>Edit items</summary>${groupForm(id, group)}</details>${button('/admin/groups/delete', hidden('id', id), 'Delete', `Delete group ${id}? Agents can no longer request it. Existing grants stay.`)}</li>`,
  )
  return html`<h2>Services</h2>${chosen ? html`<article><h3>Edit service: ${selected}</h3>${serviceForm}${chosen.mcp ? tools(selected ?? '') : ''}</article>` : ''}<ul class="rows">${serviceRows.length ? serviceRows : empty('No services configured. Add a service to let agents request access to an upstream API.')}</ul>${chosen ? '' : html`<details><summary>Add service</summary>${serviceForm}</details>`}<h2>Secrets</h2><ul class="rows">${secretRows.length ? secretRows : empty('No secrets. A secret is a token speaker inserts into an agent’s requests to the hosts you allow; the agent never sees it.')}</ul><details><summary>Add or change a secret</summary><form method="post" action="/admin/secrets/save">${input('name', 'Name (agents ask for secret:NAME)')}${input('value', 'Value (never shown again; blank keeps the current one)', 'password')}${area('hosts', 'Allowed hosts, one per line')}${input('env', 'Environment variable the agent sees')}<button>Save secret</button></form></details><h2 id="groups">Groups</h2>${groupErrors[error ?? ''] ? html`<p class="warn" role="alert">${groupErrors[error ?? '']}</p>` : ''}<ul class="rows">${groupRows.length ? groupRows : empty('No groups. A group collects items so an agent can request them with one approval.')}</ul><details><summary>Add group</summary>${groupForm('', { items: [] })}</details><p><small>A group is what an agent may ask for; a bottle-school template sets the VM size and attended mode and names the group to request at launch. Changes apply to new requests; requests already pending keep their items.</small></p><h2>SSH targets</h2>${sshPanel}<h2>Owner password</h2><form method="post" action="/admin/password">${password('current', 'Current password', 'current-password')}${password('password', 'New password', 'new-password')}${password('confirm', 'Repeat the new password', 'new-password')}<button>Change password</button></form><p><small>Credentials stay on this server.</small></p>`
}

// --- Log: newest first, narrowed by the filters in the address ---
const s = (value: unknown) => String(value ?? '')
const what = (e: LogEntry) => {
  if (e.event === 'ssh_file') return html`<code>${s(e.op)} ${s(e.path)}</code> <small>${s(e.share ?? e.target)}</small>`
  if (e.event === 'ssh_session')
    return html`<code>${s(e.command ?? 'sftp')}</code> <small>${s(e.share ?? e.target)} · ${s(e.fingerprint)} · from ${s(e.source)}</small>`
  if (e.event === 'ssh_refused')
    return html`${e.command ? html`<code>${s(e.command)}</code> ` : ''}<small>${s(e.why)}</small>`
  if (e.event === 'request_unavailable') return html`<code>${s(e.item)}</code> <small>${s(e.why)}</small>`
  if (e.event === 'proxy')
    return html`<code>${s(e.method)} ${s(e.path)}</code> <small>${s(e.service)}${e.mcp ? ` · ${s(e.mcp)}` : ''}</small>`
  const list = [
    e.item,
    ...(Array.isArray(e.items) ? e.items : []),
    ...(Array.isArray(e.granted) ? e.granted : []),
  ].filter(Boolean)
  return html`<code>${list.join(', ')}</code>${e.reason ? html` <small>${s(e.reason)}</small>` : ''}`
}
const result = (e: LogEntry) =>
  e.event === 'ssh_session_end'
    ? `exit ${s(e.code)} · ${s(e.why)} · ${s(e.ms)}ms`
    : e.event === 'proxy'
      ? `${s(e.status)} · ${s(e.latencyMs)}ms · ${e.grant ? 'grant' : s(e.rule)}`
      : e.expiresAt === undefined
        ? ''
        : `expires ${e.expiresAt === null ? 'never' : s(e.expiresAt)}`
export function log(
  entries: LogEntry[],
  query: Record<string, string | undefined>,
  choices: Record<string, [string, string][]>,
) {
  const choose = (name: string, options: [string, string][]) =>
    html`<label>${name[0].toUpperCase() + name.slice(1)}<select name="${name}"><option value="">Any</option>${options.map(([value, text]) => html`<option value="${value}" ${raw(query[name] === value ? 'selected' : '')}>${text}</option>`)}</select></label>`
  return html`<h2>Log <small>${plural(entries.length, 'entry', 'entries')}, newest first</small></h2><form method="get" action="/admin/log"><div class="actions">${Object.entries(choices).map(([name, options]) => choose(name, options))}<button>Filter</button><a href="/admin/log">Clear</a></div></form>${
    entries.length
      ? html`<table><thead><tr><th>Time (UTC)</th><th>Who</th><th>What</th><th>Result</th></tr></thead><tbody>${entries.map(
          (e) =>
            html`<tr><td><time datetime="${e.time}">${time(Date.parse(e.time))}</time></td><td>${[e.label, e.agentName].filter(Boolean).join(' · ')}</td><td>${e.event === 'proxy' ? '' : `${e.event.replaceAll('_', ' ')}: `}${what(e)}</td><td>${result(e)}</td></tr>`,
        )}</tbody></table>`
      : empty('No log entries. Calls and decisions appear here as they happen, or nothing matches this filter.')
  }`
}
