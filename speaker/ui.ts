// The owner's pages: Hono's html templates styled by Open Props and a small stylesheet, with htmx for live panels, confirmations
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

// Open Props (colours, shadows, borders, sizes, fonts) is served separately; the colour roles below pick from its palette per scheme.
const css = `
:root{color-scheme:light dark;font:1rem/1.5 var(--font-system-ui);accent-color:var(--accent);caret-color:var(--accent);
--bg:light-dark(var(--gray-0),oklch(17% .012 262));--surface:light-dark(#fff,oklch(22% .015 262));--surface-2:light-dark(var(--gray-1),oklch(26% .016 262));--ink:light-dark(var(--gray-9),var(--gray-1));--dim:light-dark(var(--gray-7),var(--gray-4));--line:light-dark(var(--gray-3),oklch(32% .015 262));
--accent:light-dark(var(--indigo-8),var(--indigo-4));--on-accent:light-dark(#fff,oklch(16% .04 265));--region:light-dark(var(--indigo-0),oklch(19.5% .022 264));--ticket:light-dark(#fff,oklch(24% .018 262));--perf:light-dark(var(--indigo-3),oklch(38% .04 264));
--good:light-dark(var(--green-10),var(--green-3));--good-bg:light-dark(var(--green-1),oklch(25% .05 150));
--warn:light-dark(oklch(40% .11 70),oklch(85% .11 78));--warn-bg:light-dark(oklch(96.5% .03 82),oklch(27% .035 72));--warn-line:light-dark(oklch(85% .08 78),oklch(40% .06 72));
--bad:light-dark(var(--red-9),var(--red-3));--bad-bg:light-dark(var(--red-0),oklch(26% .055 25));--bad-line:light-dark(var(--red-3),oklch(42% .08 25))}
*{box-sizing:border-box}html{scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--line) transparent}[hidden]{display:none!important}
body{margin:0;min-width:320px;background:var(--bg);color:var(--ink)}
::selection{background:color-mix(in oklch,var(--accent) 22%,transparent);color:var(--ink)}
.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.top{position:sticky;top:0;z-index:10;background:light-dark(var(--indigo-10),oklch(23% .08 265));color:#fff}.top .in{max-width:1120px;margin:auto;padding:10px 20px 0}
.bar{display:flex;align-items:center;gap:12px;min-height:44px}.bar a{color:#fff;font-size:.88rem;min-height:44px;display:inline-flex;align-items:center;padding:0 4px}.bar small{margin-left:auto;color:var(--indigo-1);display:inline-flex;align-items:center;gap:7px}.bar small::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--green-4)}.bar small.offline::before{background:var(--red-4)}
.logo{display:grid;place-items:center;width:34px;height:34px;border-radius:var(--radius-3);background:#fff;color:var(--indigo-10);flex:none}
h1{font-size:1.45rem;line-height:1.2;font-weight:800;letter-spacing:-.03em;margin:0;text-wrap:balance}h1 em{font-weight:700}
nav.tabs{display:flex;gap:4px;margin-top:6px;overflow-x:auto;scrollbar-width:none}nav.tabs a{display:flex;align-items:center;min-height:44px;padding:0 16px;border-radius:var(--radius-3) var(--radius-3) 0 0;color:var(--indigo-1);text-decoration:none;font-weight:650;white-space:nowrap;transition:background-color .16s ease-out,color .16s ease-out}
nav.tabs a:hover{background:#fff2}nav.tabs a[aria-current]{background:var(--bg);color:var(--ink)}
main{max-width:1120px;margin:auto;padding:18px 20px 72px}main>p:first-child{margin:4px 0 14px}
p{text-wrap:pretty}h2{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-size:1.25rem;line-height:1.25;font-weight:750;letter-spacing:-.02em;margin:0 0 14px;text-wrap:balance}h3{font-size:1.05rem;font-weight:700;margin:20px 0 10px;text-wrap:balance}
h3.subhead{display:flex;align-items:baseline;gap:8px;margin:22px 0 10px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:.95rem}
small{color:var(--dim);font-size:.875rem}h2 small,h3.subhead small{font-size:.82rem;font-weight:650}a{color:var(--accent);text-underline-offset:3px}code{font:.9em var(--font-monospace-code);overflow-wrap:anywhere}
time,code,#active article>header small,.count{font-variant-numeric:tabular-nums}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-3);padding:18px 20px;margin-bottom:20px;scroll-margin-top:116px}.panel.region{background:var(--region);border:0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr));gap:16px;align-items:start}
article>footer{padding-bottom:12px}
.region article{background:var(--ticket);border:1px solid light-dark(transparent,var(--line));border-radius:var(--radius-3);box-shadow:light-dark(var(--shadow-3),none);padding:18px 18px 0}
article>header{display:block;margin-bottom:10px}.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}article>header strong{font-size:1.12rem;font-weight:750;line-height:1.25}.card-meta{display:block;margin-top:4px;line-height:1.45}
.reason{margin:10px 0 12px;padding:8px 12px;border-radius:var(--radius-2);background:var(--surface-2);font-size:.95rem}.reason-label{font-size:.78rem;font-weight:700;color:var(--dim);margin-right:6px;text-transform:uppercase;letter-spacing:.03em}
.stub{position:relative;margin:14px -18px 0;padding:14px 18px 18px;border-top:2px dashed var(--perf)}.stub::before,.stub::after{content:"";position:absolute;top:-9px;width:16px;height:16px;border-radius:50%;background:var(--region)}.stub::before{left:-9px}.stub::after{right:-9px}
#active .cards{display:block}#active article{border-top:1px solid var(--line);padding:14px 0}#active article:first-child{border-top:0;padding-top:4px}#active article>header{display:flex;gap:12px;align-items:flex-start;margin:0}#active article>header>span:not(.mark){flex:1;min-width:0}#active article>header small{display:inline}
#active .idle-cards article{padding:10px 0}
ul.rows{list-style:none;margin:0;padding:0}ul.rows>li{padding:12px 0;border-top:1px solid var(--line)}ul.rows>li:first-child{border-top:0}#active ul.rows{margin:10px 0 0 46px}#active ul.rows>li{padding:10px 0}
li.row{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:center}.row-main{display:flex;gap:12px;align-items:flex-start;flex:1 1 260px;min-width:0;overflow-wrap:anywhere}.row-main>div{flex:1;min-width:0}
li.grant-row{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:center}.grant-info{flex:1 1 260px;min-width:0;overflow-wrap:anywhere}
.mark{--h:268;--m:light-dark(oklch(56% .19 var(--h)),oklch(78% .13 var(--h)));display:grid;place-items:center;width:34px;height:34px;border-radius:var(--radius-3);background:color-mix(in oklch,var(--m) 18%,transparent);color:var(--m);flex:none}.chips .mark{width:22px;height:22px}.chips .mark .ic{width:13px;height:13px}
mark,.badge{display:inline-block;padding:1px 8px;border-radius:var(--radius-round);font-size:.78rem;font-weight:700;vertical-align:middle}mark,.badge-warn{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-line)}
.chip{display:inline-block;padding:1px 8px;border-radius:var(--radius-round);font-size:.78rem;font-weight:700}.chip.good{background:var(--good-bg);color:var(--good)}.chip.bad{background:var(--bad-bg);color:var(--bad)}
.warn{color:var(--bad)}p.warn{padding:10px 14px;border-radius:var(--radius-3);background:var(--bad-bg);border:1px solid var(--bad-line);font-weight:600}
label{display:block;font-size:.86rem;font-weight:600;color:var(--dim)}
input:not([type=checkbox],[type=radio]),select,textarea{display:block;width:100%;min-height:44px;margin:6px 0 14px;padding:9px 12px;border:1px solid var(--gray-6);border-radius:var(--radius-2);background:var(--surface);color:var(--ink);font:inherit;font-size:1rem}textarea{font-family:var(--font-monospace-code)}
input[type=checkbox]{width:22px;height:22px;margin:0;flex:none}fieldset{border:0;margin:0 0 8px;padding:0;display:grid;gap:6px}legend{padding:0;margin-bottom:6px;width:100%}
fieldset label{display:flex;gap:10px;align-items:center;min-height:44px;padding:7px 10px;border:1px solid transparent;border-radius:var(--radius-2);font-size:1rem;font-weight:400;color:var(--ink);cursor:pointer}fieldset label:hover{background:var(--surface-2)}fieldset label small{display:block;line-height:1.3}fieldset label code{font-weight:650}label.risky{background:var(--warn-bg);border-color:var(--warn-line)}label.risky:hover{background:var(--warn-bg)}
button,.action-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border:1px solid transparent;border-radius:var(--radius-2);background:var(--accent);color:var(--on-accent);font:inherit;font-size:.94rem;font-weight:650;cursor:pointer;white-space:nowrap;text-decoration:none;transition:filter .16s ease-out,background-color .16s ease-out,border-color .16s ease-out}button:hover,.action-btn:hover{filter:brightness(1.06)}button:disabled{opacity:.6;cursor:wait}
button.approve{background:var(--green-9);color:#fff;font-weight:750}button.secondary,.action-btn{background:var(--surface);color:var(--ink);border-color:var(--line)}button.secondary:hover,.action-btn:hover{background:var(--surface-2);filter:none}
button.deny,form[hx-confirm] button{background:transparent;color:var(--bad);border-color:var(--bad-line)}button.deny:hover,form[hx-confirm] button:hover{background:var(--bad-bg);filter:none}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.stub button{flex:1;min-height:50px;font-size:1rem}.stub button:first-child{flex:1.6}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}.chips input[type=text]{flex:1 1 220px;max-width:260px;margin:0}.chips label{position:relative;display:inline-flex;gap:7px;align-items:center;min-height:44px;padding:0 14px 0 10px;border:1px solid var(--line);border-radius:var(--radius-2);background:var(--surface);color:var(--ink);font-size:.88rem;font-weight:600;cursor:pointer;transition:background-color .16s ease-out,border-color .16s ease-out}
.chips label:has(:checked){background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.chips label input{position:absolute;opacity:0}
.jump-links{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.jump-links a{display:inline-flex;align-items:center;min-height:40px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-2);background:var(--surface);color:var(--ink);text-decoration:none;font-size:.88rem;font-weight:600}.jump-links a:hover{background:var(--surface-2)}
details>summary{display:flex;align-items:center;min-height:44px;cursor:pointer;list-style:none;color:var(--accent);font-weight:650}summary::after{content:"";width:8px;height:8px;margin:0 4px 0 auto;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(45deg);transition:transform .16s ease-out}details[open]>summary::after{transform:rotate(225deg)}
.panel>details{border-top:1px solid var(--line);margin-top:10px}.sub-details{border-top:1px solid var(--line);margin:8px 0 14px;padding-top:4px}.stack-row>details{margin-top:4px}
.meter{display:inline-block;vertical-align:middle;width:110px;height:8px;margin-right:8px;border-radius:var(--radius-round);background:var(--line);overflow:hidden}.meter i{display:block;height:100%;background:var(--green-9);transition:width .3s ease-out}
.log-filter{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 12px;align-items:end;margin-bottom:16px}.log-filter select{margin-bottom:0}.log-filter-actions{display:flex;gap:8px;align-items:center}
table.log-table{width:100%;border-collapse:collapse;font-size:.92rem}table.log-table th{text-align:left;color:var(--dim);font-size:.82rem;white-space:nowrap}table.log-table th,table.log-table td{padding:9px 12px 9px 0;border-top:1px solid var(--line);vertical-align:top}table.log-table td{overflow-wrap:anywhere}
.auth-wrap{min-height:100dvh;display:grid;place-items:center;padding:20px}.auth{width:100%;max-width:420px;margin:0}.auth-brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:16px;font-size:1.35rem;font-weight:800;letter-spacing:-.03em}.auth-brand em{font-weight:700}.auth-brand .logo{background:light-dark(var(--indigo-10),var(--indigo-4));color:light-dark(#fff,oklch(16% .04 265))}.auth button{width:100%}.auth h2{align-items:center}
dialog{max-width:440px;width:calc(100% - 32px);padding:20px;border:1px solid var(--line);border-radius:var(--radius-3);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-4)}dialog::backdrop{background:oklch(12% .02 262 / .58)}dialog h3{margin:0 0 8px}dialog p{margin:0 0 18px;color:var(--dim)}dialog .actions{justify-content:flex-end}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.top :focus-visible{outline-color:#fff}
@media(max-width:640px){.top .in{padding:6px 12px 0}h1{font-size:1.25rem}.bar a{display:none}.logo{width:30px;height:30px}main{padding:14px 12px 56px}.panel{padding:14px}.region article{padding:14px 14px 0}.stub{margin:14px -14px 0;padding:14px}.panel.region{padding:12px}.chips input[type=text]{flex:1 1 100%;max-width:none}#active ul.rows{margin-left:0}#active article>header{flex-wrap:wrap}#active article>header>span:not(.mark){flex-basis:calc(100% - 46px)}#active article>header>form{margin-left:46px}table.log-table thead{display:none}table.log-table,table.log-table tbody,table.log-table tr,table.log-table td{display:block;width:100%}table.log-table tr{padding:10px 0;border-top:1px solid var(--line)}table.log-table td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border:0;padding:3px 0;text-align:right}table.log-table td::before{content:attr(data-label);color:var(--dim);font-size:.8rem;font-weight:600;text-align:left;flex:none}table.log-table td:empty{display:none}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}}
`

