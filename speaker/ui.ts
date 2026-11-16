// The owner's pages: Hono's html templates styled by Open Props and a small stylesheet, with htmx for the live Agents panel,
// confirmations and form posts. The panel polls every 5 seconds and is morphed (idiomorph), so open disclosures and focus stay.
import { html, raw } from 'hono/html'
import type { Group, LogEntry, Service, View } from './core.ts'
import type { SshSetup } from './jump.ts'
import type { OwnerSecret } from './store.ts'

type Html = ReturnType<typeof html>
type Owned = Record<string, Pick<OwnerSecret, 'hosts' | 'env'>>
export type McpSummary = Record<string, { read: number; write: number; unannotated: number }>
export type Setup = {
  services: Record<string, Service>
  keyed: Set<string>
  owned: Owned
  groups: Record<string, Group>
  ssh: SshSetup
  mcp: McpSummary
  selected?: string
  error?: string
}

const css = `
.masked{-webkit-text-security:disc}
:root{color-scheme:light dark;font:1rem/1.5 var(--font-system-ui);accent-color:var(--accent);caret-color:var(--accent);
--bg:light-dark(var(--gray-0),oklch(17% .012 262));--surface:light-dark(#fff,oklch(22% .015 262));--surface-2:light-dark(var(--gray-1),oklch(26% .016 262));--ink:light-dark(var(--gray-9),var(--gray-1));--dim:light-dark(var(--gray-7),var(--gray-4));--line:light-dark(var(--gray-3),oklch(32% .015 262));
--accent:light-dark(var(--indigo-8),var(--indigo-4));--on-accent:light-dark(#fff,oklch(16% .04 265));--region:light-dark(var(--indigo-0),oklch(19.5% .022 264));--ticket:light-dark(#fff,oklch(24% .018 262));--perf:light-dark(var(--indigo-3),oklch(38% .04 264));
--warn:light-dark(oklch(40% .11 70),oklch(85% .11 78));--warn-bg:light-dark(oklch(96.5% .03 82),oklch(27% .035 72));--warn-line:light-dark(oklch(85% .08 78),oklch(40% .06 72));
--bad:light-dark(var(--red-9),var(--red-3));--bad-bg:light-dark(var(--red-0),oklch(26% .055 25));--bad-line:light-dark(var(--red-3),oklch(42% .08 25))}
*{box-sizing:border-box}html{scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--line) transparent}[hidden]{display:none!important}
body{margin:0;min-width:320px;background:var(--bg);color:var(--ink)}
::selection{background:color-mix(in oklch,var(--accent) 22%,transparent);color:var(--ink)}
.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.top{position:sticky;top:0;z-index:10;background:var(--surface);border-bottom:1px solid var(--line)}.top .in{max-width:1120px;margin:auto;padding:0 20px}
.bar{display:flex;align-items:center;gap:12px;min-height:52px}.bar>a{font-size:.88rem;min-height:44px;display:inline-flex;align-items:center;padding:0 4px}.bar small{margin-left:auto;display:inline-flex;align-items:center;gap:7px}.bar small::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--green-9)}.bar small.offline{color:var(--bad)}.bar small.offline::before{background:var(--bad)}
.logo{display:grid;place-items:center;width:32px;height:32px;border-radius:var(--radius-3);background:var(--accent);color:var(--on-accent);flex:none}
h1{font-size:1.05rem;line-height:1.2;font-weight:800;letter-spacing:-.02em;margin:0;white-space:nowrap}h1 em{font-weight:700}
nav.tabs{display:flex;gap:2px;margin-left:12px}nav.tabs a{display:flex;align-items:center;gap:6px;min-height:52px;padding:0 14px;border-bottom:3px solid transparent;color:var(--dim);text-decoration:none;font-weight:650;white-space:nowrap}
nav.tabs a:hover{color:var(--ink)}nav.tabs a[aria-current]{color:var(--ink);border-color:var(--accent)}nav.tabs .count{padding:0 7px;border-radius:var(--radius-round);background:var(--accent);color:var(--on-accent);font-size:.78rem;font-weight:700}
main{max-width:1120px;margin:auto;padding:18px 20px 72px}main>p:first-child{margin:4px 0 14px}[id]{scroll-margin-top:72px}
p{text-wrap:pretty}h2{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-size:1.25rem;line-height:1.25;font-weight:750;letter-spacing:-.02em;margin:0 0 14px;text-wrap:balance}h3{font-size:1.05rem;font-weight:700;margin:20px 0 10px;text-wrap:balance}
h3.subhead{display:flex;align-items:baseline;gap:8px;margin:22px 0 10px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:.95rem}
small{color:var(--dim);font-size:.875rem}h2 small,h3.subhead small{font-size:.82rem;font-weight:650}a{color:var(--accent);text-underline-offset:3px}code{font:.9em var(--font-monospace-code);overflow-wrap:anywhere}
time,code,.count{font-variant-numeric:tabular-nums}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-3);padding:18px 20px;margin-bottom:20px}.panel.region{background:var(--region);border:0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr));gap:16px;align-items:start}
article>footer{padding-bottom:12px}
.region article{background:var(--ticket);border:1px solid light-dark(transparent,var(--line));border-radius:var(--radius-3);box-shadow:light-dark(var(--shadow-3),none);padding:18px 18px 0}
article>header{display:block;margin-bottom:10px}.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}article>header strong{font-size:1.12rem;font-weight:750;line-height:1.25}.card-meta{display:block;margin-top:4px;line-height:1.45}
.reason{margin:10px 0 12px;padding:8px 12px;border-radius:var(--radius-2);background:var(--surface-2);font-size:.95rem}.reason-label{font-size:.78rem;font-weight:700;color:var(--dim);margin-right:6px;text-transform:uppercase;letter-spacing:.03em}
.stub{position:relative;margin:14px -18px 0;padding:14px 18px 18px;border-top:2px dashed var(--perf)}.stub::before,.stub::after{content:"";position:absolute;top:-9px;width:16px;height:16px;border-radius:50%;background:var(--region)}.stub::before{left:-9px}.stub::after{right:-9px}
.list article{border-top:1px solid var(--line);padding:14px 0}.list article:first-child{border-top:0;padding-top:4px}.list article>header{display:flex;gap:12px;align-items:flex-start;margin:0}.list article>header>span:not(.mark){flex:1;min-width:0}.list article>:not(header){margin-left:46px}.list table.data-table{width:calc(100% - 46px)}.access .actions{flex-wrap:nowrap}.status{margin:0 0 16px}.scope{margin:0 0 8px}.alert{margin:4px 0}
.mark{--h:268;--m:light-dark(oklch(56% .19 var(--h)),oklch(78% .13 var(--h)));display:grid;place-items:center;width:34px;height:34px;border-radius:var(--radius-3);background:color-mix(in oklch,var(--m) 18%,transparent);color:var(--m);flex:none}.chips .mark{width:22px;height:22px}.chips .mark .ic{width:13px;height:13px}
mark,.badge{display:inline-block;padding:1px 8px;border-radius:var(--radius-round);font-size:.78rem;font-weight:700;vertical-align:middle}mark,.badge-warn{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-line)}
.warn{color:var(--bad)}p.warn{padding:10px 14px;border-radius:var(--radius-3);background:var(--bad-bg);border:1px solid var(--bad-line);font-weight:600}
label{display:block;font-size:.86rem;font-weight:600;color:var(--dim)}
input:not([type=checkbox],[type=radio]),select,textarea{display:block;width:100%;min-height:44px;margin:6px 0 14px;padding:9px 12px;border:1px solid var(--gray-6);border-radius:var(--radius-2);background:var(--surface);color:var(--ink);font:inherit;font-size:1rem}textarea{font-family:var(--font-monospace-code)}
input[type=checkbox]{width:22px;height:22px;margin:0;flex:none}fieldset{border:0;margin:0 0 8px;padding:0;display:grid;gap:6px}legend{padding:0;margin-bottom:6px;width:100%}
fieldset label{display:flex;gap:10px;align-items:center;min-height:44px;padding:7px 10px;border:1px solid transparent;border-radius:var(--radius-2);font-size:1rem;font-weight:400;color:var(--ink);cursor:pointer}fieldset label:hover{background:var(--surface-2)}fieldset label span{min-width:0;overflow-wrap:anywhere}fieldset label small{display:block;line-height:1.3}fieldset label code{font-weight:650}label.risky{background:var(--warn-bg);border-color:var(--warn-line)}label.risky:hover{background:var(--warn-bg)}
button,.action-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border:1px solid transparent;border-radius:var(--radius-2);background:var(--accent);color:var(--on-accent);font:inherit;font-size:.94rem;font-weight:650;cursor:pointer;white-space:nowrap;text-decoration:none;transition:filter .16s ease-out,background-color .16s ease-out,border-color .16s ease-out}button:hover,.action-btn:hover{filter:brightness(1.06)}button:disabled{opacity:.6;cursor:wait}
button.approve{background:var(--green-9);color:#fff;font-weight:750}button.secondary,.action-btn{background:var(--surface);color:var(--ink);border-color:var(--line)}button.secondary:hover,.action-btn:hover{background:var(--surface-2);filter:none}
button.deny{background:transparent;color:var(--bad);border-color:var(--bad-line)}button.deny:hover{background:var(--bad-bg);filter:none}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.stub button{flex:1;min-height:50px;font-size:1rem}.stub button:first-child{flex:1.6}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}.chips input[type=text]{flex:1 1 220px;max-width:260px;margin:0}.chips label{position:relative;display:inline-flex;gap:7px;align-items:center;min-height:44px;padding:0 14px 0 10px;border:1px solid var(--line);border-radius:var(--radius-2);background:var(--surface);color:var(--ink);font-size:.88rem;font-weight:600;cursor:pointer;transition:background-color .16s ease-out,border-color .16s ease-out}
.chips label:has(:checked){background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.chips label input{position:absolute;opacity:0}
.jump-links{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.jump-links a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-2);background:var(--surface);color:var(--ink);text-decoration:none;font-size:.88rem;font-weight:600}.jump-links a:hover{background:var(--surface-2)}
details>summary{display:flex;align-items:center;min-height:44px;cursor:pointer;list-style:none;color:var(--accent);font-weight:650}summary::after{content:"";width:8px;height:8px;margin:0 4px 0 auto;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(45deg);transition:transform .16s ease-out}details[open]>summary::after{transform:rotate(225deg)}
.panel>details{border-top:1px solid var(--line);margin-top:10px}.sub-details{border-top:1px solid var(--line);margin:8px 0 14px;padding-top:4px}
.log-filter{display:flex;flex-wrap:wrap;gap:0 8px;align-items:end;margin-bottom:8px}.log-filter>label{flex:1 1 220px}.log-filter button{margin-bottom:14px}.log-filter>details{flex-basis:100%}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 12px}
.on{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}.on a:not(.action-btn){display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-round);color:var(--ink);text-decoration:none;font-size:.88rem}
.log summary{display:inline-flex;min-height:32px;gap:8px;font-size:.88rem}.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0 0 8px;font-size:.88rem}.kv dt{color:var(--dim)}.kv dd{margin:0;font:.9em var(--font-monospace-code);overflow-wrap:anywhere}
table.data-table{width:100%;border-collapse:collapse;font-size:.92rem}table.data-table th{text-align:left;color:var(--dim);font-size:.82rem;white-space:nowrap}table.data-table th,table.data-table td{padding:9px 12px 9px 0;border-top:1px solid var(--line);vertical-align:top}table.data-table td{overflow-wrap:anywhere}table.data-table td>details{margin:0}table.data-table td:first-child{overflow-wrap:normal}td.act .actions{flex-wrap:nowrap}table.data-table tr.more,table.data-table tr.more td{border-top:0;padding-top:0}.share td:first-child{padding-left:18px}.cap{text-transform:capitalize}.action-btn.primary{background:var(--accent);color:var(--on-accent);border-color:transparent}
.access th:nth-child(2){width:5.5rem}.access th:nth-child(3){width:12rem}.access th:nth-child(4){width:1%}.access td:nth-child(2){width:5.5rem}.access td:nth-child(3){width:12rem}
.auth-wrap{min-height:100dvh;display:grid;place-items:center;padding:20px}.auth{width:100%;max-width:420px;margin:0}.auth-brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:16px;font-size:1.35rem;font-weight:800;letter-spacing:-.03em}.auth-brand em{font-weight:700}.auth-brand .logo{background:light-dark(var(--indigo-10),var(--indigo-4));color:light-dark(#fff,oklch(16% .04 265))}.auth button{width:100%}.auth h2{align-items:center}
dialog{max-width:440px;width:calc(100% - 32px);padding:20px;border:1px solid var(--line);border-radius:var(--radius-3);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-4)}dialog::backdrop{background:oklch(12% .02 262 / .58)}dialog h3{margin:0 0 8px}dialog p{margin:0 0 18px;color:var(--dim)}dialog .actions{justify-content:flex-end}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media(max-width:640px){.top .in{padding:0 8px}h1{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}nav.tabs{margin-left:0}nav.tabs a{padding:0 10px}.bar>a,.bar small:not(.offline){display:none}.bar small{margin-left:auto}.logo{width:30px;height:30px}main{padding:14px 12px 56px}.panel{padding:14px}.region article{padding:14px 14px 0}.stub{margin:14px -14px 0;padding:14px}.panel.region{padding:12px}.chips input[type=text]{flex:1 1 100%;max-width:none}.list article>:not(header){margin-left:0}.list article>header{flex-wrap:wrap}.list article>header>span:not(.mark){flex-basis:calc(100% - 46px)}table.data-table thead{display:none}table.data-table,table.data-table tbody,table.data-table tr,table.data-table td{display:block;width:100%!important}table.data-table tr{padding:10px 0;border-top:1px solid var(--line)}table.data-table td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border:0;padding:3px 0;text-align:right}table.data-table td::before{content:attr(data-label);color:var(--dim);font-size:.8rem;font-weight:600;text-align:left;flex:none}table.data-table td:empty{display:none}table.data-table td:first-child{display:block;text-align:left}table.data-table td:first-child::before{display:block}table.data-table td.act{justify-content:flex-end}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}}
`

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
// relative times, Approve labels that follow the duration and selection, conditional auth header field, live-polling
// status, deep links that open the disclosure holding their target, and accessible <dialog> confirmations.
const pageScript = `const rtf = new Intl.RelativeTimeFormat(undefined, { style: 'short' })
const units = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]
Idiomorph.defaults.callbacks.beforeAttributeUpdated = (name) => name !== 'open'
const syncHeaderField = () => {
  const sel = document.querySelector('select[name=authType]')
  const box = document.querySelector('[data-auth-header]')
  if (sel && box) box.hidden = sel.value !== 'header'
}
const reveal = () => {
  const target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
  for (let d = target?.closest('details'); d; d = d.parentElement.closest('details')) d.open = true
  target?.scrollIntoView()
}
const tick = () => {
  const bar = document.querySelector('.chips')
  const items = [...document.querySelectorAll('#agents article[data-kind]')]
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
    if (match && el.matches('#agents article[data-kind]')) shown++
  })
  const emptyNote = document.getElementById('filter-empty')
  if (emptyNote) emptyNote.hidden = items.length === 0 || shown > 0
  document.querySelectorAll('time[data-local]').forEach((t) => {
    const at = new Date(t.dateTime)
    const full = at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    const secs = Math.round((at - Date.now()) / 1000)
    const [unit, size] = units.find(([, size]) => Math.abs(secs) >= size) ?? units[3]
    const today = 'short' in t.dataset && at.toDateString() === new Date().toDateString()
    t.textContent = 'rel' in t.dataset ? t.dataset.rel + rtf.format(Math.trunc(secs / size), unit) : today ? at.toLocaleTimeString([], { timeStyle: 'short' }) : full
    if ('rel' in t.dataset || today) t.title = full
  })
  document.querySelectorAll('button[data-sync]').forEach((b) => {
    const d = b.form.elements.duration.value
    b.textContent = 'Approve' + (b.form.querySelector('[name=items]:not(:checked)') ? ' selected' : '') + (d === 'permanent' ? ' until revoked' : ' for ' + d)
  })
  const pending = document.getElementById('agents')?.dataset.pending
  const badge = document.getElementById('nav-count')
  if (badge && pending !== undefined) { badge.textContent = pending; badge.hidden = pending === '0' }
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
  if (!live || elt?.id !== 'agents') return
  const ok = e.detail.successful
  live.textContent = ok ? 'Live' : 'Offline'
  live.classList.toggle('offline', !ok)
})
document.addEventListener('input', tick)
document.addEventListener('htmx:afterSwap', tick)
document.addEventListener('DOMContentLoaded', () => { tick(); reveal() })
addEventListener('hashchange', reveal)
setInterval(tick, 1000)`

