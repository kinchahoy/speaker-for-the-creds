import { html, raw } from 'hono/html'
import type { Capability, Provider, View } from './server.ts'

const input = (name: string, label: string, type = 'text', value = '') =>
  html`<label>${label}<input name="${name}" type="${type}" value="${value}" ${raw(type === 'password' ? 'autocomplete="new-password"' : '')}></label>`
const select = (name: string, label: string, values: readonly string[], chosen = '') =>
  html`<label>${label}<select name="${name}">${values.map((value) => html`<option value="${value}" ${raw(value === chosen ? 'selected' : '')}>${value === 'permanent' ? 'Until revoked' : value}</option>`)}</select></label>`
const form = (action: string, fields: unknown, button: string, kind = 'inline') =>
  html`<form class="${kind}" method="post" action="${action}">${fields}<button>${button}</button></form>`
const durations = ['15m', '30m', '1h', '1d', '7d', '30d']
const permanentOverride = html`<label class="override"><input type="checkbox" name="permanent"> Override: allow until revoked</label>`
const liveScript = `
const status = document.querySelector('#live-status');
const choices = new Map();
document.querySelector('#approvals').addEventListener('change', ({target}) => {
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
const css = `:root{font:15px/1.4 system-ui,sans-serif;color:#202a35;background:#f2f4f7}*{box-sizing:border-box}body{margin:0}main{max-width:1280px;margin:24px auto;padding:0 18px}header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:18px}h1{font-size:1.65rem;margin:0}h2{font-size:1.08rem;margin:0 0 12px}h3{font-size:.95rem;margin:12px 0 8px}.muted,.meta{color:#657181;font-size:.88rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:14px}.card{background:white;border:1px solid #dce1e7;border-radius:9px;padding:16px;min-width:0}.card ul{list-style:none;padding:0;margin:0}.card li{padding:9px 0;border-top:1px solid #edf0f3}.card li:first-child{border-top:0}.item{display:flex;gap:12px;align-items:center;justify-content:space-between}.item-main{min-width:0;overflow-wrap:anywhere}.item-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}form{margin:0}.inline{display:inline-flex;align-items:center;gap:6px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;align-items:end}.fields button{width:100%}label{display:block;font-size:.8rem;color:#4c5866}input,select{display:block;width:100%;margin-top:3px;padding:7px 8px;border:1px solid #cbd2da;border-radius:5px;background:white;font:inherit;font-size:.9rem}button{border:0;border-radius:5px;background:#255b8f;color:white;padding:7px 10px;font:inherit;font-size:.84rem;cursor:pointer;white-space:nowrap}.inline button{padding:5px 8px}.danger{background:#8e3e43}details{margin-top:12px}summary{cursor:pointer;color:#255b8f;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf0f3;padding:12px;border-radius:6px}a{color:#255b8f}.chip{display:inline-block;padding:0 7px;border-radius:999px;font-size:.75rem;background:#edf0f3;color:#4c5866}.chip.good{background:#e0f3e8;color:#1f6b3f}.chip.warn{background:#fdf1d3;color:#7a5a05}textarea{display:block;width:100%;margin-top:3px;padding:7px 8px;border:1px solid #cbd2da;border-radius:5px;font:inherit;font-size:.9rem}.danger button{background:#8e3e43}.override{display:flex;align-items:center;gap:5px;max-width:160px}.override input{width:auto;margin:0}.inline{flex-wrap:wrap}#approvals .item{align-items:flex-start;flex-direction:column}#approvals .item-actions{flex-wrap:wrap}@media(max-width:560px){main{margin:14px auto;padding:0 10px}.card{padding:12px}.item{align-items:flex-start;flex-direction:column}.item-actions{flex-wrap:wrap}}
`
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
) {
  const selected = selectedId && Object.hasOwn(providers, selectedId) ? providers[selectedId] : undefined
  const providerList = Object.entries(providers).map(
    ([id, provider]) =>
      html`<li><div class="item"><div class="item-main"><strong>${id}</strong> <span class="meta">${provider.baseUrl}</span><div class="meta">Credential: ${secrets.get(id) !== undefined ? 'configured' : 'missing'} · read ${provider.policy.read} · other methods ${provider.policy.write} · guide ${provider.guide ? 'yes' : 'no'}</div></div><div class="item-actions"><a href="/admin?provider=${encodeURIComponent(id)}">Edit</a>${form('/admin/providers/delete', input('id', '', 'hidden', id), 'Delete', 'inline danger')}</div></div></li>`,
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
  const providerFields = html`${input('id', 'Provider id', 'text', selected ? selectedId : '')}${input('baseUrl', 'Upstream base URL', 'url', selected?.baseUrl)}${select('authType', 'Authentication', ['bearer', 'header', 'basic'], selected?.auth.type ?? 'bearer')}${input('headerName', 'Credential header', 'text', selected?.auth.type === 'header' ? selected.auth.headerName : '')}${input('secret', 'Credential (blank keeps current)', 'password')}${select('read', 'GET / HEAD / OPTIONS', ['approval', 'always', 'deny'], selected?.policy.read ?? 'approval')}${select('write', 'Other methods (including MCP POST)', ['approval', 'always', 'deny'], selected?.policy.write ?? 'approval')}<label>Guide (markdown, optional)<textarea name="guide" rows="5">${selected?.guide}</textarea></label>`
  return page(
    'Speaker',
    html`<p id="live-status" class="meta" role="status">Connecting live updates…</p><div class="grid">
<section class="card" id="approvals">${raw(panels.approvals)}</section>
<section class="card"><div id="leases">${raw(panels.leases)}</div></section>
<section class="card"><h2>Enforcers and sessions</h2><ul>${identities.length ? identities : html`<li class="meta">None approved</li>`}</ul></section>
<section class="card"><h2>Providers</h2><ul>${providerList}</ul><details ${raw(selected ? 'open' : '')}><summary>${selected ? 'Edit provider' : 'Add provider'}</summary>${form('/admin/providers/save', providerFields, 'Save provider', 'fields')}</details></section>
</div><p class="muted">Credentials stay on this server. Expiry and revocation block new requests; a response already streaming may finish.</p>`,
    nonce ?? '',
  )
}

export function livePanels({ enforcers, sessions, requests, leases }: View) {
  const row = (id: string, main: unknown, actions: unknown) =>
    html`<li id="${id}"><div class="item"><div class="item-main">${main}</div><div class="item-actions">${actions}</div></div></li>`
  const decide = (path: string, picker: unknown) =>
    html`${form(`/admin/${path}/approve`, picker, 'Approve')}${form(`/admin/${path}/deny`, '', 'Deny', 'inline danger')}`
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
      html`<h2>Approvals <span class="meta">${items.length} pending</span></h2><ul>${items.length ? items : html`<li class="meta">No pending approvals</li>`}</ul>`,
    ),
    leases: String(
      html`<h2>Leases</h2><ul>${leaseList.length ? leaseList : html`<li class="meta">No active leases</li>`}</ul>`,
    ),
  }
}
