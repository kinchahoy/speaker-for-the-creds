import { html, raw } from 'hono/html'
import type { Bundle, Capability, LogEntry, Provider, View } from './server.ts'

const kindNames = ['credential', 'secret', 'site', 'folder', 'mcp', 'extension'] as const
const input = (name: string, label: string, type = 'text', value = '') =>
  html`<label>${label}<input name="${name}" type="${type}" value="${value}" ${raw(type === 'password' ? 'autocomplete="new-password"' : '')}></label>`
const select = (name: string, label: string, values: readonly string[], chosen = '') =>
  html`<label>${label}<select name="${name}">${values.map((value) => html`<option value="${value}" ${raw(value === chosen ? 'selected' : '')}>${({ permanent: 'Until revoked', approval: 'Require approval', always: 'Always allow', deny: 'Deny' } as Record<string, string>)[value] ?? value}</option>`)}</select></label>`
// `confirm` makes the browser ask in a native dialog before posting; without JS the form posts directly.
const form = (action: string, fields: unknown, button: string, kind = 'inline', name = '', confirm = '') =>
  html`<form class="${kind}" method="post" action="${action}" ${raw(confirm ? `data-confirm="${String(html`${confirm}`)}"` : '')}>${fields}<button ${raw(name ? `aria-label="${String(html`${name}`)}"` : '')}>${button}</button></form>`
// The owner's quiet Extend button next to Revoke; only when there is an end and a span to add.
const spanLabel = (ms: number) =>
  ms % 86_400_000 === 0
    ? `${ms / 86_400_000}d`
    : ms % 3_600_000 === 0
      ? `${ms / 3_600_000}h`
      : `${Math.round(ms / 60_000)}m`
const extend = (
  action: string,
  fields: unknown,
  expiresAt: string | null,
  grantedMs: number | undefined,
  name: string,
) =>
  expiresAt !== null && grantedMs !== undefined
    ? form(
        action,
        fields,
        `Extend ${spanLabel(grantedMs)}`,
        'inline quiet',
        `Extend ${name} by ${spanLabel(grantedMs)}`,
      )
    : ''
const durations = ['15m', '30m', '1h', '1d', '7d', '30d', '90d']
const permanentOverride = html`<label class="override" title="Creates a permanent lease that stays until revoked"><input type="checkbox" name="permanent"> Allow until revoked</label>`

const sprite = `<svg class="sprite" aria-hidden="true" focusable="false"><defs>
<symbol id="i-brand" viewBox="0 0 24 24"><circle cx="7" cy="14" r="3.2"/><path d="m9.4 11.8 8.100-8.100M14.500 6.700l2.500 2.500M17.200 4l2.500 2.500M3.200 8.500a6 6 0 0 1 3-3M2 4.800a9 9 0 0 1 4-2.700"/></symbol><symbol id="i-credential" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.200-9.200M17 6l3 3m-5-1 2 2"/></symbol>
<symbol id="i-secret" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
<symbol id="i-site" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.200 3 14.800 0 18M12 3c-3 3.200-3 14.800 0 18"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
<symbol id="i-mcp" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></symbol>
<symbol id="i-extension" viewBox="0 0 24 24"><path d="M4 8h4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4H4z"/></symbol>
<symbol id="i-enforcer" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 4.500-3.200 8-8 9-4.800-1-8-4.500-8-9V6z"/><path d="m9 12 2 2 4-4"/></symbol>
<symbol id="i-session" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2-3 2M13 15h4"/></symbol>
<symbol id="i-ssh" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13l3 2-3 2"/></symbol>
</defs></svg>`

const liveScript = `
const $ = (selector) => document.querySelector(selector);
const status = $('#live-status'), dialog = $('#confirm'), search = $('#q');
const choices = new Map(), opened = new Set(), kinds = new Set();
let target = null;
const ladder = [900, 1800, 3600, 86400, 604800, 2592000];
const short = (seconds) => seconds >= 86400 ? Math.ceil(seconds / 86400) + 'd' : seconds >= 3600 ? Math.ceil(seconds / 3600) + 'h' : seconds >= 60 ? Math.ceil(seconds / 60) + 'm' : seconds + 's';
function filter() {
  const query = (search ? search.value : '').trim().toLowerCase();
  document.querySelectorAll('ul.rows').forEach((list) => {
    let total = 0, shown = 0;
    list.querySelectorAll(':scope > li[data-search]').forEach((row) => {
      total++;
      const match = row.dataset.search.includes(query) && (!kinds.size || row.dataset.kinds.split(' ').some((kind) => kinds.has(kind)));
      row.hidden = !match;
      if (match) shown++;
    });
    list.toggleAttribute('data-nomatch', total > 0 && !shown);
  });
}
function count(pending) {
  const badge = $('#pending-count');
  if (badge) { badge.textContent = pending; badge.hidden = !pending; }
  document.title = (pending ? '(' + pending + ') ' : '') + 'Speaker';
}
function updateTimes() {
  if (document.hidden) return;
  const now = Date.now();
  document.querySelectorAll('[data-expires-at]').forEach((time) => {
    const end = Number(time.dataset.expiresAt), seconds = Math.max(0, Math.ceil((end - now) / 1000));
    time.textContent = seconds ? short(seconds) + ' left' : 'Expired';
    time.title = 'Expires ' + new Date(end).toLocaleString();
  });
  document.querySelectorAll('[data-end]').forEach((meter) => {
    const left = Math.max(0, (Number(meter.dataset.end) - now) / 1000), scale = ladder.find((step) => step >= left) || ladder[ladder.length - 1];
    meter.style.setProperty('--p', Math.min(1, left / scale));
    meter.classList.toggle('low', left < 300 || left / scale < 0.1);
  });
  document.querySelectorAll('[data-last-used-at]').forEach((time) => {
    const seconds = Math.max(0, Math.floor((now - Number(time.dataset.lastUsedAt)) / 1000));
    time.textContent = (seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h' : Math.floor(seconds / 86400) + 'd') + ' ago';
  });
}
async function refresh() {
  if (!document.hidden && !dialog.open) {
    try {
      const response = await fetch('/admin/live', {cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('Refresh failed');
      const panels = await response.json();
      for (const id of ['approvals', 'leases']) {
        const panel = document.getElementById(id);
        if (!panel) continue;
        // Leave an actively edited form alone; retain choices and open details on later refreshes.
        if (panel.contains(document.activeElement)) continue;
        panel.innerHTML = panels[id];
        panel.querySelectorAll('details[id]').forEach((details) => { details.open = opened.has(details.id); });
        panel.querySelectorAll('form').forEach((form) => {
          const saved = choices.get(form.action);
          if (saved) for (const field of form.elements) {
            if (field.type === 'checkbox') field.checked = saved.has(field.name);
            else if (saved.has(field.name)) field.value = saved.get(field.name);
          }
        });
      }
      count(panels.pending);
      filter();
      status.textContent = 'Live';
      status.title = 'Times shown in ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
      updateTimes();
    } catch {
      status.textContent = 'Live updates stopped. Reload.';
      return;
    }
  }
  setTimeout(refresh, 5000);
}
document.addEventListener('change', ({target}) => {
  const form = target.closest('#approvals form');
  if (form) choices.set(form.action, new FormData(form));
});
document.addEventListener('toggle', ({target}) => { if (target.id) target.open ? opened.add(target.id) : opened.delete(target.id); }, true);
document.addEventListener('click', ({target}) => {
  const chip = target.closest('[data-kind]');
  if (!chip) return;
  const on = !kinds.delete(chip.dataset.kind);
  if (on) kinds.add(chip.dataset.kind);
  chip.setAttribute('aria-pressed', on);
  filter();
});
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form.dataset.confirm || form.dataset.ok || typeof dialog.showModal !== 'function') return;
  event.preventDefault();
  target = form;
  $('#confirm-text').textContent = form.dataset.confirm;
  $('#confirm-ok').textContent = form.querySelector('button').textContent;
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'ok' && target) { target.dataset.ok = '1'; target.submit(); }
  target = null;
  dialog.returnValue = '';
});
search?.addEventListener('input', filter);
$('.nav [aria-current]')?.scrollIntoView({inline: 'center', block: 'nearest'});
updateTimes();
setInterval(updateTimes, 1000);
refresh();
`