const htmxConfig = JSON.stringify({
  includeIndicatorStyles: false,
  allowEval: false,
  allowScriptTags: false,
  responseHandling: [
    { code: '204', swap: false },
    { code: '.*', swap: true },
  ],
})
const head = (nonce = '') =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="htmx-config" content="${htmxConfig}"><title>Speaker for the creds</title><link rel="stylesheet" href="/admin/assets/open-props.css"><style>${raw(css)}</style><script src="/admin/assets/htmx.js"></script><script src="/admin/assets/idiomorph.js"></script><script nonce="${nonce}">${raw(pageScript)}</script></head>`

const sections = [
  ['agents', 'Agents', '/admin'],
  ['log', 'Activity', '/admin/log'],
  ['services', 'Setup', '/admin?section=services'],
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
const filterBar = html`<div class="chips" role="search" hidden><input type="text" name="q" placeholder="Filter by name or item" aria-label="Search"><label><input type="radio" name="kind" value="" checked>All</label>${Object.entries(kinds).map(([k, text]) => html`<label><input type="radio" name="kind" value="${k}">${mark(k)}${text}</label>`)}</div>`
const filterEmpty = html`<div id="filter-empty" class="panel" hidden><p>No items match this filter.</p><button type="button" class="secondary" data-clear-filter>Clear filter</button></div>`
const intros: Record<Section, string> = {
  agents: '',
  services: 'Upstream APIs, secrets, groups and SSH targets speaker manages.',
  log: '',
}
const logo = html`<span class="logo" aria-hidden="true"><svg class="ic"><use href="/admin/assets/icons.svg#i-brand"></use></svg></span>`
const confirmDialog = html`<dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body"><h3 id="confirm-title">Confirm</h3><p id="confirm-body"></p><div class="actions"><button type="button" class="secondary" data-no>Keep</button><button type="button" class="deny" id="confirm-yes" data-yes>Confirm</button></div></dialog>`
export const layout = (nonce: string | undefined, section: Section, body: Html | string, pending = 0) =>
  html`${head(nonce)}<body hx-boost="true" hx-ext="morph"><header class="top"><div class="in"><div class="bar">${logo}<h1>Speaker for the <em>creds</em></h1><nav class="tabs" aria-label="Sections">${sections.map(
    ([id, label, href]) =>
      html`<a href="${href}" ${raw(id === section ? 'aria-current="page"' : '')}>${label}${id === 'agents' ? html`<span class="count" id="nav-count" ${raw(pending ? '' : 'hidden')}>${pending}</span>` : ''}</a>`,
  )}</nav><small id="live-status">Live</small><a href="/admin">Refresh</a></div></div></header><main>${intros[section] ? html`<p><small>${intros[section]}</small></p>` : ''}${section === 'agents' ? html`${filterBar}${filterEmpty}` : ''}${typeof body === 'string' ? raw(body) : body}</main>${confirmDialog}</body></html>`

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
  '': 'No: it has its own key',
  permanent: 'Until revoked',
  none: 'None (keyless)',
  ask: 'Ask the owner',
  open: 'Open (any agent may read)',
  never: 'Never',
}
const hidden = (name: string, value: string) => html`<input name="${name}" type="hidden" value="${value}">`
const input = (name: string, label: string, type = 'text', value = '') =>
  // A credential is masked text, not a password field, so the browser does not offer to save it as a login.
  type === 'password'
    ? html`<label>${label}<input name="${name}" type="text" value="${value}" class="masked" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true"></label>`
    : html`<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`
