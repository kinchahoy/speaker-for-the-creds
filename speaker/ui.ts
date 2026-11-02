import { html, raw } from 'hono/html'
import type { Capability, Provider, View } from './server.ts'

const input = (name: string, label: string, type = 'text', value = '') =>
  html`<label>${label}<input name="${name}" type="${type}" value="${value}" ${raw(type === 'password' ? 'autocomplete="new-password"' : '')}></label>`
const select = (name: string, label: string, values: readonly string[], chosen = '') =>
  html`<label>${label}<select name="${name}">${values.map((value) => html`<option value="${value}" ${raw(value === chosen ? 'selected' : '')}>${({ permanent: 'Until revoked', approval: 'Require approval', always: 'Always allow', deny: 'Deny' } as Record<string, string>)[value] ?? value}</option>`)}</select></label>`
const form = (action: string, fields: unknown, button: string, kind = 'inline') =>
  html`<form class="${kind}" method="post" action="${action}">${fields}<button>${button}</button></form>`
const durations = ['15m', '30m', '1h', '1d', '7d', '30d']
const permanentOverride = html`<label class="override" title="Creates a permanent lease that stays until revoked"><input type="checkbox" name="permanent"> Allow until revoked</label>`
const liveScript = `
const status = document.querySelector('#live-status');
const choices = new Map();
document.querySelector('#approvals')?.addEventListener('change', ({target}) => {
  const form = target.closest('form');
  if (form) choices.set(form.action, new FormData(form));
});
function updateTimes() {
  if (document.hidden) return;
  document.querySelectorAll('[data-expires-at]').forEach(time => {
    const end = Number(time.dataset.expiresAt), seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    const remaining = seconds >= 86400 ? Math.ceil(seconds / 86400) + 'd' : seconds >= 3600 ? Math.ceil(seconds / 3600) + 'h' : seconds >= 60 ? Math.ceil(seconds / 60) + 'm' : seconds + 's';
    time.textContent = seconds ? remaining + ' remaining · expires ' + new Date(end).toLocaleString() : 'Expired';
  });
}
async function refresh() {
  if (!document.hidden) {
    try {
      const response = await fetch('/admin/live', {cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('Refresh failed');
      const panels = await response.json();
      for (const id of ['approvals', 'leases']) {
        const panel = document.getElementById(id);
        if (!panel) continue;
        // Leave an actively edited form alone; retain choices on later refreshes.
        if (panel.contains(document.activeElement)) continue;
        panel.innerHTML = panels[id];
        panel.querySelectorAll('form').forEach(form => {
          const saved = choices.get(form.action);
          if (saved) for (const field of form.elements) {
            if (field.type === 'checkbox') field.checked = saved.has(field.name);
            else if (saved.has(field.name)) field.value = saved.get(field.name);
          }
        });
      }
      status.textContent = 'Live updates · times shown in ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
      updateTimes();
    } catch {
      status.textContent = 'Live updates stopped. Refresh the page to reconnect.';
      return;
    }
  }
  setTimeout(refresh, 5000);
}
updateTimes();
setInterval(updateTimes, 1000);
refresh();
`
const css = `:root{color-scheme:dark;--bg:#0a0d14;--panel:#111520;--raised:#171c2b;--line:#22293d;--ink:#f0f3fa;--dim:#a6b2cc;--accent:#7aa2ff;--good:#4fd197;--warn:#f5c443;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:28px 18px 48px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:18px}h1{font-size:1.55rem;letter-spacing:-.03em;margin:0}h2{font-size:1.08rem;margin:0 0 12px}h3{font-size:.95rem;margin:12px 0 8px}.muted,.meta{color:var(--dim);font-size:.88rem}.nav{display:flex;gap:6px;margin-bottom:18px;border-bottom:1px solid var(--line)}.nav a{color:var(--dim);text-decoration:none;padding:9px 12px;border-bottom:2px solid transparent}.nav a[aria-current=page]{color:var(--ink);border-color:var(--accent)}.layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,.9fr);gap:14px;align-items:start}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;min-width:0}.editor{padding-bottom:24px;margin-bottom:20px;border-bottom:1px solid var(--line)}.card ul{list-style:none;padding:0;margin:0}.card li{padding:11px 0;border-top:1px solid var(--line)}.card li:first-child{border-top:0}.item{display:flex;gap:12px;align-items:center;justify-content:space-between}.item-main{min-width:0;overflow-wrap:anywhere}.item-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}form{margin:0}.inline{display:inline-flex;align-items:center;gap:6px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;align-items:end}.fields button{width:100%}label{display:block;font-size:.82rem;color:var(--dim)}input,select,textarea{display:block;width:100%;margin-top:5px;padding:10px 11px;border:1px solid var(--line);border-radius:8px;background:var(--raised);color:var(--ink);font:inherit;font-size:.92rem}button{min-height:44px;border:1px solid transparent;border-radius:8px;background:var(--accent);color:#080d18;padding:9px 13px;font:inherit;font-size:.88rem;font-weight:650;cursor:pointer;white-space:nowrap}.inline button{min-height:44px;padding:7px 10px}.danger button,.deny{background:transparent;color:#ff8b8b;border-color:#54303a}.danger button:hover,.deny:hover{background:#28171e}.decision{display:grid;gap:8px;width:min(100%,440px)}.decision-fields{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.decision-fields select{min-width:0}.decision-fields .override{white-space:nowrap;font-size:.8rem;padding-bottom:10px}.decision-buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px}.decision-buttons button{width:100%}details{margin-top:16px}summary{cursor:pointer;color:var(--accent);font-weight:600;padding:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--raised);padding:12px;border-radius:8px}a{color:var(--accent)}.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;background:#20263a;color:var(--dim)}.chip.good{background:#153328;color:var(--good)}.chip.warn{background:#332a15;color:var(--warn)}.override{display:flex;align-items:center;gap:7px;max-width:200px}.override input{width:auto;margin:0}#approvals .item{align-items:flex-start;flex-direction:column}#approvals .item-actions{flex-wrap:wrap}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:700px){main{padding:16px 12px calc(32px + env(safe-area-inset-bottom))}header{padding-bottom:14px}.layout{grid-template-columns:1fr}.card{padding:14px}.nav{overflow-x:auto;scrollbar-width:none}.nav a{white-space:nowrap;padding:10px 9px}.item{align-items:flex-start;flex-direction:column}.item-actions{flex-wrap:wrap}.decision{width:100%}.decision-fields{grid-template-columns:minmax(0,1fr) auto}}`
const page = (title: string, body: unknown, nonce: string) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${raw(css)}</style></head><body><main><header><h1>${title}</h1><a href="/admin">Refresh</a></header>${body}</main><script nonce="${nonce}">${raw(liveScript)}</script></body></html>`

const caps = (members: Capability[]) =>
  members.map((m) => html`${m.kind} ${m.ref}`).reduce((a, b) => html`${a}<br>${b}`)
const expiry = (at: string | null) =>
  at === null
    ? 'until revoked (human override)'
    : html`<time datetime="${at}" data-expires-at="${Date.parse(at)}">expires ${at}</time>`
const chips = { active: ['good', 'active'], granted: ['warn', 'granted'], waiting: ['warn', 'waiting for enforcer'] }
const notices = {
  disabled: 'Phone notifications not configured',
  sending: 'Sending phone notification…',
  sent: 'Phone notification accepted by ntfy',
  failed: 'Phone notification failed — access remains locked',
}
const identity = (what: string, meta: string, path: string) =>
  html`<li><div class="item"><div class="item-main"><strong>${what}</strong><div class="meta">${meta}</div></div><div class="item-actions">${form(`/admin/${path}/deny`, '', 'Revoke', 'inline danger')}</div></div></li>`

export function adminPage(
  providers: Record<string, Provider>,
  secrets: Map<string, string | undefined>,
  view: View,
  selectedId?: string,
  nonce?: string,
  section = 'approvals',
) {
  const selected = selectedId && Object.hasOwn(providers, selectedId) ? providers[selectedId] : undefined
  const activeSection = selected
    ? 'providers'
    : ['access', 'identities', 'providers'].includes(section)
      ? section
      : 'approvals'
  const providerList = Object.entries(providers).map(
    ([id, provider]) =>
      html`<li><div class="item"><div class="item-main"><strong>${id}</strong> <span class="meta">${provider.baseUrl}</span><div class="meta">Credential: ${secrets.get(id) !== undefined ? 'configured' : 'missing'} · read ${provider.policy.read} · write ${provider.policy.write} · guide ${provider.guide ? 'yes' : 'no'}</div></div><div class="item-actions"><a href="/admin?section=providers&amp;provider=${encodeURIComponent(id)}">Edit</a>${form('/admin/providers/delete', input('id', '', 'hidden', id), 'Delete', 'inline danger')}</div></div></li>`,
  )
  const panels = livePanels(view)
  const identities = [
    ...view.enforcers
      .filter((e) => e.status === 'approved')
      .map((e) => identity(`Enforcer ${e.name}`, e.kinds.join(', '), `enforcers/${e.id}`)),
    ...view.sessions
      .filter((s) => s.status === 'approved')
      .map((s) => identity(`Session ${s.label}`, s.expiresAt ?? 'until revoked', `sessions/${s.id}`)),
  ]
  const providerFields = html`${input('id', 'Provider id', 'text', selected ? selectedId : '')}${input('baseUrl', 'Upstream base URL', 'url', selected?.baseUrl)}${select('authType', 'Authentication', ['bearer', 'header', 'basic'], selected?.auth.type ?? 'bearer')}${input('headerName', 'Credential header', 'text', selected?.auth.type === 'header' ? selected.auth.headerName : '')}${input('secret', 'Credential (blank keeps current)', 'password')}${select('read', 'Read policy (GET / HEAD / OPTIONS)', ['approval', 'always', 'deny'], selected?.policy.read ?? 'approval')}${select('write', 'Write policy (all other methods)', ['approval', 'always', 'deny'], selected?.policy.write ?? 'approval')}<label>Guide (markdown, optional)<textarea name="guide" rows="5">${selected?.guide}</textarea></label>`
  const providerEditor = selected
    ? html`<section class="editor"><h3>Edit provider: ${selectedId}</h3>${form('/admin/providers/save', providerFields, 'Save provider', 'fields')}</section>`
    : ''
  const addProvider = selected
    ? ''
    : html`<details><summary>Add provider</summary>${form('/admin/providers/save', providerFields, 'Save provider', 'fields')}</details>`
  const nav = html`<nav class="nav" aria-label="Admin sections">${[
    ['approvals', 'Approvals'],
    ['access', 'Leases'],
    ['identities', 'Identities'],
    ['providers', 'Providers'],
  ].map(
    ([id, label]) =>
      html`<a href="/admin?section=${id}" ${raw(activeSection === id ? 'aria-current="page"' : '')}>${label}</a>`,
  )}</nav>`
  const content =
    activeSection === 'access'
      ? html`<section class="card"><div id="leases">${raw(panels.leases)}</div></section>`
      : activeSection === 'identities'
        ? html`<section class="card"><h2>Approved identities</h2><ul>${identities.length ? identities : html`<li class="meta">No approved identities</li>`}</ul></section>`
        : activeSection === 'providers'
          ? html`<section class="card"><h2>Providers</h2>${providerEditor}<ul>${providerList.length ? providerList : html`<li class="meta">No providers configured</li>`}</ul>${addProvider}</section><p class="muted">Credentials stay on this server.</p>`
          : html`<div class="layout"><section class="card" id="approvals">${raw(panels.approvals)}</section><section class="card"><div id="leases">${raw(panels.leases)}</div></section></div><p class="muted">Expiry and revocation block new requests; a response already streaming may finish.</p>`
  return page(
    'Speaker',
    html`${nav}<p id="live-status" class="meta" role="status">Connecting live updates…</p>${content}`,
    nonce ?? '',
  )
}

export function livePanels({ enforcers, sessions, requests, leases }: View) {
  const row = (id: string, main: unknown, actions: unknown) =>
    html`<li id="${id}"><div class="item"><div class="item-main">${main}</div><div class="item-actions">${actions}</div></div></li>`
  const decide = (path: string, picker: unknown) =>
    html`<form class="decision" method="post" action="/admin/${path}/approve"><div class="decision-fields">${picker}</div><div class="decision-buttons"><button>Approve</button><button class="deny" formaction="/admin/${path}/deny">Deny</button></div></form>`
  const items = [
    ...enforcers
      .filter((e) => e.status === 'pending')
      .map((e) =>
        row(
          `enforcer-${e.id}`,
          html`<strong>Enforcer ${e.name}</strong><div class="meta">Kinds: ${e.kinds.join(', ') || 'none'}</div>`,
          decide(`enforcers/${e.id}`, ''),
        ),
      ),
    ...sessions
      .filter((s) => s.status === 'pending')
      .map((s) =>
        row(
          `session-${s.id}`,
          html`<strong>Session ${s.label}</strong><div class="meta">Credential access only</div>`,
          decide(
            `sessions/${s.id}`,
            html`${select('duration', 'Session lasts', durations, s.duration)}${permanentOverride}`,
          ),
        ),
      ),
    ...requests
      .filter((r) => r.status === 'pending')
      .map((r) =>
        row(
          `request-${r.id}`,
          html`<strong>${r.label}</strong>${r.enforcer ? html` <span class="meta">via ${r.enforcer}</span>` : ''}<div>${r.bundle ? html`Bundle ${r.bundle}<div class="meta">${caps(r.members)}</div>` : caps(r.members)}</div>${r.method ? html`<div class="meta">${r.method} ${r.path}</div>` : ''}<div class="meta">${r.reason || 'No reason supplied yet'}</div><div class="meta">${notices[r.notification]}</div>`,
          decide(
            `requests/${r.id}`,
            html`${select('duration', 'Allow access for', durations, r.duration)}${permanentOverride}`,
          ),
        ),
      ),
  ]
  const leaseList = leases.map((l) =>
    row(
      `lease-${l.id}`,
      html`<strong>${l.label}</strong><div>${l.kind} ${l.ref}</div><div class="meta">${expiry(l.expiresAt)} · <span class="chip ${chips[l.state][0]}">${chips[l.state][1]}</span></div>`,
      form('/admin/leases/revoke', input('id', '', 'hidden', l.id), 'Revoke', 'inline danger'),
    ),
  )
  return {
    approvals: String(
      html`<h2>Approvals <span class="meta">${items.length} pending</span></h2><ul>${items.length ? items : html`<li class="meta">No requests are waiting. New approvals appear here when an agent asks for access.</li>`}</ul>`,
    ),
    leases: String(
      html`<h2>Leases</h2><ul>${leaseList.length ? leaseList : html`<li class="meta">No active leases</li>`}</ul>`,
    ),
  }
}