const css = `
:root{color-scheme:light dark;
--bg:oklch(97.5% .006 265);--surface:oklch(100% 0 0);--sunk:oklch(95% .012 265);--ink:oklch(22% .04 265);--dim:oklch(44% .03 265);--line:oklch(90% .014 265);--field:oklch(58% .03 265);
--brand:oklch(36% .17 268);--accent:oklch(48% .21 268);--on-accent:oklch(100% 0 0);
--region:oklch(94.5% .03 268);--ticket:oklch(100% 0 0);--perf:oklch(80% .05 268);
--go:oklch(46% .14 155);--on-go:oklch(100% 0 0);--good:oklch(42% .13 155);--good-bg:oklch(92% .07 155);
--warn:oklch(42% .1 70);--warn-bg:oklch(92% .1 85);--warn-fill:oklch(76% .16 75);
--bad:oklch(48% .19 25);--bad-bg:oklch(95% .03 25);
--mark-bg:oklch(92% .05 var(--h,268));--mark-ink:oklch(40% .15 var(--h,268));
--shadow:0 1px 2px oklch(25% .05 268/.14),0 10px 24px -12px oklch(25% .08 268/.4);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);accent-color:var(--accent);scrollbar-color:var(--field) transparent}
@media(prefers-color-scheme:dark){:root{
--bg:oklch(17% .02 265);--surface:oklch(22% .025 265);--sunk:oklch(19% .025 265);--ink:oklch(95% .01 265);--dim:oklch(77% .03 265);--line:oklch(31% .03 265);
--brand:oklch(30% .15 268);--accent:oklch(77% .13 268);--on-accent:oklch(18% .05 268);
--region:oklch(22% .05 268);--ticket:oklch(31% .05 268);--perf:oklch(42% .06 268);
--go:oklch(80% .17 155);--on-go:oklch(20% .05 155);--good:oklch(84% .15 155);--good-bg:oklch(30% .06 155);
--warn:oklch(87% .14 85);--warn-bg:oklch(32% .06 80);--warn-fill:oklch(80% .15 80);
--bad:oklch(80% .13 25);--bad-bg:oklch(28% .05 25);
--mark-bg:oklch(33% .08 var(--h,268));--mark-ink:oklch(85% .12 var(--h,268));
--shadow:0 1px 2px #0006,0 12px 24px -12px #000b}}
/* Browsers without OKLCH (before 2022) get a plain hex palette. */
@supports not (color:oklch(50% 0 0)){:root{--bg:#f6f7fb;--surface:#fff;--sunk:#eceef5;--ink:#171a2b;--dim:#555b73;--line:#dfe2ec;--field:#8a90a6;--brand:#1c2b8f;--accent:#2f46d8;--region:#e4e9fb;--ticket:#fff;--perf:#aab4de;--go:#0b6b36;--good:#0a6a35;--good-bg:#d7f2e0;--warn:#7a5200;--warn-bg:#fbe9b5;--warn-fill:#e8a91f;--bad:#b3261e;--bad-bg:#fbe8e6;--mark-bg:#dfe4fb;--mark-ink:#2f3f9e;--shadow:0 1px 2px #1c2b8f24,0 10px 24px -12px #1c2b8f66}.count,.top{color:#fff}.count{background:#f6c344;color:#3b2a00}#live-status,.nav a{color:#dfe4ff}}
@media(prefers-color-scheme:dark){@supports not (color:oklch(50% 0 0)){:root{--bg:#0e1018;--surface:#171a26;--sunk:#12141e;--ink:#eef0f8;--dim:#b3b8cc;--line:#2c3040;--brand:#16206b;--accent:#9aa8ff;--on-accent:#10143a;--region:#171c3a;--ticket:#222850;--perf:#3d4580;--go:#5fe39a;--on-go:#06240f;--good:#7fe6ad;--good-bg:#12331f;--warn:#f4d37a;--warn-bg:#3a2e10;--bad:#ff9d94;--bad-bg:#3a1a18;--mark-bg:#262d5e;--mark-ink:#b9c3ff}}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;min-width:320px}::selection{background:var(--accent);color:var(--on-accent)}
.sprite{position:absolute;width:0;height:0;overflow:hidden}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.top{position:sticky;top:0;z-index:10;background:var(--brand);color:oklch(100% 0 0)}
.top-in{max-width:1120px;margin:auto;padding:10px 20px 0}
.bar{display:flex;align-items:center;gap:12px;min-height:44px}
.logo{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:oklch(100% 0 0);color:var(--brand)}
h1{font-size:1.45rem;line-height:1.2;font-weight:800;letter-spacing:-.03em;margin:0}
#live-status{margin:0 0 0 auto;font-size:.82rem;color:oklch(90% .04 268);min-width:0;text-align:right}
#live-status::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:oklch(80% .17 155);margin-right:7px}
.refresh{color:oklch(100% 0 0);font-size:.88rem;min-height:44px;display:inline-flex;align-items:center}
.nav{display:flex;gap:4px;margin-top:6px;overflow-x:auto;scrollbar-width:none}
.nav::after,.chips::after{content:"";flex:0 0 28px}.nav a{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border-radius:12px 12px 0 0;color:oklch(92% .035 268);text-decoration:none;font-weight:650;white-space:nowrap}
.nav .sep{flex:none;width:1px;margin:12px 6px;background:oklch(100% 0 0/.3)}h1 em{font-style:italic;font-weight:700}.intro{margin:12px 0 0}.nav a:hover{background:oklch(100% 0 0/.12)}.nav a[aria-current=page]{background:var(--bg);color:var(--ink)}
.count{min-width:22px;padding:1px 7px;border-radius:99px;background:oklch(86% .16 85);color:oklch(25% .06 85);font-size:.78rem;font-weight:800;text-align:center}
main{max-width:1120px;margin:auto;padding:20px 20px 72px}
h2{display:flex;align-items:center;gap:10px;font-size:1.3rem;line-height:1.25;font-weight:750;letter-spacing:-.02em;margin:0 0 14px}
h3{font-size:1rem;margin:0 0 10px}
.meta,.muted{color:var(--dim);font-size:.86rem}.muted{margin:18px 0 0}
a{color:var(--accent);text-underline-offset:3px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}
.tools{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:18px}
.tools label{flex:1 1 240px;max-width:420px}.tools input{margin:0}
.chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;max-width:100%}
.chips button{display:inline-flex;align-items:center;gap:7px;background:var(--surface);color:var(--ink);border:1px solid var(--field);font-weight:600;font-size:.88rem}
.chips button[aria-pressed=true]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.layout{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(300px,1fr);gap:22px;align-items:start}
.inbox{background:var(--region);border-radius:18px;padding:20px;min-width:0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;min-width:0}
.log{width:100%;border-collapse:collapse;font-size:.9rem}.log th{text-align:left;color:var(--dim);font-weight:600}.log th,.log td{padding:6px 10px 6px 0;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.rows{list-style:none;margin:0;padding:0}
.rows>li{padding:12px 0;border-top:1px solid var(--line)}.rows>li:first-child{border-top:0}
.rows[data-nomatch]::after{content:"Nothing matches this filter.";display:block;padding:14px 0;color:var(--dim)}
.inbox .rows{display:grid;gap:14px}.inbox .rows>li{border:0}.rows>li.ticket{padding:var(--tp) var(--tp) 0}
.empty{padding:6px 0;color:var(--dim)}.empty strong{display:block;color:var(--ink);font-size:1.05rem;margin-bottom:2px}
.inbox .empty{padding:24px 6px}
.mark{--h:268;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--mark-bg);color:var(--mark-ink);flex:none}
.mark.sm{width:24px;height:24px;border-radius:7px}.mark.sm .ic{width:14px;height:14px}
.k-credential{--h:70}.k-secret{--h:335}.k-site{--h:205}.k-folder{--h:135}.k-mcp{--h:295}.k-extension{--h:25}.k-enforcer{--h:250}.k-session{--h:180}
.strip{display:inline-flex;gap:3px}
.ticket{--tp:18px;background:var(--ticket);border-radius:16px;box-shadow:var(--shadow);padding:var(--tp) var(--tp) 0;min-width:0}
.t-head{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px}
.t-head strong{font-size:1.12rem;font-weight:750;letter-spacing:-.01em;overflow-wrap:anywhere}
.t-age{margin-left:auto;font-size:.82rem;color:var(--dim);white-space:nowrap}
.t-grant{margin-top:12px;display:grid;gap:8px}
.caps{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.cap{display:flex;gap:10px;align-items:center;min-width:0}.cap code{font-weight:650}.cap .meta{display:block;line-height:1.2}
details{min-width:0}summary{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-height:44px;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::after{content:"";width:8px;height:8px;margin:0 4px 0 auto;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(45deg);transition:transform .15s}
details[open]>summary::after{transform:rotate(225deg)}
.bundle summary{background:var(--sunk);border-radius:10px;padding:0 12px;font-weight:600}
.bundle .caps{padding:10px 12px 4px}.rows details .caps{padding:6px 0 14px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:99px;font-size:.78rem;font-weight:700;background:var(--sunk);color:var(--dim);white-space:nowrap}
.chip.good,.chip.warn,.chip.bad{padding-left:8px}.chip.good::before,.chip.warn::before,.chip.bad::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.chip.good{background:var(--good-bg);color:var(--good)}.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.bad{background:var(--bad-bg);color:var(--bad)}
.notice{margin:0 0 14px;padding:10px 14px;border-radius:10px;background:var(--bad-bg);color:var(--bad);font-weight:600}.chip.solid{background:var(--accent);color:var(--on-accent)}
.why{margin-top:10px;font-size:.92rem}.why summary{min-height:0;display:block;padding:0}.why summary::after{display:none}.why[open] summary{margin-bottom:4px}.why summary span{color:var(--dim)}
.t-meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px}
.stub{position:relative;margin:14px calc(-1*var(--tp)) 0;padding:14px var(--tp) var(--tp);border-top:2px dashed var(--perf)}
.stub::before,.stub::after{content:"";position:absolute;top:-9px;width:16px;height:16px;border-radius:50%;background:var(--region)}
.stub::before{left:-8px}.stub::after{right:-8px}
.decision{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
.pick{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:end;flex:1 1 100%}.pick label:not(.override){flex:1 1 150px}.pick:empty{display:none}
.go{display:flex;gap:8px;flex:1 1 100%}.go button{flex:1;min-height:52px;font-size:1.02rem}.go .approve{flex:1.7}
form{margin:0}label{display:block;font-size:.82rem;font-weight:600;color:var(--dim)}
input,select,textarea{display:block;width:100%;min-height:44px;margin-top:5px;padding:9px 12px;border:1px solid var(--field);border-radius:10px;background:var(--surface);color:var(--ink);font:inherit;font-size:.95rem}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem}
.override{display:flex;align-items:center;gap:8px;min-height:44px;color:var(--ink);font-size:.88rem;white-space:nowrap}.override input{width:20px;min-height:20px;margin:0}
button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border:1px solid transparent;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:.92rem;font-weight:650;cursor:pointer;white-space:nowrap;transition:filter .15s,transform .15s}
button:hover{filter:brightness(1.1)}button:active{transform:translateY(1px);filter:brightness(.94)}button:disabled{opacity:.5;cursor:not-allowed}
.approve{background:var(--go);color:var(--on-go);font-weight:750}
.deny{background:transparent;color:var(--bad);border-color:var(--bad)}.danger button{background:transparent;color:var(--bad);border-color:var(--line);font-weight:600}.deny:hover,.danger button:hover{background:var(--bad-bg);filter:none}
.quiet button{background:transparent;color:var(--ink);border-color:var(--line);font-weight:600}.quiet button:hover{background:var(--sunk);filter:none}
.dlg-actions .ok{background:var(--bad);color:var(--surface);border-color:var(--bad)}
.row{display:flex;gap:12px;align-items:center}.row-main{flex:1;min-width:0;overflow-wrap:anywhere}.row-title{font-weight:650}.row-sub{color:var(--dim);font-size:.85rem}
.row-act{display:flex;gap:6px;align-items:center;flex:none}.row-act a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;font-weight:600}
.expiry{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:5px 0 3px}
.left{font-variant-numeric:tabular-nums;font-weight:700;font-size:.88rem}
.meter{--p:1;flex:0 1 110px;min-width:56px;height:8px;border-radius:99px;background:var(--sunk);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.meter i{display:block;height:100%;width:calc(var(--p)*100%);background:var(--go);border-radius:99px;transition:width .6s}.meter.low i{background:var(--warn-fill)}
.wide .rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:0 28px}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:end;padding:6px 0 4px}.fields button{width:100%}
.editor{padding-bottom:18px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.panel>details>summary{color:var(--accent);font-weight:650;border-top:1px solid var(--line);margin-top:8px}
dialog{width:min(420px,calc(100vw - 32px));padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
dialog::backdrop{background:oklch(15% .04 268/.6)}dialog h2{margin-bottom:8px}dialog p{margin:0 0 18px}
.dlg-actions{display:flex;gap:10px;justify-content:flex-end}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.top a:focus-visible{outline-color:oklch(100% 0 0)}
@media(max-width:900px){.layout{grid-template-columns:1fr}.wide .rows{grid-template-columns:1fr}}
@media(max-width:560px){.nav,.chips{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 32px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 32px),transparent)}.nav a{scroll-margin:0 24px}#live-status{font-size:.76rem;line-height:1.25}.row.wrap{flex-wrap:wrap}.row.wrap .row-main{flex-basis:calc(100% - 50px)}.row.wrap .row-act{margin-left:46px}
.top-in{padding:6px 12px 0}h1{font-size:1.25rem}.logo{width:30px;height:30px}.refresh{display:none}.nav a{padding:0 13px}
main{padding:14px 12px 56px}.inbox{padding:12px;border-radius:14px}.panel{padding:14px}.ticket{--tp:14px}
input,select,textarea{font-size:1rem}.pick{flex-basis:100%}.go{flex-basis:100%}.go button{min-height:56px}
.t-age{margin-left:0;flex-basis:100%}h2{font-size:1.2rem}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`
const page = (nav: unknown, body: unknown, nonce: string) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Speaker for the creds</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cstyle%3Erect%7Bfill:%231c2b8f%7D.s%7Bfill:none;stroke:%23fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round%7D@media(prefers-color-scheme:dark)%7Brect%7Bfill:%239aa8ff%7D.s%7Bstroke:%2310143a%7D%7D%3C/style%3E%3Crect width='32' height='32' rx='8'/%3E%3Cg class='s' transform='translate(4 4) scale(1)'%3E%3Ccircle cx='7' cy='14' r='3.2'/%3E%3Cpath d='m9.4 11.8 8.100-8.100M14.500 6.700l2.500 2.500M17.200 4l2.500 2.500M3.200 8.500a6 6 0 0 1 3-3M2 4.800a9 9 0 0 1 4-2.700'/%3E%3C/g%3E%3C/svg%3E"><style>${raw(css)}</style></head><body>${raw(sprite)}<header class="top"><div class="top-in"><div class="bar"><span class="logo" aria-hidden="true"><svg class="ic"><use href="#i-brand"></use></svg></span><h1>Speaker for the <em>creds</em></h1><p id="live-status" role="status">Connecting…</p><a class="refresh" href="/admin">Refresh</a></div>${nav}</div></header><main>${body}</main><dialog id="confirm" aria-labelledby="confirm-title"><form method="dialog"><h2 id="confirm-title">Are you sure?</h2><p id="confirm-text"></p><div class="dlg-actions"><button value="cancel" autofocus>Keep</button><button value="ok" id="confirm-ok" class="ok">Confirm</button></div></form></dialog><script nonce="${nonce}">${raw(liveScript)}</script></body></html>`