const select = (name: string, label: string, values: readonly string[], chosen = '') =>
  html`<label>${label}<select name="${name}">${values.map((value) => html`<option value="${value}" ${raw(value === chosen ? 'selected' : '')}>${labels[value] ?? value}</option>`)}</select></label>`
const area = (name: string, label: string, value = '', rows = 2) =>
  html`<label>${label}<textarea name="${name}" rows="${rows}">${value}</textarea></label>`
const button = (action: string, fields: Html | string, label: string, confirm = '', kind = 'secondary') =>
  html`<form method="post" action="${action}" ${raw(confirm ? `hx-confirm="${String(html`${confirm}`)}"` : '')}>${fields}<button class="${kind}">${label}</button></form>`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
// A local-time stamp the page script rewrites; with `rel` it reads as relative time (`rel` is the text before it).
const local = (ms: number, rel?: string, short = false) =>
  html`<time datetime="${new Date(ms).toISOString()}" data-local ${raw(rel === undefined ? (short ? 'data-short' : '') : `data-rel="${rel}"`)}>${time(ms)} UTC</time>`
const registered = (h: { source: string; registeredAt: number }) =>
  html`from ${h.source} · registered ${local(h.registeredAt)}`
const empty = (text: string) => html`<p><small>${text}</small></p>`