// Each kind of item: its Lucide icon and colour hue; admin.ts builds the served sprite from these (symbol ids become i-<kind>).
export const icons: Record<string, [icon: string, hue: number]> = {
  brand: ['key-round', 268],
  service: ['key-round', 70],
  secret: ['lock', 335],
  site: ['globe', 205],
  folder: ['folder', 135],
  mcp: ['plug', 295],
  ext: ['puzzle', 25],
  host: ['shield-check', 250],
  agent: ['bot', 180],
  ssh: ['square-terminal', 95],
}
const mark = (kind: string) =>
  html`<span class="mark" style="--h:${icons[kind][1]}" aria-hidden="true"><svg class="ic"><use href="/admin/assets/icons.svg#i-${kind}"></use></svg></span>`

// The page's only script (htmx is loaded without eval): group checkboxes, live filtering with empty-kind hiding,
// local time + countdowns, conditional auth header field, live-polling status, and accessible <dialog> confirmations.
const pageScript = `const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })
const units = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]
const syncHeaderField = () => {
  const sel = document.querySelector('select[name=authType]')
  const box = document.querySelector('[data-auth-header]')
  if (sel && box) box.hidden = sel.value !== 'header'
}
const tick = () => {
  const bar = document.querySelector('.chips')
  const items = [...document.querySelectorAll('#inbox [data-kind], #active article[data-kind]')]
  const kind = document.querySelector('[name=kind]:checked')?.value ?? ''
  const q = document.querySelector('[name=q]')?.value.trim().toLowerCase() ?? ''
  if (bar) {
    bar.hidden = items.length < 2
    const counts = {}
    for (const el of items) {
      for (const k of (el.dataset.kind || '').split(' ')) if (k) counts[k] = (counts[k] || 0) + 1
    }
    let visibleKinds = 0
    bar.querySelectorAll('label:has(input[name=kind])').forEach((lbl) => {
      const radio = lbl.querySelector('input[name=kind]')
      if (!radio.value) return
      const show = Boolean(counts[radio.value]) || radio.checked
      lbl.hidden = !show
      if (show) visibleKinds++
    })
    const allLbl = bar.querySelector('label:has(input[name=kind][value=""])')
    if (allLbl) allLbl.hidden = visibleKinds === 0
  }
  let shown = 0
  document.querySelectorAll('[data-kind]').forEach((el) => {
    const match = (!kind || el.dataset.kind.split(' ').includes(kind)) && (!q || el.textContent.toLowerCase().includes(q))
    el.hidden = !match
    if (match && el.matches('#inbox [data-kind], #active article[data-kind]')) shown++
  })
  const emptyNote = document.getElementById('filter-empty')
  if (emptyNote) emptyNote.hidden = items.length === 0 || shown > 0
  document.querySelectorAll('.meter').forEach((m) => {
    m.firstChild.style.width = Math.max(0, Math.min(100, ((new Date(m.nextElementSibling.dateTime) - Date.now()) / m.dataset.total) * 100)) + '%'
  })
  document.querySelectorAll('time[data-local]').forEach((t) => {
    const at = new Date(t.dateTime)
    const secs = Math.max(0, Math.round((at - Date.now()) / 1000))
    const [unit, size] = units.find(([, size]) => secs >= size) ?? units[3]
    t.textContent = at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ('left' in t.dataset ? ' (' + rtf.format(Math.floor(secs / size), unit).replace(/^in /, '') + ' left)' : '')
  })
  syncHeaderField()
}
let pendingConfirm = null
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-all]')) e.target.closest('fieldset').querySelectorAll('input[name=items]').forEach((i) => { i.checked = e.target.checked })
  if (e.target.matches('select[name=authType]')) syncHeaderField()
  if (e.target.matches('[name=kind]')) tick()
})
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-clear-filter]')) {
    const q = document.querySelector('[name=q]')
    const all = document.querySelector('[name=kind][value=""]')
    if (q) q.value = ''
    if (all) all.checked = true
    tick()
  }
  const dlg = document.getElementById('confirm-dialog')
  if (!dlg) return
  if (e.target.matches('[data-no]') || e.target === dlg) { pendingConfirm = null; dlg.close() }
  if (e.target.matches('[data-yes]')) { const run = pendingConfirm; pendingConfirm = null; dlg.close(); if (run) run(true) }
})
document.addEventListener('htmx:confirm', (e) => {
  const dlg = document.getElementById('confirm-dialog')
  if (!dlg || !e.detail.question) return
  e.preventDefault()
  const btn = e.detail.elt.querySelector('button:not([type=button])')
  const action = btn?.textContent?.trim() || 'Confirm'
  document.getElementById('confirm-title').textContent = action
  document.getElementById('confirm-body').textContent = e.detail.question
  document.getElementById('confirm-yes').textContent = action
  pendingConfirm = e.detail.issueRequest
  dlg.showModal()
})
document.addEventListener('htmx:beforeRequest', (e) => {
  const elt = e.detail.elt
  if (elt?.tagName === 'FORM') elt.querySelectorAll('button').forEach((b) => { b.disabled = true })
})
document.addEventListener('htmx:afterRequest', (e) => {
  const elt = e.detail.elt
  if (elt?.tagName === 'FORM') elt.querySelectorAll('button').forEach((b) => { b.disabled = false })
  const live = document.getElementById('live-status')
  if (!live || (elt?.id !== 'inbox' && elt?.id !== 'active')) return
  const ok = e.detail.successful
  live.textContent = ok ? 'Live' : 'Offline'
  live.classList.toggle('offline', !ok)
})
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
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="htmx-config" content="${htmxConfig}"><title>Speaker for the creds</title><link rel="stylesheet" href="/admin/assets/open-props.css"><style>${raw(css)}</style><script src="/admin/assets/htmx.js"></script><script nonce="${nonce}">${raw(pageScript)}</script></head>`