const mark = (kind: string, small = false) =>
  html`<span class="mark k-${kind} ${small ? 'sm' : ''}"><svg class="ic" aria-hidden="true"><use href="#i-${kind}"></use></svg></span>`
const strip = (list: readonly string[]) =>
  html`<span class="strip">${[...new Set(list)].map((kind) => html`${mark(kind, true)}<span class="sr">${kind}</span>`)}</span>`
const cap = (m: Capability) =>
  html`<li class="cap">${mark(m.kind)}<div><code>${m.ref}</code><span class="meta">${m.kind}</span></div></li>`
const caps = (list: Capability[]) => html`<ul class="caps">${list.map(cap)}</ul>`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const activity = ({ uses, lastUsedAt }: { uses: number; lastUsedAt: number | null }, query = '') =>
  html`${query && uses ? html`<a href="/admin/log?${query}" title="Show who used this, when and what for">${plural(uses, 'use', 'uses')}</a>` : plural(uses, 'use', 'uses')} · ${lastUsedAt === null ? 'never used' : html`last used <time datetime="${new Date(lastUsedAt).toISOString()}" data-last-used-at="${lastUsedAt}"></time>`}`
const chips = { active: ['good', 'active'], granted: ['warn', 'granted'], waiting: ['warn', 'waiting for enforcer'] }
const notices = {
  disabled: '',
  sending: 'Sending phone notification…',
  sent: 'Phone notification sent',
  failed: 'Phone notification failed. Access stays locked.',
}
const searchable = (...parts: unknown[]) => parts.join(' ').toLowerCase()
const identity = (
  type: 'enforcer' | 'session',
  what: string,
  meta: unknown,
  kindList: string[],
  path: string,
  extension: unknown = '',
) =>
  html`<li data-search="${searchable(type, what, kindList.join(' '))}" data-kinds="${kindList.join(' ')}"><div class="row">${mark(type)}<div class="row-main"><div class="row-title">${what}</div><div class="row-sub">${meta}</div></div><div class="row-act">${extension}${form(`/admin/${path}/deny`, '', 'Revoke', 'inline danger', `Revoke ${type} ${what}`, `Revoke ${type} ${what}? It stops working immediately and must be approved again.`)}</div></div></li>`