type Card = View['cards'][number]
type Grant = View['grants'][number]
const enforcing = { sent: 'Approved, applying', 'host-offline': 'Host unavailable; enforcement unconfirmed' }
const uses = (n: number, query: string) =>
  n ? html`<a href="/admin/log?${query}">${plural(n, 'use', 'uses')}</a>` : 'unused'
const span = (ms: number) =>
  ms % 86_400_000 === 0
    ? `${ms / 86_400_000}d`
    : ms % 3_600_000 === 0
      ? `${ms / 3_600_000}h`
      : `${Math.round(ms / 60_000)}m`
const access = ({ item }: Grant) => {
  const write = /\.full$|:rw$/.test(item)
  return write || /\.read$|^folder:/.test(item)
    ? html`<abbr title="${write ? 'read and change' : 'read only'}">${write ? 'R/W' : 'R'}</abbr>`
    : item.split(/[.:]/)[0]
}

// The Agents panel: what needs a decision, then each agent with its access beneath it, then the quiet rest. The one
// view gives every count; the panel is morphed every 5 seconds. Request cards are hx-preserve, so unticked items, a
// chosen duration and an open Review stay.
export function agents(
  { hosts, agents: all, cards, grants, sessions }: View,
  groups: Record<string, Group>,
  connected: Set<string>,
) {
  const byId = new Map(all.map((a) => [a.id, a]))
  const title = (a: View['agents'][number]) => (a.title ? html` <small>${a.title}</small>` : '')
  const machine = (a: View['agents'][number] | undefined) => a?.sandboxHost ?? 'machine unknown'
  // An agent whose identity (same label and agent string) enrolled in the 30 minutes before it.
  const twin = (a: View['agents'][number] | undefined) => {
    const earlier = a
      ? all.filter(
          (o) =>
            o.id !== a.id &&
            o.label === a.label &&
            o.agent === a.agent &&
            a.createdAt - o.createdAt > 0 &&
            a.createdAt - o.createdAt < 1_800_000,
        )
      : []
    return a && earlier.length
      ? html` <mark>same agent enrolled ${Math.round((a.createdAt - Math.max(...earlier.map((o) => o.createdAt))) / 60_000)} min earlier</mark>`
      : ''
  }
  const pick = (i: Card['items'][number]) =>
    html`<label class="${i.risk ? 'risky' : ''}"><input type="checkbox" name="items" value="${i.item}" checked>${mark(icons[i.kind] ? i.kind : 'host')}<span><code>${i.item}</code>${i.with ? html` <small>(needed by ${i.with}; ends with it)</small>` : ''}${i.risk ? html` <span class="badge badge-warn">${i.risk}</span>` : ''} <small>${i.text}</small>${i.warning ? html` <mark>${i.warning}</mark>` : ''}</span></label>`
  // Self-reported identity and what speaker itself knows stay on separate, labelled lines.
  const meta = ({ who, type, subject }: Card) =>
    type === 'host'
      ? html`<small class="card-meta" id="host-${subject}">${registered({ source: who.source, registeredAt: who.at as number })}</small>`
      : html`${who.says !== undefined ? html`<small class="card-meta">Self-reported: says it is ${who.says}${who.via ? ` · via ${who.via}` : ''}</small>` : ''}<small class="card-meta">Speaker-known: from ${who.source}${who.key ? html` · key <code>${who.key}</code>` : ''}${twin(byId.get(subject))}</small>`
  const cardHtml = (r: Card) => {
    const host = r.type === 'host'
    const a = byId.get(r.subject)
    // The groups the request asked for, each with the members still pending, then the items asked for on their own.
    const asked = r.want
      .filter((w) => w.startsWith('group:') && Object.hasOwn(groups, w.slice(6)))
      .map((w) => ({ name: w.slice(6), ...groups[w.slice(6)] }))
      .map((g) => ({ ...g, members: r.items.filter((i) => g.items.includes(i.item)) }))
      .filter((g) => g.members.length)
    const loose = r.items.filter((i) => !asked.some((g) => g.members.includes(i)))
    const sets = html`${asked.map(
      (g) =>
        html`<fieldset><legend><label><input type="checkbox" data-all checked><strong>${g.name}</strong> <small>${g.description ? `${g.description} · ` : ''}${plural(g.members.length, 'item', 'items')}</small></label></legend>${g.members.map(pick)}</fieldset>`,
    )}${loose.length ? html`<fieldset>${asked.length ? html`<legend>Not in a group</legend>` : ''}${loose.map(pick)}</fieldset>` : ''}`
    const duration =
      r.durations.length > 1
        ? select('duration', 'Allow access for', r.durations, r.duration)
        : hidden('duration', r.durations[0])
    const some = r.items.slice(0, 3).map((i) => i.item)
    // A bundle reads as its name, size and a scope summary, with every server warning outside the Review; loose items show directly.
    const bundle = asked.length
      ? html`<p class="scope"><strong>${asked.map((g) => g.name).join(', ')}</strong> · ${plural(r.items.length, 'capability', 'capabilities')} · <small>${some.join(', ')}${r.items.length > 3 ? ` and ${r.items.length - 3} more` : ''}</small></p>${r.items.filter((i) => i.risk || i.warning).map((i) => html`<p class="alert"><code>${i.item}</code> ${i.risk ? html`<span class="badge badge-warn">${i.risk}</span>` : ''} ${i.warning ? html`<mark>${i.warning}</mark>` : ''}</p>`)}`
      : ''
    return html`<article id="request-${r.id}" hx-preserve data-kind="${[...new Set(r.items.map((i) => i.kind))].join(' ')}"><header><div class="card-head"><strong>${a ? a.label : r.who.label}</strong>${a ? title(a) : ''}<small>${host ? 'wants to register' : html`${machine(a)} · ${local(r.createdAt, 'requested ')}`}</small></div>${meta(r)}</header>${host ? '' : html`<p class="reason"><span class="reason-label">Reason</span> ${r.reason || html`<small>none supplied yet</small>`}</p>`}${bundle}<form method="post" action="/admin/requests/${r.id}/approve">${r.items.map((i) => hidden('shown', i.item))}${asked.length ? html`<details class="sub-details"><summary>Review ${plural(r.items.length, 'capability', 'capabilities')}</summary>${sets}</details>` : sets}<div class="stub">${duration}<div class="actions"><button class="approve" ${raw(host ? '' : 'data-sync')}>${host ? 'Approve host' : `Approve ${r.duration === 'permanent' ? 'until revoked' : `for ${r.duration}`}`}</button><button class="deny" formaction="/admin/requests/${r.id}/deny">${host ? 'Deny host' : 'Deny'}</button></div></div></form>${r.trigger ? html`<footer><small>Triggered by <code>${r.trigger}</code></small></footer>` : ''}</article>`
  }

  const end = (g: { expiresAt: string | null }) => (g.expiresAt ? Date.parse(g.expiresAt) : Number.POSITIVE_INFINITY)
  const row = (
    id: string,
    kind: string,
    endpoint: Html | string,
    scope: Html | string,
    expires: Html | string,
    actions: Html | string = '',
  ) =>
    html`<tr ${raw(id ? `id="${id}"` : '')} data-kind="${kind}"><td data-label="Endpoint">${endpoint}</td><td data-label="Access">${scope}</td><td data-label="Expires">${expires}</td><td class="act"><div class="actions">${actions}</div></td></tr>`
  const grantRow = (g: Grant) =>
    row(
      `grant-${g.id}`,
      g.kind,
      html`<code>${g.item}</code>${g.bundledWith.length ? html` <small>(comes with ${g.bundledWith.join(', ')} and ends with it)</small>` : ''}<br><small>${g.detail.text}${g.uses ? html` · ${uses(g.uses, `grant=${encodeURIComponent(g.id)}`)}` : ''}</small>${g.detail.warning ? html` <mark>${g.detail.warning}</mark>` : ''}`,
      access(g),
      html`${g.expiresAt === null ? html`<mark>Until revoked</mark>` : local(Date.parse(g.expiresAt), 'Expires ')}${enforcing[g.enforcement as keyof typeof enforcing] ? html`<br><mark data-state="${g.enforcement}">${enforcing[g.enforcement as keyof typeof enforcing]}</mark>` : ''}`,
      html`${g.expiresAt !== null && g.grantedMs !== undefined ? button('/admin/grants/extend', hidden('id', g.id), `Extend by ${span(g.grantedMs)}`) : ''}${button('/admin/grants/revoke', hidden('id', g.id), 'Revoke', `Revoke ${g.item} for ${g.label}? Calls using it are blocked immediately.`)}`,
    )
  const agentBlock = (a: View['agents'][number]) => {
    const mine = grants.filter((g) => g.subject === a.id).sort((x, y) => end(x) - end(y))
    const open = sessions.filter((s) => s.agent === a.id)
    const c = a.counts
    const odd = [c.refused && `${c.refused} refused`, c.blocked && `${c.blocked} blocked`].filter(Boolean).join(' · ')
    const held = a.launched ?? []
    return html`<article id="agent-${a.id}" data-kind="${[...new Set([...mine.map((g) => g.kind), ...open.map(() => 'ssh'), ...held.map(() => 'ext')])].join(' ')}"><header>${mark('agent')}<span><strong>${a.label}</strong>${title(a)} <small>${machine(a)} · ${a.agent}</small><br><small>${mine.some((g) => g.enforcement === 'enforced') ? 'Access live' : mine.length ? 'Access not yet confirmed in force' : 'No current grants'} · ${a.lastUsedAt ? local(a.lastUsedAt, 'last used ') : 'unused'}${odd ? html` · <a class="warn" href="/admin/log?agent=${encodeURIComponent(a.id)}" title="${c.lastRefusal ?? ''}">${odd}</a>` : ''}${cards.filter((r) => r.subject === a.id).map((r) => html` · <a href="#request-${r.id}"><mark>request waiting</mark></a>`)}</small></span></header>${
      mine.length || open.length || held.length
        ? html`<table class="data-table access"><thead><tr><th scope="col">Endpoint</th><th scope="col">Access</th><th scope="col">Expires</th><th scope="col">Actions</th></tr></thead><tbody>${held.map((item) => row('', 'ext', html`<code>${item}</code><br><small>Given at launch by the template${a.sandboxHost ? ` on ${a.sandboxHost}` : ''}; the sandbox host holds it for the whole task, so it is not revoked here (revoke the agent to end it)</small>`, 'ext', 'For the task'))}${mine.map(grantRow)}${open.map((s) => row('', 'ssh', html`<code>${s.what}</code><br><small>SSH session</small>`, 'ssh', local(s.started, 'Open since '), button('/admin/ssh/sessions/end', hidden('id', s.id), 'End', `End this SSH session now? ${s.what}`)))}</tbody></table>`
        : ''
    }<details class="sub-details"><summary>Details and agent controls</summary><p><small>Name it reported: ${a.label}<br>Identity it reported: ${a.agent}<br>Id <code>${a.id}</code> · enrolled ${local(a.createdAt)} from ${a.source}${a.sandboxHost ? ` via sandbox host ${a.sandboxHost}` : ''}<br>${uses(a.uses, `agent=${encodeURIComponent(a.id)}`)}${a.lastUsedAt ? html`, last used ${local(a.lastUsedAt)}` : ''}<br>${plural(c.requests, 'request', 'requests')} · ${c.granted} granted · ${c.denied} denied · ${c.refused} refused · ${c.blocked} blocked</small></p>${button(`/admin/agents/${a.id}/revoke`, '', 'Revoke agent', `Revoke agent ${a.label}? Its token and all its grants end immediately.`)}</details></article>`
  }
  const idle = (a: View['agents'][number]) =>
    !grants.some((g) => g.subject === a.id) &&
    !sessions.some((s) => s.agent === a.id) &&
    !a.launched?.length &&
    !cards.some((r) => r.subject === a.id)
  const current = all.filter((a) => !idle(a))
  const rest = all.filter(idle)
  const approved = hosts.filter((h) => h.grant)
  return String(
    html`<section id="agents" hx-get="/admin/panel/agents" hx-trigger="every 5s" hx-swap="morph:outerHTML" data-pending="${cards.length}"><p class="status"><strong>${plural(all.length, 'agent', 'agents')}</strong> · ${cards.length ? html`<a href="#needs"><mark>${plural(cards.length, 'request', 'requests')} waiting for a decision</mark></a>` : 'no decisions waiting'}</p>${cards.length ? html`<section id="needs" class="panel region"><h2>Needs attention <small class="count">${cards.length}</small></h2><div class="cards">${cards.map(cardHtml)}</div></section>` : ''}<section id="current" class="panel"><h2>Current agents ${current.length ? html`<small class="count">${current.length}</small>` : ''}</h2>${current.length ? html`<div class="list">${current.map(agentBlock)}</div>` : empty('No agent has current access. Agents and the access you grant appear here until it expires or you revoke it.')}<p><small>Expiry and revocation block new calls; a response already streaming may finish.</small></p></section>${rest.length ? html`<details id="idle" class="panel"><summary>No current access (${rest.length})</summary><div class="list">${rest.map(agentBlock)}</div></details>` : ''}${approved.length ? html`<details id="hosts" class="panel"><summary>Hosts (${approved.length})</summary><table class="data-table"><thead><tr><th scope="col">Host</th><th scope="col">Trust</th><th scope="col">Connection</th><th scope="col">Supported kinds</th><th scope="col">Details</th></tr></thead><tbody>${approved.map((h) => html`<tr id="host-${h.id}"><td data-label="Host"><strong>${h.name}</strong></td><td data-label="Trust">Approved</td><td data-label="Connection">${connected.has(h.id) ? 'Connected' : 'Not connected'}</td><td data-label="Kinds">${h.kinds.join(' ') || 'none'}</td><td data-label="Details"><details><summary>Details and removal</summary><p><small>Id <code>${h.id}</code> · ${registered(h)}</small></p>${button(`/admin/hosts/${h.id}/remove`, '', 'Remove host', `Remove sandbox host ${h.name}? Its agents and their grants end immediately.`)}</details></td></tr>`)}</tbody></table></details>` : ''}</section>`,
  )
}