const sections = [
  ['approvals', 'Inbox', '/admin'],
  ['active', 'Active', '/admin?section=active'],
  ['services', 'Setup', '/admin?section=services'],
  ['log', 'Log', '/admin/log'],
] as const
export type Section = (typeof sections)[number][0]
const kinds = {
  service: 'Services',
  site: 'Sites',
  secret: 'Secrets',
  folder: 'Folders',
  ssh: 'SSH',
  mcp: 'MCP',
  ext: 'Extensions',
}
// Kind chips and a text box that narrow the cards and rows of the live panels (see pageScript).
const filterBar = html`<div class="chips" role="search" hidden><input type="text" name="q" placeholder="Filter by name or item" aria-label="Search"><label><input type="radio" name="kind" value="" checked>All</label>${Object.entries(kinds).map(([k, text]) => html`<label><input type="radio" name="kind" value="${k}">${mark(k)}${text}</label>`)}</div>`
const filterEmpty = html`<div id="filter-empty" class="panel" hidden><p>No items match this filter.</p><button type="button" class="secondary" data-clear-filter>Clear filter</button></div>`
const intros: Record<Section, string> = {
  approvals: 'Sandbox hosts and access requests waiting for your yes or no.',
  active: 'Agents and the access granted to them right now; extend or revoke any of it.',
  services: 'Upstream APIs, secrets, groups and SSH targets speaker manages.',
  log: 'Recent calls and decisions, newest first.',
}
const logo = html`<span class="logo" aria-hidden="true"><svg class="ic"><use href="/admin/assets/icons.svg#i-brand"></use></svg></span>`
const confirmDialog = html`<dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body"><h3 id="confirm-title">Confirm</h3><p id="confirm-body"></p><div class="actions"><button type="button" class="secondary" data-no>Keep</button><button type="button" class="deny" id="confirm-yes" data-yes>Confirm</button></div></dialog>`
export const layout = (nonce: string | undefined, section: Section, body: Html | string) =>
  html`${head(nonce)}<body hx-boost="true"><header class="top"><div class="in"><div class="bar">${logo}<h1>Speaker for the <em>creds</em></h1><small id="live-status">Live</small><a href="/admin">Refresh</a></div><nav class="tabs">${sections.map(
    ([id, label, href]) => html`<a href="${href}" ${raw(id === section ? 'aria-current="page"' : '')}>${label}</a>`,
  )}</nav></div></header><main><p><small>${intros[section]}</small></p>${section === 'approvals' || section === 'active' ? html`${filterBar}${filterEmpty}` : ''}${typeof body === 'string' ? raw(body) : body}</main>${confirmDialog}</body></html>`