const bundleErrors: Record<string, string> = {
  empty: 'Bundle not saved: list at least one member, one per line as "kind ref".',
  line: `Bundle not saved: each line must be "kind ref", with kind one of ${kindNames.join(', ')}.`,
  id: 'Bundle not saved: the id may use letters, numbers, - and _ (up to 64 characters).',
  description: 'Bundle not saved: keep the description to one line of at most 200 characters.',
}
const empty = (title: string, hint: string) => html`<li class="empty"><strong>${title}</strong>${hint}</li>`
const bundleBlock = (id: string, name: string, list: Capability[], note: unknown = '') =>
  list.length > 3
    ? html`<details class="bundle" id="${id}"><summary><span class="chip solid">Bundle</span><strong>${name}</strong><span class="meta">${plural(list.length, 'capability', 'capabilities')}</span>${strip(list.map((m) => m.kind))}</summary>${caps(list)}</details>${note}`
    : html`<div><span class="chip solid">Bundle</span> <strong>${name}</strong> <span class="meta">${plural(list.length, 'capability', 'capabilities')}</span></div>${caps(list)}${note}`

export function adminPage(
  providers: Record<string, Provider>,
  secrets: Map<string, string | undefined>,
  view: View,
  selectedId?: string,
  nonce?: string,
  section = 'approvals',
  bundles: Record<string, Bundle> = {},
  error?: string,
  mcpSummary: Record<string, { at: number; read: number; write: number; unannotated: number }> = {},
  log?: { entries: LogEntry[]; filter: string },
) {
  const selected = selectedId && Object.hasOwn(providers, selectedId) ? providers[selectedId] : undefined
  const activeSection = selected
    ? 'providers'
    : log
      ? 'log'
      : ['access', 'identities', 'providers', 'bundles'].includes(section)
        ? section
        : 'approvals'
  const providerList = Object.entries(providers).map(
    ([id, provider]) =>
      html`<li data-search="${searchable(id, provider.baseUrl)}" data-kinds="credential"><div class="row wrap">${mark('credential')}<div class="row-main"><div class="row-title">${id}</div><div class="row-sub"><code>${provider.baseUrl}</code></div><div class="row-sub"><span class="chip ${secrets.get(id) !== undefined ? 'good' : 'bad'}">Credential: ${secrets.get(id) !== undefined ? 'configured' : 'missing'}</span> read ${provider.policy.read} · write ${provider.policy.write} · guide ${provider.guide ? 'yes' : 'no'}${provider.mcp ? ' · MCP' : ''}${provider.auth.type === 'path' ? ' · path secret' : ''}</div></div><div class="row-act"><a href="/admin?section=providers&amp;provider=${encodeURIComponent(id)}" aria-label="Edit provider ${id}">Edit</a><a href="/admin/log?provider=${encodeURIComponent(id)}" aria-label="Access log for provider ${id}">Log</a>${form('/admin/providers/delete', input('id', '', 'hidden', id), 'Delete', 'inline danger', `Delete provider ${id}`, `Delete provider ${id}? Its credential is erased and its leases and pending requests are removed.`)}</div></div></li>`,
  )
  const panels = livePanels(view)
  const identities = [
    ...view.enforcers
      .filter((e) => e.status === 'approved')
      .map((e) =>
        identity(
          'enforcer',
          `Enforcer ${e.name}`,
          html`${e.kinds.join(', ')} · ${activity(e, `identity=${encodeURIComponent(e.id)}`)}`,
          [...e.kinds],
          `enforcers/${e.id}`,
        ),
      ),
    ...view.sessions
      .filter((s) => s.status === 'approved')
      .map((s) =>
        identity(
          'session',
          `Session ${s.label}`,
          html`${who(s)} · ${activity(s, `identity=${encodeURIComponent(s.id)}`)} · ${s.expiresAt ?? 'until revoked'}`,
          ['credential'],
          `sessions/${s.id}`,
          extend(`/admin/sessions/${s.id}/extend`, '', s.expiresAt, s.grantedMs, `session ${s.label}`),
        ),
      ),
  ]
  const providerFields = html`${input('id', 'Provider id', 'text', selected ? selectedId : '')}${input('baseUrl', 'Upstream base URL', 'url', selected?.baseUrl)}${select('authType', 'Authentication (path = secret is a URL segment, e.g. a webhook id)', ['bearer', 'header', 'basic', 'path'], selected?.auth.type ?? 'bearer')}${input('headerName', 'Credential header', 'text', selected?.auth.type === 'header' ? selected.auth.headerName : '')}${input('secret', 'Credential (blank keeps current)', 'password')}${select('read', 'Read policy (GET / HEAD / OPTIONS)', ['approval', 'always', 'deny'], selected?.policy.read ?? 'approval')}${select('write', 'Write policy (all other methods)', ['approval', 'always', 'deny'], selected?.policy.write ?? 'approval')}<label class="override"><input type="checkbox" name="mcp" ${raw(selected?.mcp ? 'checked' : '')}> MCP server (streamable HTTP): classify tool calls by their read-only hints</label><label>Guide (markdown, optional)<textarea name="guide" rows="5">${selected?.guide}</textarea></label>`
  const providerEditor = selected
    ? html`<section class="editor"><h3>Edit provider: ${selectedId}</h3>${form('/admin/providers/save', providerFields, 'Save provider', 'fields')}${selected.mcp ? mcpTools(selectedId ?? '') : ''}</section>`
    : ''
  function mcpTools(id: string) {
    const summary = mcpSummary[id]
    return html`<div class="t-meta">${error === 'tools' ? html`<p class="notice" role="alert">Could not list tools; check the URL and credential.</p>` : ''}<span class="meta">${summary ? `Tools: ${summary.read} read · ${summary.write} write${summary.unannotated ? ` (${summary.unannotated} without hints, treated as write)` : ''}` : 'Tools not listed yet'}</span>${form('/admin/providers/tools', input('id', '', 'hidden', id), 'Refresh tools', 'inline')}</div>`
  }
  const addProvider = selected
    ? ''
    : html`<details><summary>Add provider</summary>${form('/admin/providers/save', providerFields, 'Save provider', 'fields')}</details>`
  const bundleForm = (id: string, bundle: Bundle) =>
    form(
      '/admin/bundles/save',
      html`${input('id', 'Bundle id', 'text', id)}${input('description', 'Description (one line, optional)', 'text', bundle.description)}<label>Members, one per line as "kind ref"<textarea name="members" rows="5" required placeholder="credential notes.read">${bundle.members.map((m) => `${m.kind} ${m.ref}`).join('\n')}</textarea></label>`,
      'Save bundle',
      'fields',
    )
  const bundleEditor = (id: string, bundle: Bundle) =>
    html`<details><summary>${id ? 'Edit members' : 'Add bundle'}</summary>${bundleForm(id, bundle)}</details>`
  const bundleList = Object.entries(bundles).map(([id, bundle]) => {
    const list = bundle.members
    return html`<li data-search="${searchable(id, bundle.description ?? '', list.map((m) => `${m.kind} ${m.ref}`).join(' '))}" data-kinds="${[...new Set(list.map((m) => m.kind))].join(' ')}"><div class="row"><div class="row-main"><div class="row-title">${id}</div>${bundle.description ? html`<div class="row-sub">${bundle.description}</div>` : ''}<div class="row-sub">${plural(list.length, 'member', 'members')}, granted together by one approval</div></div><div class="row-act">${form('/admin/bundles/delete', input('id', '', 'hidden', id), 'Delete', 'inline danger', `Delete bundle ${id}`, `Delete bundle ${id}? Agents can no longer request it. Existing leases stay.`)}</div></div><details id="bundle-${id}"><summary>${strip(list.map((m) => m.kind))}<span class="meta">Members and editing</span></summary>${caps(list)}${bundleForm(id, bundle)}</details></li>`
  })
  const sections: [string, string, string][] = [
    ['approvals', 'Approvals', 'Sessions, sandboxes and access requests waiting for your yes or no.'],
    ['access', 'Leases', "Access you've granted that is active right now, until it expires or you revoke it."],
    ['identities', 'Identities', 'Agent sessions and sandboxes you have approved; revoke one to cut it off.'],
    ['providers', 'Providers', 'Upstream APIs Speaker proxies, with their stored credentials and read/write rules.'],
    ['bundles', 'Bundles', 'Named sets of capabilities an agent can request with a single approval.'],
    ['log', 'Log', 'Log: recent calls and decisions, newest first.'],
  ]
  const nav = html`<nav class="nav" aria-label="Admin sections">${sections.map(
    ([id, label, tip], i) =>
      html`${i === 1 || i === 3 || i === 5 ? html`<span class="sep" aria-hidden="true"></span>` : ''}<a href="${id === 'log' ? '/admin/log' : `/admin?section=${id}`}" title="${tip}" ${raw(activeSection === id ? 'aria-current="page"' : '')}>${label}${id === 'approvals' ? html`<span class="count" id="pending-count" ${raw(panels.pending ? '' : 'hidden')}>${panels.pending}</span>` : ''}</a>`,
  )}</nav>`
  const intro = html`<p class="muted intro">${sections.find(([id]) => id === activeSection)?.[2]}</p>`
  const tools = (withKinds: boolean) =>
    html`<div class="tools"><label><span class="sr">Filter this page</span><input id="q" type="search" placeholder="Filter by name, ref or kind" autocomplete="off"></label>${withKinds ? html`<div class="chips" role="group" aria-label="Filter by kind">${kindNames.map((kind) => html`<button type="button" data-kind="${kind}" aria-pressed="false">${mark(kind, true)}${kind}</button>`)}</div>` : ''}</div>`
  const content = log
    ? logPanel(log.entries, log.filter)
    : activeSection === 'access'
      ? html`${tools(true)}<section class="panel wide"><div id="leases">${raw(panels.leases)}</div></section>`
      : activeSection === 'identities'
        ? html`${tools(false)}<section class="panel"><h2>Approved identities</h2><ul class="rows">${identities.length ? identities : empty('No approved identities', 'Enforcers and sessions appear here after you approve them, and can be revoked.')}</ul></section>`
        : activeSection === 'providers'
          ? html`${tools(false)}<section class="panel"><h2>Providers</h2>${providerEditor}<ul class="rows">${providerList.length ? providerList : empty('No providers configured', 'Add a provider to let agents request access to an upstream API.')}</ul>${addProvider}</section><p class="muted">Credentials stay on this server.</p>`
          : activeSection === 'bundles'
            ? html`${tools(false)}<section class="panel"><h2>Bundles</h2>${bundleErrors[error ?? ''] ? html`<p class="notice" role="alert">${bundleErrors[error ?? '']}</p>` : ''}<ul class="rows">${bundleList.length ? bundleList : empty('No bundles', 'A bundle groups capabilities so an agent can request them with one approval.')}</ul>${bundleEditor('', { members: [] })}</section><p class="muted">A bundle is what an agent may use; a bottle-school template sets the VM size and attended mode and names the bundle to request at launch. Changes apply to new requests; requests already pending keep their members.</p>`
            : html`${tools(true)}<div class="layout"><section class="inbox" id="approvals">${raw(panels.approvals)}</section><section class="panel"><div id="leases">${raw(panels.leases)}</div></section></div><p class="muted">Expiry and revocation block new requests; a response already streaming may finish.</p>`
  return page(nav, html`${intro}${content}`, nonce ?? '')
}