const groupErrors: Record<string, string> = {
  empty: 'Group not saved: list at least one item, one per line.',
  line: 'Group not saved: each line must be an item: <service>.read, <service>.full, site:<host>, secret:<NAME>, ssh:<target>, folder:<share>[:rw], mcp:<id> or ext:<id>.',
  id: 'Group not saved: the id may use letters, numbers, - and _ (up to 64 characters).',
  description: 'Group not saved: keep the description to one line of at most 200 characters.',
}
const td = (label: string, body: Html | string, cls = '') => html`<td data-label="${label}" class="${cls}">${body}</td>`
const act = (...buttons: (Html | string)[]) => html`<td class="act"><div class="actions">${buttons}</div></td>`
// A disclosure row under its table row, spanning every column.
const more = (cols: number, summary: string, body: Html) =>
  html`<tr class="more"><td colspan="${cols}"><details><summary>${summary}</summary>${body}</details></td></tr>`
const table = (heads: string[], rows: Html[], cls = '') =>
  html`<table class="data-table ${cls}"><thead><tr>${heads.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table>`
// The first two entries, one per line; the rest behind "N more".
const preview = (items: string[], mono = false) => {
  const one = (i: string) => html`<div>${mono ? html`<code>${i}</code>` : i}</div>`
  return html`${items.slice(0, 2).map(one)}${items.length > 2 ? html`<details><summary>${items.length - 2} more</summary>${items.slice(2).map(one)}</details>` : ''}`
}
const consequence = (text: string) => html`<p><small>${text}</small></p>`