// Sign-in and first-run pages: centered card with brand lockup.
const authPage = (
  heading: string,
  intro: string,
  fields: Html,
  button: string,
  action: string,
  exposed: boolean,
  error?: string,
) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Speaker for the creds</title><link rel="stylesheet" href="/admin/assets/open-props.css"><style>${raw(css)}</style></head><body><main class="auth-wrap"><div class="auth"><div class="auth-brand">${logo}<span>Speaker for the <em>creds</em></span></div><section class="panel"><h2>${heading}</h2><p>${intro}</p>${exposed ? html`<p class="warn" role="note">This page uses plain HTTP, so your password crosses the network unencrypted.</p>` : ''}${error ? html`<p class="warn" role="alert">${error}</p>` : ''}<form method="post" action="${action}">${fields}<button>${button}</button></form></section></div></main></body></html>`
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
// One button posting `fields`; with `confirm`, htmx asks first (via #confirm-dialog when JS is running).
const button = (action: string, fields: Html | string, label: string, confirm = '', kind = 'secondary') =>
  html`<form method="post" action="${action}" ${raw(confirm ? `hx-confirm="${String(html`${confirm}`)}"` : '')}>${fields}<button class="${kind}">${label}</button></form>`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
// A time the page rewrites into the viewer's zone (UTC until the script runs); `countdown` adds the time left.
const local = (ms: number, countdown = false) =>
  html`<time datetime="${new Date(ms).toISOString()}" data-local ${raw(countdown ? 'data-left' : '')}>${time(ms)} UTC</time>`
const kindOf = (item: string) => (item.includes(':') ? item.split(':')[0] : 'service')
// Items that can change things (or reach out with a credential) are highlighted and explicitly badged on the card.
const risky = (item: string) => /^(ssh|secret):|\.full$|^folder:.+:rw$/.test(item)
const riskTag = (item: string) =>
  item.startsWith('ssh:')
    ? 'SSH'
    : item.startsWith('secret:')
      ? 'secret'
      : /\.full$|^folder:.+:rw$/.test(item)
        ? 'read/write'
        : ''
const empty = (text: string) => html`<p><small>${text}</small></p>`

// A live panel: htmx asks again every 5 seconds with the hash of what it shows; an unchanged panel answers 204.
// Request cards are hx-preserve: a refresh keeps the cards still pending as they are, so unticked items and a chosen duration stay.
const digest = (inner: string) => createHash('sha256').update(inner).digest('hex').slice(0, 16)
export const live = (id: string, inner: string) =>
  `<section id="${id}" class="panel${id === 'inbox' ? ' region' : ''}" hx-get="/admin/panel/${id}?h=${digest(inner)}" hx-trigger="every 5s" hx-swap="outerHTML">${inner}</section>`
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
    const tag = riskTag(item)
    return html`<label class="${risky(item) ? 'risky' : ''}"><input type="checkbox" name="items" value="${item}" checked>${mark(kindOf(item))}<span><code>${item}</code>${tag ? html` <span class="badge badge-warn">${tag}</span>` : ''} <small>${detail ? detail.text : kindOf(item)}${item.startsWith('secret:') ? sentTo(item) : ''}</small>${detail?.warning ? html` <mark>${detail.warning}</mark>` : ''}</span></label>`
  }
  const hostCards = hosts
    .filter((h) => h.status === 'pending')
    .map(
      (h) =>
        html`<article id="host-${h.id}"><header><div class="card-head"><strong>Sandbox host ${h.name}</strong><small>wants to register</small></div></header><p>Approving lets this sandbox host create agents and enforce grants for ${h.kinds.join(', ') || 'no item kinds'}.</p><form method="post" action="/admin/hosts/${h.id}/approve" class="actions stub"><button class="approve">Approve</button><button class="deny" formaction="/admin/hosts/${h.id}/remove">Deny</button></form></article>`,
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
      return html`<article id="request-${r.id}" hx-preserve data-kind="${[...new Set(r.items.map(kindOf))].join(' ')}"><header><div class="card-head"><strong>${label}</strong><small>${local(r.createdAt)}</small></div>${agent ? html`<small class="card-meta">says it is ${agent.agent}${agent.sandboxHost ? ` · via ${agent.sandboxHost}` : ''} · from ${agent.source} · key <code>${agent.tokenHash.slice(0, 8)}</code>${twin(agent)}</small>` : ''}</header><p class="reason"><span class="reason-label">Reason</span> ${r.reason || html`<small>none supplied yet</small>`}</p><form method="post" action="/admin/requests/${r.id}/approve">${r.items.map((item) => hidden('shown', item))}${asked.map(
        (g) =>
          html`<fieldset><legend><label><input type="checkbox" data-all checked><strong>${g.name}</strong> <small>${g.description ? `${g.description} · ` : ''}${plural(g.members.length, 'item', 'items')}</small></label></legend>${g.members.map((item) => pick(r.agentId, item))}</fieldset>`,
      )}${loose.length ? html`<fieldset>${asked.length ? html`<legend>Not in a group</legend>` : ''}${loose.map((item) => pick(r.agentId, item))}</fieldset>` : ''}<div class="stub">${select('duration', 'Allow access for', ['30m', '1h', '2h', '1d', '30d', 'permanent'], r.duration)}<div class="actions"><button class="approve">Approve</button><button class="deny" formaction="/admin/requests/${r.id}/deny">Deny</button></div></div></form>${r.trigger || notice ? html`<footer><small>${r.trigger ? html`Triggered by <code>${r.trigger}</code> ` : ''}${notice}</small></footer>` : ''}</article>`
    })
  const cards = [...hostCards, ...requestCards]
  return String(
    html`<h2>Inbox ${cards.length ? html`<small class="count">${cards.length} pending</small>` : ''}</h2>${cards.length ? html`<div class="cards">${cards}</div>` : empty('Nothing to approve. New requests appear here as soon as an agent asks for access.')}`,
  )
}

// --- Active: agents with live grants/sessions first, idle agents below, and approved sandbox hosts ---
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
    return html`<li id="grant-${g.id}" class="grant-row" data-kind="${kindOf(g.item)}">${mark(kindOf(g.item))}<div class="grant-info"><code>${g.item}</code> ${detail ? html`<small>${detail.text}</small>${detail.warning ? html` <mark>${detail.warning}</mark>` : ''}` : ''}<br><small>${g.expiresAt === null ? html`<mark>Until revoked</mark>` : html`${g.grantedMs ? html`<span class="meter" data-total="${g.grantedMs}"><i></i></span>` : ''}${local(Date.parse(g.expiresAt), true)}`}${chips[g.state] ? html` · <mark data-state="${g.state}">${chips[g.state]}</mark>` : ''}${kindOf(g.item) === 'service' ? html` · ${uses(g.uses, `grant=${encodeURIComponent(g.id)}`)}` : ''}</small></div><div class="actions">${g.expiresAt !== null && g.grantedMs !== undefined ? button('/admin/grants/extend', hidden('id', g.id), `Extend ${span(g.grantedMs)}`) : ''}${button('/admin/grants/revoke', hidden('id', g.id), 'Revoke', `Revoke ${g.item} for ${g.label}? Calls using it are blocked immediately.`)}</div></li>`
  }
  const agentCard = (a: View['agents'][number], mine: View['grants'], open: View['sessions']) =>
    html`<article id="agent-${a.id}" data-kind="${[...new Set([...mine.map((g) => kindOf(g.item)), ...open.map(() => 'ssh')])].join(' ')}"><header>${mark('agent')}<span><strong>${a.label}</strong> <small>${a.agent}${a.sandboxHost ? ` · via ${a.sandboxHost}` : ''} · ${uses(a.uses, `agent=${encodeURIComponent(a.id)}`)}${a.lastUsedAt ? html` · last used ${local(a.lastUsedAt)}` : ''}</small>${tallies(a)}</span>${button(`/admin/agents/${a.id}/revoke`, '', 'Revoke agent', `Revoke agent ${a.label}? Its token and all its grants end immediately.`)}</header>${mine.length || open.length ? html`<ul class="rows">${mine.map(grantRow)}${open.map((s) => html`<li class="grant-row" data-kind="ssh">${mark('ssh')}<div class="grant-info"><code>${s.what}</code><br><small>SSH session open since ${local(s.started)}</small></div><div class="actions">${button('/admin/ssh/sessions/end', hidden('id', s.id), 'End', `End this SSH session now? ${s.what}`)}</div></li>`)}</ul>` : ''}</article>`
  const sorted = [...agents].sort((a, b) => soonest(a.id) - soonest(b.id))
  const withAccess: Html[] = []
  const idle: Html[] = []
  for (const a of sorted) {
    const mine = grants.filter((g) => g.agentId === a.id).sort((x, y) => end(x) - end(y))
    const open = sessions.filter((s) => s.agent === a.id)
    if (mine.length || open.length) withAccess.push(agentCard(a, mine, open))
    else idle.push(agentCard(a, mine, open))
  }
  const hostBlocks = hosts
    .filter((h) => h.status === 'approved')
    .map(
      (h) =>
        html`<article><header>${mark('host')}<span><strong>Sandbox host ${h.name}</strong> <small>${h.kinds.join(', ') || 'no item kinds'}${h.shares.length ? ` · shares: ${h.shares.map((s) => `${s.name} (${s.mount ? 'VM mount' : 'no VM mount'})`).join(', ')}` : ''}</small></span>${button(`/admin/hosts/${h.id}/remove`, '', 'Remove', `Remove sandbox host ${h.name}? Its agents and their grants end immediately.`)}</header></article>`,
    )
  return String(
    html`<h2>Active ${grants.length ? html`<small class="count">${plural(grants.length, 'grant', 'grants')}</small>` : ''}</h2>${withAccess.length ? html`<div class="cards">${withAccess}</div>` : empty('No live grants or open SSH sessions right now.')}${idle.length ? html`<h3 class="subhead">Enrolled without active grants <small class="count">${idle.length}</small></h3><div class="cards idle-cards">${idle}</div>` : ''}${hostBlocks.length ? html`<h3 class="subhead">Sandbox hosts <small class="count">${hostBlocks.length}</small></h3><div class="cards">${hostBlocks}</div>` : ''}${!withAccess.length && !idle.length && !hostBlocks.length ? empty('Agents and the access you granted appear here until they expire or you revoke them.') : ''}<p><small>Expiry and revocation block new calls; a response already streaming may finish.</small></p>`,
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
  const authType = chosen?.auth.type ?? 'bearer'
  const hasAdvanced = Boolean(chosen?.readPaths?.length || chosen?.mcp || chosen?.notes)
  const serviceForm = html`<form method="post" action="/admin/services/save">${input('id', 'Service id', 'text', chosen ? selected : '')}${input('baseUrl', 'Upstream base URL', 'url', chosen?.baseUrl)}${select('authType', 'Authentication (path = secret is a URL segment, e.g. a webhook id; none = keyless service)', ['bearer', 'header', 'basic', 'path', 'none'], authType)}<div data-auth-header ${raw(authType === 'header' ? '' : 'hidden')}>${input('headerName', 'Credential header', 'text', chosen?.auth.type === 'header' ? chosen.auth.headerName : '')}</div>${input('secret', 'Credential (blank keeps current)', 'password')}${select('read', 'Read rule (GET / HEAD / OPTIONS)', ['ask', 'open', 'never'], chosen?.read ?? 'ask')}${select('write', 'Write rule (all other methods)', ['ask', 'never'], chosen?.write ?? 'ask')}<details class="sub-details" ${raw(hasAdvanced ? 'open' : '')}><summary>Advanced options (read paths, MCP, notes)</summary>${area('readPaths', 'POST paths that only read, one per line (for example a search endpoint)', chosen?.readPaths?.join('\n'))}<label><input type="checkbox" name="mcp" ${raw(chosen?.mcp ? 'checked' : '')}> MCP server (streamable HTTP): classify tool calls by their read-only hints</label>${area('notes', 'Notes for agents (markdown, optional)', chosen?.notes, 5)}</details><button>Save service</button></form>`
  const tools = (id: string) =>
    html`<div class="actions">${error === 'tools' ? html`<p class="warn" role="alert">Could not list tools; check the URL and credential.</p>` : ''}<small>${mcp[id] ? `Tools: ${mcp[id].read} read · ${mcp[id].write} write${mcp[id].unannotated ? ` (${mcp[id].unannotated} without hints, treated as write)` : ''}` : 'Tools not listed yet'}</small>${button('/admin/services/tools', hidden('id', id), 'Refresh tools')}</div>`
  const serviceRows = Object.entries(services).map(([id, s]) => {
    const keyed = s.auth.type === 'none' || secrets.get(id) !== undefined
    return html`<li class="row"><div class="row-main">${mark('service')}<div><strong>${id}</strong> <code>${s.baseUrl}</code><br><small><span class="chip ${keyed ? 'good' : 'bad'}">${s.auth.type === 'none' ? 'No credential' : `Credential: ${secrets.get(id) !== undefined ? 'configured' : 'missing'}`}</span> · read ${s.read} · write ${s.write} · notes ${s.notes ? 'yes' : 'no'}${s.mcp ? ' · MCP' : ''}${s.auth.type === 'path' ? ' · path secret' : ''}</small></div></div><div class="actions"><a class="action-btn" href="/admin?section=services&amp;service=${encodeURIComponent(id)}">Edit</a><a class="action-btn" href="/admin/log?service=${encodeURIComponent(id)}">Log</a>${button('/admin/services/delete', hidden('id', id), 'Delete', `Delete service ${id}? Its credential is erased and its grants and pending requests are removed.`)}</div></li>`
  })
  const secretRows = Object.entries(owned).map(
    ([name, { hosts, env }]) =>
      html`<li class="row"><div class="row-main">${mark('secret')}<div><strong>${name}</strong> <small>Agent sees <code>${env}</code> · sent only to ${hosts.join(', ')}</small></div></div><div class="actions">${button('/admin/secrets/delete', hidden('name', name), 'Delete', `Delete secret ${name}? Its value is erased.`)}</div></li>`,
  )
  const targets = Object.entries(ssh.targets)
  const sshPanel = !ssh.enabled
    ? html`<p><small>SSH and folders over SSH are off. Set <code>SSH_PORT</code> and restart speaker to turn them on.</small></p>`
    : html`${ssh.error ? html`<p class="warn" role="alert">${ssh.error}</p>` : ''}<p><small>Speaker's public key is <code>${ssh.publicKey ?? 'available after sign-in'}</code>. On each target, add <code>from="&lt;speaker's address&gt;",restrict &lt;that key&gt;</code> to the <code>authorized_keys</code> of the account speaker should use; a limited account (not root, no sudo) is best. Adding a target pins its host key, so add the line first.</small></p><ul class="rows">${targets.map(
        ([alias, t]) =>
          html`<li class="stack-row"><div class="row"><div class="row-main">${mark('ssh')}<div><strong>${alias}</strong> <small>${t.account}@${t.host}:${t.port}</small> ${t.sudo ? html`<mark>passwordless sudo works</mark> ` : ''}${t.account === 'root' ? html`<mark>root</mark> ` : ''}<br><small>${t.sftp ? html`sftp-server <code>${t.sftp}</code>` : html`<span class="warn">no sftp-server found: folders over SSH are unavailable</span>`} · host key <code>${t.fingerprint}</code> · authorized_keys line: <code>${t.line}</code></small></div></div><div class="actions">${button('/admin/ssh/targets/delete', hidden('alias', alias), 'Delete', `Delete target ${alias}? Its shares go too, and open sessions and grants for them end.`)}</div></div><form method="post" action="/admin/ssh/targets/from" class="actions">${hidden('alias', alias)}${input('from', 'Addresses speaker connects from (comma-separated)', 'text', t.from)}<button class="secondary">Save addresses</button></form></li>`,
      )}</ul><details><summary>Add a target</summary><form method="post" action="/admin/ssh/targets/add">${input('alias', 'Name agents ask for (ssh:NAME)')}${input('host', 'Host name or address')}${input('port', 'SSH port', 'number', '22')}${input('account', 'Account speaker uses there')}${input('from', 'Addresses speaker connects from (blank: detected)')}${input('sftp', 'sftp-server path (blank: probed)')}<label><input type="checkbox" name="confirmRoot"> I understand: root has no limits</label><button>Add target</button></form></details><h3>Shares</h3><ul class="rows">${Object.entries(
        ssh.shares,
      ).map(
        ([name, share]) =>
          html`<li class="row"><div class="row-main">${mark('folder')}<div><strong>${name}</strong> <small>${share.target}:${share.path} · ${labels[share.delivery]}</small>${ssh.targets[share.target]?.home === share.path ? html` <mark>home directory</mark>` : ''}</div></div><div class="actions">${button('/admin/ssh/shares/delete', hidden('name', name), 'Delete', `Delete share ${name}? Open sessions and grants for it end.`)}</div></li>`,
      )}</ul><details><summary>Add a share</summary><form method="post" action="/admin/ssh/shares/save">${input('name', 'Name agents ask for (folder:NAME)')}${select(
        'target',
        'Target',
        targets.map(([alias]) => alias),
      )}${input('path', 'Absolute path on the target')}${select('delivery', 'Delivery', ['ssh', 'vm', 'both'], 'ssh')}<button>Save share</button></form></details>`
  const groupForm = (id: string, group: Group) =>
    html`<form method="post" action="/admin/groups/save">${input('id', 'Group id', 'text', id)}${input('description', 'Description (one line, optional)', 'text', group.description)}${area('items', 'Items, one per line', group.items.join('\n'), 5)}<button>Save group</button></form>`
  const groupRows = Object.entries(groups).map(
    ([id, group]) =>
      html`<li class="stack-row"><div class="row"><div class="row-main"><div><strong>${id}</strong> ${group.description ? html`<small>${group.description}</small>` : ''}<br><small>${plural(group.items.length, 'item', 'items')}, granted together by one approval: ${group.items.join(', ')}</small></div></div><div class="actions">${button('/admin/groups/delete', hidden('id', id), 'Delete', `Delete group ${id}? Agents can no longer request it. Existing grants stay.`)}</div></div><details><summary>Edit items</summary>${groupForm(id, group)}</details></li>`,
  )
  const jumpNav = html`<nav class="jump-links" aria-label="Setup sections"><a href="#setup-services">Services</a><a href="#setup-secrets">Secrets</a><a href="#groups">Groups</a><a href="#setup-ssh">SSH targets</a><a href="#setup-password">Password</a></nav>`
  return html`${jumpNav}<section class="panel" id="setup-services"><h2>Services</h2>${chosen ? html`<article><h3>Edit service: ${selected}</h3>${serviceForm}${chosen.mcp ? tools(selected ?? '') : ''}</article>` : ''}<ul class="rows">${serviceRows.length ? serviceRows : empty('No services configured. Add a service to let agents request access to an upstream API.')}</ul>${chosen ? '' : html`<details><summary>Add service</summary>${serviceForm}</details>`}</section><section class="panel" id="setup-secrets"><h2>Secrets</h2><ul class="rows">${secretRows.length ? secretRows : empty('No secrets. A secret is a token speaker inserts into an agent’s requests to the hosts you allow; the agent never sees it.')}</ul><details><summary>Add or change a secret</summary><form method="post" action="/admin/secrets/save">${input('name', 'Name (agents ask for secret:NAME)')}${input('value', 'Value (never shown again; blank keeps the current one)', 'password')}${area('hosts', 'Allowed hosts, one per line')}${input('env', 'Environment variable the agent sees')}<button>Save secret</button></form></details></section><section class="panel" id="groups"><h2>Groups</h2>${groupErrors[error ?? ''] ? html`<p class="warn" role="alert">${groupErrors[error ?? '']}</p>` : ''}<ul class="rows">${groupRows.length ? groupRows : empty('No groups. A group collects items so an agent can request them with one approval.')}</ul><details><summary>Add group</summary>${groupForm('', { items: [] })}</details><p><small>A group is what an agent may ask for; a bottle-school template sets the VM size and attended mode and names the group to request at launch. Changes apply to new requests; requests already pending keep their items.</small></p></section><section class="panel" id="setup-ssh"><h2>SSH targets</h2>${sshPanel}</section><section class="panel" id="setup-password"><h2>Owner password</h2><details><summary>Change owner password</summary><form method="post" action="/admin/password">${password('current', 'Current password', 'current-password')}${password('password', 'New password', 'new-password')}${password('confirm', 'Repeat the new password', 'new-password')}<button>Change password</button></form></details></section><p><small>Credentials stay on this server.</small></p>`
}

// --- Log: newest first, narrowed by the filters in the address ---
const s = (value: unknown) => String(value ?? '')
const what = (e: LogEntry): Html | '' => {
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
  if (!list.length && !e.reason) return ''
  return html`${list.length ? html`<code>${list.join(', ')}</code>` : ''}${e.reason ? html` <small>${s(e.reason)}</small>` : ''}`
}
const result = (e: LogEntry): Html | string =>
  e.event === 'ssh_session_end'
    ? `exit ${s(e.code)} · ${s(e.why)} · ${s(e.ms)}ms`
    : e.event === 'proxy'
      ? `${s(e.status)} · ${s(e.latencyMs)}ms · ${e.grant ? 'grant' : s(e.rule)}`
      : e.expiresAt === undefined
        ? ''
        : e.expiresAt === null
          ? 'expires never'
          : html`expires ${local(Date.parse(String(e.expiresAt)))}`
export function log(
  entries: LogEntry[],
  query: Record<string, string | undefined>,
  choices: Record<string, [string, string][]>,
) {
  const choose = (name: string, options: [string, string][]) =>
    html`<label>${name[0].toUpperCase() + name.slice(1)}<select name="${name}"><option value="">Any</option>${options.map(([value, text]) => html`<option value="${value}" ${raw(query[name] === value ? 'selected' : '')}>${text}</option>`)}</select></label>`
  return html`<section class="panel"><h2>Log <small class="count">${plural(entries.length, 'entry', 'entries')}, newest first</small></h2><form method="get" action="/admin/log" class="log-filter">${Object.entries(choices).map(([name, options]) => choose(name, options))}<div class="log-filter-actions"><button>Filter</button><a class="action-btn" href="/admin/log">Clear</a></div></form>${
    entries.length
      ? html`<table class="log-table"><thead><tr><th scope="col">Time</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Result</th></tr></thead><tbody>${entries.map(
          (e) => {
            const detail = what(e)
            const label = e.event === 'proxy' ? '' : `${e.event.replaceAll('_', ' ')}${detail ? ': ' : ''}`
            const who = [e.label, e.agentName].filter(Boolean).join(' · ')
            const res = result(e)
            return html`<tr><td data-label="Time">${local(Date.parse(e.time))}</td><td data-label="Who">${who ? html`<div>${who}</div>` : ''}</td><td data-label="What"><div>${label}${detail}</div></td><td data-label="Result">${res ? html`<div>${res}</div>` : ''}</td></tr>`
          },
        )}</tbody></table>`
      : empty('No log entries. Calls and decisions appear here as they happen, or nothing matches this filter.')
  }</section>`
}