const ago = (iso: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`
}
const logWhat = (e: LogEntry) => {
  if (e.event === 'proxy')
    return html`<code>${e.method} ${e.path}</code> <span class="meta">${e.provider}${e.mcp ? ` · ${e.mcp}` : ''}</span>`
  const list = Array.isArray(e.capability)
    ? (e.capability as Capability[]).map((m) => `${m.kind} ${m.ref}`).join(', ')
    : String(e.capability ?? '')
  return html`<code>${list}</code>${e.reason ? html` <span class="meta">${String(e.reason)}</span>` : ''}`
}
const logResult = (e: LogEntry) =>
  e.event === 'proxy'
    ? html`${String(e.status)} <span class="meta">${String(e.latencyMs)}ms · ${e.leaseId ? 'lease' : String(e.rule)}</span>`
    : e.expiresAt === undefined
      ? ''
      : html`expires ${e.expiresAt === null ? 'never' : String(e.expiresAt)}`
const logPanel = (entries: LogEntry[], filter: string) =>
  html`<section class="panel wide"><h2>Log ${filter ? html`<span class="meta">${filter} · <a href="/admin/log">show all</a></span>` : ''}</h2>${
    entries.length
      ? html`<table class="log"><thead><tr><th>Time</th><th>Who</th><th>What</th><th>Result</th></tr></thead><tbody>${entries.map(
          (e) =>
            html`<tr><td><time datetime="${e.time}" title="${e.time}">${ago(e.time)}</time></td><td>${[e.label, e.llmName, e.harness].filter(Boolean).join(' · ')}</td><td>${e.event === 'proxy' ? '' : `${String(e.event).replace('_', ' ')}: `}${logWhat(e)}</td><td>${logResult(e)}</td></tr>`,
        )}</tbody></table>`
      : html`<ul class="rows">${empty('No log entries', 'Calls and decisions appear here as they happen.')}</ul>`
  }</section>`

// One compact line naming who is asking: model, then harness, both as the agent reported them.
const who = (s: { llmName?: string; harness?: string }) =>
  [s.llmName ?? 'LLM not supplied', s.harness].filter(Boolean).join(' · ')

export function livePanels({ enforcers, sessions, requests, leases, always }: View) {
  // Flags a session whose agent (same label, model and harness) already enrolled in the 30 minutes before it.
  const twin = (s: View['sessions'][number]) => {
    const at = Date.parse(s.enrolledAt ?? '')
    const earlier = sessions.filter(
      (o) =>
        o.id !== s.id &&
        o.label === s.label &&
        o.llmName === s.llmName &&
        o.harness === s.harness &&
        at - Date.parse(o.enrolledAt ?? '') > 0 &&
        at - Date.parse(o.enrolledAt ?? '') < 1_800_000,
    )
    if (!earlier.length) return ''
    const minutes = Math.round((at - Math.max(...earlier.map((o) => Date.parse(o.enrolledAt ?? '')))) / 60_000)
    return html` <span class="chip warn">same agent enrolled ${minutes} min earlier</span>`
  }
  // A request filed with a still-pending session is shown on that session's card and approved with it.
  const pendingSessions = new Set(sessions.filter((s) => s.status === 'pending').map((s) => s.id))
  const firstAsk = (sessionId: string) => {
    const r = requests.find((q) => q.subjectId === sessionId && q.atEnrollment && q.status === 'pending')
    return r
      ? html`<div class="meta">Also asks for ${r.bundle ? `bundle ${r.bundle}` : r.members.map((m) => `${m.kind} ${m.ref}`).join(', ')} for ${r.duration}: ${r.reason}</div>`
      : ''
  }
  const decide = (path: string, picker: unknown, subject: string, approve = 'Approve') =>
    html`<form class="decision" method="post" action="/admin/${path}/approve"><div class="pick">${picker}</div><div class="go"><button class="approve" aria-label="${approve}: ${subject}">${approve}</button><button class="deny" formaction="/admin/${path}/deny" aria-label="Deny: ${subject}">Deny</button></div></form>`
  const ticket = (
    id: string,
    search: string,
    kindList: readonly string[],
    head: unknown,
    body: unknown,
    stub: unknown,
  ) =>
    html`<li class="ticket" id="${id}" data-search="${search.toLowerCase()}" data-kinds="${kindList.join(' ')}"><div class="t-head">${head}</div>${body}<div class="stub">${stub}</div></li>`
  const items = [
    ...enforcers
      .filter((e) => e.status === 'pending')
      .map((e) =>
        ticket(
          `enforcer-${e.id}`,
          `enforcer ${e.name} ${e.kinds.join(' ')}`,
          e.kinds,
          html`${mark('enforcer')}<strong>Enforcer ${e.name}</strong><span class="chip">wants to enforce</span>`,
          html`<div class="t-grant"><div class="meta">Approving lets this enforcer apply leases for ${e.kinds.join(', ') || 'no kinds'} ${strip(e.kinds)}</div></div>`,
          decide(`enforcers/${e.id}`, '', `enforcer ${e.name}`),
        ),
      ),
    ...sessions
      .filter((s) => s.status === 'pending')
      .map((s) =>
        ticket(
          `session-${s.id}`,
          `session ${s.label} ${s.llmName ?? ''}`,
          ['credential'],
          html`${mark('session')}<strong>Session ${s.label}</strong><span class="chip">wants to connect</span>`,
          html`<div class="t-grant"><div class="meta">${who(s)}</div><div class="meta">from ${s.source ?? 'unknown address'} · key ${s.tokenHash.slice(0, 8)}${twin(s)}</div>${firstAsk(s.id)}${always.length ? html`<div class="meta">Reads without asking for up to 90 days: ${always.join(', ')}</div>` : ''}</div>`,
          decide(
            `sessions/${s.id}`,
            html`${select('duration', 'Session lasts', durations, s.duration)}${permanentOverride}`,
            `session ${s.label}`,
          ),
        ),
      ),
    ...requests
      .filter((r) => r.status === 'pending' && !(r.atEnrollment && pendingSessions.has(r.subjectId)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => {
        const ssh = r.ssh
          ? html`<div class="meta">SSH certificate for <code>${r.ssh.user}@${r.ssh.hostname}:${r.ssh.port}</code> · key <code>${r.ssh.fingerprint}</code> · ${[r.ssh.agentForwarding && 'agent forwarding', r.ssh.portForwarding && 'port forwarding'].filter(Boolean).join(', ') || 'no forwarding'}${r.ssh.sourceAddress ? html` · only from <code>${r.ssh.sourceAddress}</code>` : ''} · cannot be revoked before it expires</div>`
          : ''
        const sshMax = r.ssh?.maxDuration
        const note = r.bundle
          ? html`<div class="meta">One approval grants all ${r.members.length} for the chosen time.</div>`
          : ''
        return ticket(
          `request-${r.id}`,
          `${r.label} ${r.llmName ?? ''} ${r.enforcer ?? ''} ${r.bundle ?? ''} ${r.reason} ${r.members.map((m) => `${m.kind} ${m.ref}`).join(' ')}`,
          r.members.map((m) => m.kind),
          html`<strong>${r.label}</strong>${r.llmName ? html`<span class="meta">${who(r)}</span>` : ''}${r.enforcer ? html`<span class="meta">via ${r.enforcer}</span>` : ''}<span class="t-age">asked <time datetime="${new Date(r.createdAt).toISOString()}" data-last-used-at="${r.createdAt}"></time></span>`,
          html`<div class="t-grant">${r.bundle ? bundleBlock(`req-${r.id}`, r.bundle, r.members, note) : html`<div class="meta">Requests access to</div>${caps(r.members)}${ssh}`}</div>${
            r.reason.length > 120
              ? html`<details class="why" id="why-${r.id}"><summary><span>Reason:</span> ${r.reason.slice(0, 110)}…</summary>${r.reason}</details>`
              : html`<p class="why"><span class="meta">Reason:</span> ${r.reason || html`<span class="meta">none supplied yet</span>`}</p>`
          }${r.method || notices[r.notification] ? html`<div class="t-meta">${r.method ? html`<span class="meta">Triggered by <code>${r.method} ${r.path}</code></span>` : ''}${notices[r.notification] ? html`<span class="${r.notification === 'failed' ? 'chip warn' : 'meta'}">${notices[r.notification]}</span>` : ''}</div>` : ''}`,
          decide(
            `requests/${r.id}`,
            sshMax
              ? select(
                  'duration',
                  'Certificate valid for',
                  durations.slice(0, durations.indexOf(sshMax) + 1),
                  r.duration,
                )
              : html`${select('duration', 'Allow access for', durations, r.duration)}${permanentOverride}`,
            r.bundle ? `bundle ${r.bundle}` : r.label,
            r.members.length > 1 ? `Approve all ${r.members.length}` : 'Approve',
          ),
        )
      }),
  ]
  // Soonest expiry first so what is about to lapse is on top; "until revoked" leases last.
  const ordered = [...leases].sort(
    (a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity),
  )
  const leaseList = ordered.map((l) => {
    const [tone, state] = chips[l.state]
    return html`<li id="lease-${l.id}" data-search="${searchable(l.label, l.llmName, l.kind, l.ref)}" data-kinds="${l.kind}"><div class="row">${mark(l.kind)}<div class="row-main"><div class="row-title"><code>${l.ref}</code></div><div class="row-sub">${l.kind} · ${l.label}${l.llmName ? ` · LLM: ${l.llmName}` : ''}${l.kind === 'credential' ? html` · ${l.uses ? activity(l, `lease=${encodeURIComponent(l.id)}`) : 'unused'}` : ''}</div><div class="expiry">${l.expiresAt === null ? html`<span class="chip warn">Until revoked</span>` : html`<span class="meter" data-end="${Date.parse(l.expiresAt)}"><i></i></span><time class="left" datetime="${l.expiresAt}" data-expires-at="${Date.parse(l.expiresAt)}">expires ${l.expiresAt}</time>`}${l.state === 'active' ? html`<span class="sr">active</span>` : html`<span class="chip ${tone}">${state}</span>`}</div></div><div class="row-act">${extend('/admin/leases/extend', input('id', '', 'hidden', l.id), l.expiresAt, l.grantedMs, `lease ${l.label} ${l.ref}`)}${form('/admin/leases/revoke', input('id', '', 'hidden', l.id), 'Revoke', 'inline danger', `Revoke lease: ${l.label} ${l.ref}`, `Revoke ${l.ref} for ${l.label}? Requests using it are blocked immediately.`)}</div></div></li>`
  })
  return {
    pending: items.length,
    approvals: String(
      html`<h2>Approvals ${items.length ? html`<span class="chip warn">${items.length} pending</span>` : ''}</h2><ul class="rows">${items.length ? items : empty('Nothing to approve', 'New requests appear here as soon as an agent asks for access. This page updates by itself.')}</ul>`,
    ),
    leases: String(
      html`<h2>Leases ${leaseList.length ? html`<span class="meta">${leaseList.length} active</span>` : ''}</h2><ul class="rows">${leaseList.length ? leaseList : empty('No active leases', 'Approved access is listed here until it expires or you revoke it.')}</ul>`,
    ),
  }
}