export function setup({ services, keyed, owned, groups, ssh, mcp, selected, error }: Setup) {
  const chosen = selected && Object.hasOwn(services, selected) ? services[selected] : undefined
  const authType = chosen?.auth.type ?? 'bearer'
  const hasAdvanced = Boolean(chosen?.readPaths?.length || chosen?.mcp || chosen?.notes)
  const serviceForm = html`<form method="post" action="/admin/services/save">${input('id', 'Service id', 'text', chosen ? selected : '')}${input('baseUrl', 'Upstream base URL', 'url', chosen?.baseUrl)}${select('authType', 'Authentication (path = secret is a URL segment, e.g. a webhook id; none = keyless service)', ['bearer', 'header', 'basic', 'path', 'none'], authType)}<div data-auth-header ${raw(authType === 'header' ? '' : 'hidden')}>${input('headerName', 'Credential header', 'text', chosen?.auth.type === 'header' ? chosen.auth.headerName : '')}</div>${input('secret', 'Credential (blank keeps current)', 'password')}${select('keyFrom', 'Or use the key of a wider service this one narrows (same site, under its address)', ['', ...Object.keys(services).filter((id) => id !== selected && services[id].auth.type !== 'none' && services[id].auth.secret === id)], chosen && chosen.auth.type !== 'none' && chosen.auth.secret !== selected ? chosen.auth.secret : '')}${select('read', 'Read rule (GET / HEAD / OPTIONS)', ['ask', 'open', 'never'], chosen?.read ?? 'ask')}${select('write', 'Write rule (all other methods)', ['ask', 'never'], chosen?.write ?? 'ask')}<details class="sub-details" ${raw(hasAdvanced ? 'open' : '')}><summary>Advanced options (read paths, MCP, notes)</summary>${area('readPaths', 'POST paths that only read, one per line (for example a search endpoint)', chosen?.readPaths?.join('\n'))}<label><input type="checkbox" name="mcp" ${raw(chosen?.mcp ? 'checked' : '')}> MCP server (streamable HTTP): classify tool calls by their read-only hints</label>${area('notes', 'Notes for agents (markdown, optional)', chosen?.notes, 5)}</details>${consequence('Saving ends any grant that now reaches further or is no longer allowed.')}<button>Save service</button></form>`
  const tools = (id: string) =>
    html`<div class="actions">${error === 'tools' ? html`<p class="warn" role="alert">Could not list tools; check the URL and credential.</p>` : ''}<small>${mcp[id] ? `Tools: ${mcp[id].read} read · ${mcp[id].write} write${mcp[id].unannotated ? ` (${mcp[id].unannotated} without hints, treated as write)` : ''}` : 'Tools not listed yet'}</small>${button('/admin/services/tools', hidden('id', id), 'Refresh tools')}</div>`
  const serviceRows = Object.entries(services).map(([id, s]) => {
    const q = encodeURIComponent(id)
    const key =
      s.auth.type === 'none'
        ? 'Not needed'
        : s.auth.secret !== id
          ? `${keyed.has(id) ? 'Key of' : 'Missing: key of'} ${s.auth.secret}`
          : keyed.has(id)
            ? 'Set'
            : 'Missing'
    return html`<tr>${td('Name', html`<strong>${id}</strong>${s.mcp ? html`<br><small>MCP server</small>` : ''}`)}${td('Endpoint', s.baseUrl)}${td('Read policy', s.read, 'cap')}${td('Write policy', s.write, 'cap')}${td('Credential', s.auth.type === 'path' && key === 'Set' ? 'Set (in URL path)' : key)}${act(html`<a class="action-btn primary" href="/admin?section=services&amp;service=${q}">Edit</a>`, html`<a class="action-btn" href="/admin/log?service=${q}">Activity</a>`, button('/admin/services/delete', hidden('id', id), 'Delete', `Delete service ${id}? Its credential is erased and its grants and pending requests are removed.`))}</tr>`
  })
  const secretForm = (name = '', o?: { hosts: string[]; env: string }) =>
    html`<form method="post" action="/admin/secrets/save">${input('name', 'Name (agents ask for secret:NAME)', 'text', name)}${input('env', 'Environment variable the agent sees', 'text', o?.env)}${area('hosts', 'Allowed hosts, one per line', o?.hosts.join('\n'))}${consequence('Adding a host ends the grants already given for this secret.')}${input('value', o ? 'Replace value; blank keeps current' : 'Value (never shown again)', 'password')}<button>Save secret</button></form>`
  const secretRows = Object.entries(owned).flatMap(([name, o]) => [
    html`<tr>${td('Name', html`<strong>${name}</strong>`)}${td('Allowed destinations', preview(o.hosts))}${td('Agent variable', html`<code>${o.env}</code>`)}${act(button('/admin/secrets/delete', hidden('name', name), 'Delete', `Delete secret ${name}? Its value is erased.`))}</tr>`,
    more(4, 'Edit', secretForm(name, o)),
  ])
  const targets = Object.entries(ssh.targets)
  const shareRow = ([name, share]: [string, SshSetup['shares'][string]]) =>
    html`<tr class="share">${td('Name', html`<strong>${name}</strong> <small>share</small>`)}${td('Address', html`<code>${share.path}</code>`)}${td('Files', 'Delivered over SSH')}${td('Warnings', ssh.targets[share.target] ? (ssh.targets[share.target].home === share.path ? html`<mark>home directory</mark>` : '') : html`<mark>unknown target ${share.target}</mark>`)}${act(button('/admin/ssh/shares/delete', hidden('name', name), 'Delete', `Delete share ${name}? Open sessions and grants for it end.`))}</tr>`
  const shares = Object.entries(ssh.shares)
  const sshRows = [
    ...targets.flatMap(([alias, t]) => [
      html`<tr>${td('Name', html`<strong>${alias}</strong>`)}${td('Address', `${t.account}@${t.host}:${t.port}`)}${td('Files', t.sftp ? 'SFTP available' : 'None')}${td('Warnings', html`${t.account === 'root' ? html`<mark>root</mark> ` : ''}${t.sudo ? html`<mark>passwordless sudo works</mark> ` : ''}${t.sftp ? '' : html`<mark>no file delivery: no sftp-server found</mark>`}`)}${act(button('/admin/ssh/targets/delete', hidden('alias', alias), 'Delete', `Delete target ${alias}? Its shares go too, and open sessions and grants for them end.`))}</tr>`,
      more(
        5,
        'Details',
        html`<p><small>Host key <code>${t.fingerprint}</code><br>${t.sftp ? html`sftp-server <code>${t.sftp}</code><br>` : ''}authorized_keys line <code>${t.line}</code></small></p><form method="post" action="/admin/ssh/targets/from" class="actions">${hidden('alias', alias)}${input('from', 'Addresses speaker connects from (comma-separated)', 'text', t.from)}<button class="secondary">Save addresses</button></form>`,
      ),
      ...shares.filter(([, share]) => share.target === alias).map(shareRow),
    ]),
    ...shares.filter(([, share]) => !ssh.targets[share.target]).map(shareRow),
  ]
  const sshPanel = html`${ssh.error ? html`<p class="warn" role="alert">${ssh.error}</p>` : ''}<p><small>Speaker's public key is <code>${ssh.publicKey ?? 'available after sign-in'}</code>. On each target, add <code>from="&lt;speaker's address&gt;",restrict &lt;that key&gt;</code> to the <code>authorized_keys</code> of the account speaker should use; a limited account (not root, no sudo) is best. Adding a target pins its host key, so add the line first.</small></p>${sshRows.length ? table(['Target / share', 'Address / path', 'Files', 'Warnings', 'Actions'], sshRows) : empty('No SSH targets.')}<details><summary>Add a target</summary><form method="post" action="/admin/ssh/targets/add">${input('alias', 'Name agents ask for (ssh:NAME)')}${input('host', 'Host name or address')}${input('port', 'SSH port', 'number', '22')}${input('account', 'Account speaker uses there')}${input('from', 'Addresses speaker connects from (blank: detected)')}${input('sftp', 'sftp-server path (blank: probed)')}<label><input type="checkbox" name="confirmRoot"> I understand: root has no limits</label><button>Add target</button></form></details><details><summary>Add a share</summary><form method="post" action="/admin/ssh/shares/save">${input('name', 'Name agents ask for (folder:NAME)')}${select(
    'target',
    'Target',
    targets.map(([alias]) => alias),
  )}${input('path', 'Absolute path on the target')}<button>Save share</button></form></details>`
  const groupForm = (id: string, group: Group) =>
    html`<form method="post" action="/admin/groups/save">${input('id', 'Group id', 'text', id)}${input('description', 'Description (one line, optional)', 'text', group.description)}${area('items', 'Items, one per line', group.items.join('\n'), 5)}<button>Save group</button></form>`
  const groupRows = Object.entries(groups).flatMap(([id, group]) => [
    html`<tr>${td('Group', html`<strong>${id}</strong><br><small>${plural(group.items.length, 'item', 'items')}</small>`)}${td('Purpose', group.description ?? '')}${td('Members', preview(group.items, true))}${act(button('/admin/groups/delete', hidden('id', id), 'Delete', `Delete group ${id}? Agents can no longer request it. Existing grants stay.`))}</tr>`,
    more(4, 'Edit', groupForm(id, group)),
  ])
  const jumpNav = html`<nav class="jump-links" aria-label="Setup sections"><a href="#setup-services">Services</a><a href="#setup-secrets">Secrets</a><a href="#groups">Groups</a><a href="#setup-ssh">SSH targets and shares</a><a href="/admin#hosts" hx-boost="false">Hosts</a><a href="#setup-password">Owner security</a></nav>`
  return html`${jumpNav}<section class="panel" id="setup-services"><h2>Services</h2><p><small>A service is an upstream API speaker proxies: it adds the credential to each call, so the agent never holds it.</small></p>${chosen ? html`<article><h3>Edit service: ${selected}</h3>${serviceForm}${chosen.mcp ? tools(selected ?? '') : ''}</article>` : ''}${serviceRows.length ? table(['Name', 'Endpoint', 'Read policy', 'Write policy', 'Credential', 'Actions'], serviceRows) : empty('No services configured. Add a service to let agents request access to an upstream API.')}${chosen ? '' : html`<details><summary>Add service</summary>${serviceForm}</details>`}</section><section class="panel" id="setup-secrets"><h2>Secrets</h2><p><small>A secret is a value speaker inserts into an agent's requests, only to the hosts you allow; the agent sees just a variable holding a placeholder.</small></p>${secretRows.length ? table(['Name', 'Allowed destinations', 'Agent variable', 'Actions'], secretRows) : empty('No secrets yet.')}<details><summary>Add a secret</summary>${secretForm()}</details></section><section class="panel" id="groups"><h2>Groups</h2>${groupErrors[error ?? ''] ? html`<p class="warn" role="alert">${groupErrors[error ?? '']}</p>` : ''}${groupRows.length ? table(['Group', 'Purpose', 'Members', 'Actions'], groupRows) : empty('No groups. A group collects items so an agent can request them with one approval.')}<details><summary>Add group</summary>${groupForm('', { items: [] })}</details><p><small>A group is what an agent may ask for; a bottle template sets the VM size and attended mode and names the group to request at launch. Changes apply to new requests; requests already pending keep their items. Deleting a group does not end existing grants.</small></p></section><section class="panel" id="setup-ssh"><h2>SSH targets and shares</h2>${sshPanel}</section><section class="panel" id="setup-password"><h2>Owner security</h2><details><summary>Change owner password</summary><form method="post" action="/admin/password">${password('current', 'Current password', 'current-password')}${password('password', 'New password', 'new-password')}${password('confirm', 'Repeat the new password', 'new-password')}<button>Change password</button></form></details></section><p><small>Credentials stay on this server.</small></p>`
}

const s = (value: unknown) => String(value ?? '')
const clip = (text: string, n = 70) => (text.length > n ? `${text.slice(0, n)}…` : text)
// Overview of an event: its destination (service, target or share) apart from the exact call or command.
const what = (e: LogEntry): Html | '' => {
  if (e.event === 'ssh_file') return html`${s(e.share ?? e.target)}<br><code>${s(e.op)} ${clip(s(e.path))}</code>`
  if (e.event === 'ssh_session') return html`${s(e.share ?? e.target)}<br><code>${clip(s(e.command ?? 'sftp'))}</code>`
  if (e.event === 'ssh_refused')
    return html`${e.command ? html`<code>${clip(s(e.command))}</code> ` : ''}<small>${s(e.why)}</small>`
  if (e.event === 'request_unavailable') return html`<code>${s(e.item)}</code> <small>${s(e.why)}</small>`
  if (e.event === 'proxy')
    return html`${s(e.service)}${e.mcp ? ` · ${s(e.mcp)}` : ''}<br><code>${s(e.method)} ${clip(s(e.path))}</code>`
  const list = [
    e.item,
    ...(Array.isArray(e.items) ? e.items : []),
    ...(Array.isArray(e.granted) ? e.granted : []),
  ].filter(Boolean)
  if (!list.length && !e.reason) return ''
  return html`${list.length ? html`<code>${list.join(', ')}</code>` : ''}${e.reason ? html` <small>${s(e.reason)}</small>` : ''}`
}
// What happened, in words that keep an upstream error, a refusal and an owner decision apart.
const result = (e: LogEntry): Html | string => {
  if (e.event === 'proxy')
    return Number(e.status) >= 400 ? html`<mark>Upstream HTTP ${s(e.status)}</mark>` : `HTTP ${s(e.status)}`
  if (e.event === 'upstream_failed') return html`<mark>Upstream unreachable</mark>`
  if (e.event === 'request_unavailable') return 'Refused before approval'
  if (e.event.endsWith('_failed')) return html`<span class="warn">Fault</span>`
  if (e.event.endsWith('_refused')) return html`<span class="warn">Access denied</span>`
  return /^(grant|request)_/.test(e.event) ? 'Grant decision' : ''
}
export function log(
  entries: LogEntry[],
  total: number,
  query: Record<string, string | undefined>,
  choices: Record<string, [string, string][]>,
) {
  const names = Object.fromEntries(Object.entries(choices).map(([n, o]) => [n, new Map(o)]))
  const who = (e: LogEntry) => (e.agent ? (names.agent.get(e.agent) ?? e.label ?? '') : '')
  // An id that is no longer current stays selected and shown, so the filter is not silently dropped.
  const choose = (name: string, options: [string, string][]) => {
    const v = query[name]
    const all = v && !names[name].has(v) ? [...options, [v, `${v} (not current)`]] : options
    return html`<label>${name[0].toUpperCase() + name.slice(1)}<select name="${name}"><option value="">Any</option>${all.map(([value, text]) => html`<option value="${value}" ${raw(v === value ? 'selected' : '')}>${text}</option>`)}</select></label>`
  }
  const on = ['q', ...Object.keys(choices)].filter((n) => query[n])
  const without = (n: string) =>
    `/admin/log?${new URLSearchParams(on.filter((o) => o !== n).map((o) => [o, query[o] ?? '']))}`
  const rows = entries.map((e) => {
    const detail = what(e)
    return html`<tr>${td('Time', local(Date.parse(e.time), undefined, true))}${td('Agent', who(e))}${td('Operation / target', html`${e.event === 'proxy' ? '' : e.event.replaceAll('_', ' ')}${detail && e.event !== 'proxy' ? ': ' : ''}${detail}<details><summary>Details</summary><dl class="kv">${Object.entries(e).map(([k, v]) => html`<dt>${k}</dt><dd>${typeof v === 'string' ? v : JSON.stringify(v)}</dd>`)}</dl></details>`)}${td('Result', result(e))}</tr>`
  })
  return html`<section class="panel"><h2>Activity <small class="count">${plural(total, 'entry', 'entries')}${total > entries.length ? `, newest ${entries.length} of ${total} shown` : ', newest first'}</small></h2><form method="get" action="/admin/log" class="log-filter"><label>Search<input type="search" name="q" value="${query.q ?? ''}"></label><button>Apply</button><details><summary>Filters${on.length - (query.q ? 1 : 0) ? ` (${on.length - (query.q ? 1 : 0)} active)` : ''}</summary><div class="filters">${Object.entries(choices).map(([name, options]) => choose(name, options))}</div></details></form>${on.length ? html`<p class="on">${on.map((n) => html`<a href="${without(n)}" aria-label="Remove ${n} filter">${n === 'q' ? 'Search' : n[0].toUpperCase() + n.slice(1)}: ${n === 'q' ? query.q : (names[n].get(query[n] ?? '') ?? query[n])} ×</a>`)}<a class="action-btn" href="/admin/log">Clear filters</a></p>` : ''}${
    entries.length
      ? table(['Time', 'Agent', 'Operation / target', 'Result'], rows, 'log')
      : on.length
        ? empty('No events match these filters.')
        : empty('No events yet. Calls and decisions appear here as they happen.')
  }</section>`
}
