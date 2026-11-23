// The owner's pages: Hono's html templates styled by Pico CSS (indigo) and a small stylesheet, with htmx for the live
// Agents panel, confirmations and form posts. The panel updates via SSE (with a 30s fallback) and is morphed
// (idiomorph), so open disclosures and focus stay.
import { html, raw } from 'hono/html'
import { type Group, identityFields, type LogEntry, type Service, type View } from './core.ts'
import { type BrowserSite, brokerMissing, lifetimes } from './browser.ts'
import type { SshSetup } from './jump.ts'
type Html = ReturnType<typeof html>
type Owned = Record<string, { hosts?: string[]; env?: string; release?: true }>
export type McpSummary = Record<string, { read: number; write: number; unannotated: number }>
export type Setup = {
  services: Record<string, Service>
  keyed: Set<string>
  owned: Owned
  groups: Record<string, Group>
  ssh: SshSetup
  mcp: McpSummary
  selected?: string
  scope?: string
  sshTarget?: string
  sshShare?: string
  browsers: Record<string, BrowserSite>
  // Open sessions: site → when its lifetime ends (ms).
  live: Record<string, number>
  brokerReady: boolean
  error?: string
}
const css = `
:root{color-scheme:light dark;accent-color:var(--pico-primary);caret-color:var(--pico-primary);--pico-spacing:.85rem;--pico-border-radius:.45rem;--pico-form-element-spacing-vertical:.55rem;--pico-form-element-spacing-horizontal:.75rem;--pico-icon-checkbox:none;--pico-icon-minus:none;--pico-icon-chevron:none;--pico-icon-search:none;--bg:light-dark(#f6f7fb,#111520);--surface:light-dark(#fff,#181d29);--surface-2:light-dark(#eef1f7,#212736);--line:light-dark(#dce1ec,#2b3345);--region:light-dark(oklch(96% .02 264),oklch(19.5% .025 264));--perf:light-dark(oklch(82% .06 264),oklch(38% .04 264));--ok:light-dark(#1b7a46,#52d18a);--ok-btn:light-dark(#1b7a46,#1f7a49);--t1:light-dark(oklch(47% .085 225),oklch(75% .075 225));--t2:light-dark(oklch(48% .135 264),oklch(76% .11 264));--t3:light-dark(oklch(49% .115 65),oklch(79% .1 74));--warn:light-dark(oklch(42% .12 70),oklch(85% .11 78));--warn-bg:light-dark(oklch(96.5% .035 82),oklch(26% .04 72));--warn-line:light-dark(oklch(84% .08 78),oklch(42% .06 72));--bad:light-dark(#c62828,#ff7b7b);--bad-bg:light-dark(#fef2f2,oklch(25% .055 25));--bad-line:light-dark(#f5b8b8,oklch(42% .08 25))}
html{scrollbar-gutter:stable;scrollbar-width:thin}body{min-width:320px;overflow-x:clip;background:var(--bg)}[hidden]{display:none!important}
.masked{-webkit-text-security:disc}.dim{color:var(--pico-muted-color)}.ok{color:var(--ok)}.clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
time,code,.count,.n{font-variant-numeric:tabular-nums}code{overflow-wrap:anywhere}p{text-wrap:pretty}h2,h3{text-wrap:balance}
.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.top{position:sticky;top:0;z-index:10;padding:env(safe-area-inset-top) 0 0;background:var(--surface);border-bottom:1px solid var(--line)}.top .in,main{max-width:1120px;margin:auto;padding-inline:20px}main{padding-top:18px;padding-bottom:calc(64px + env(safe-area-inset-bottom))}[id]{scroll-margin-top:calc(68px + env(safe-area-inset-top))}
.bar{display:flex;align-items:center;gap:12px;min-height:52px}.bar>a{font-size:.88rem;min-height:44px;display:inline-flex;align-items:center;padding:0 4px}.bar small{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-weight:600}.bar small::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok)}.bar small.offline{color:var(--bad)}.bar small.offline::before{background:var(--bad)}
.logo{display:grid;place-items:center;width:32px;height:32px;border-radius:.5rem;background:var(--pico-primary-background);color:var(--pico-primary-inverse);flex:none}
h1{font-size:1.05rem;line-height:1.2;font-weight:800;letter-spacing:-.02em;margin:0;white-space:nowrap}h1 em,.auth-brand em{font-weight:700;font-style:normal;color:var(--pico-primary)}
nav.tabs{display:flex;gap:2px;margin-left:10px}nav.tabs a{display:flex;align-items:center;gap:6px;min-height:52px;padding:0 14px;border-bottom:3px solid transparent;border-radius:0;color:var(--pico-muted-color);text-decoration:none;font-weight:650;white-space:nowrap}nav.tabs a:hover{color:var(--pico-color)}nav.tabs a[aria-current]{color:var(--pico-color);border-color:var(--pico-primary)}nav.tabs .count{padding:1px 7px;border-radius:999px;background:var(--pico-primary-background);color:var(--pico-primary-inverse);font-size:.76rem;font-weight:700;line-height:1.35}
h2{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-size:1.2rem;font-weight:750;letter-spacing:-.02em;margin:0 0 14px}h2 small{font-size:.82rem;font-weight:650;color:var(--pico-muted-color)}h3{font-size:1.02rem;font-weight:700;margin:16px 0 10px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:.65rem;padding:18px 20px;margin-bottom:18px}.panel.region{background:var(--region);border-color:color-mix(in oklch,var(--pico-primary) 18%,var(--line))}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr));gap:16px;align-items:start}
.region article{margin:0;padding:18px 18px 0;background:var(--surface);border:1px solid var(--line);border-radius:.65rem;box-shadow:light-dark(0 4px 14px rgba(18,24,40,.06),none)}.region article>header,.region article>footer{margin:0 0 10px;padding:0;background:none;border:0}.region article>footer{padding-bottom:12px;margin:0}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}.card-head strong{font-size:1.08rem;font-weight:750}.card-meta{display:block;margin-top:3px;line-height:1.45;color:var(--pico-muted-color)}
.reason{margin:10px 0 12px;padding:8px 12px;border-radius:.45rem;background:var(--surface-2);font-size:.94rem}.reason-label{font-size:.75rem;font-weight:750;color:var(--pico-muted-color);margin-right:6px;text-transform:uppercase;letter-spacing:.04em}
.context-note{display:flex;align-items:center;gap:7px;margin:0 0 10px;padding:7px 10px;border-radius:.45rem;background:var(--surface-2);color:var(--pico-muted-color);font-size:.84rem;line-height:1.35}.context-note .ic{width:15px;height:15px}
.stub{position:relative;margin:14px -18px 0;padding:14px 18px 18px;border-top:2px dashed var(--perf)}.stub::before,.stub::after{content:"";position:absolute;top:-9px;width:16px;height:16px;border-radius:50%;background:var(--region)}.stub::before{left:-9px}.stub::after{right:-9px}
.list article,.panel>article{margin:0;padding:8px 0;background:none;border:0;box-shadow:none;border-radius:0}.list article+article{border-top:1px solid var(--line)}.panel>article>header,.list article>header{margin:0;padding:0;background:none;border:0}.scope{margin:0 0 8px}.alert{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:.9rem}.alert .mark{width:22px;height:22px}.alert .mark .ic{width:14px;height:14px}.alert code{background:none;padding:0;font-weight:650}
.mark,.k{--h:225;--m:light-dark(oklch(47% .085 var(--h)),oklch(75% .075 var(--h)))}.k{display:inline-grid;place-items:center;vertical-align:middle;margin-right:6px;color:var(--pico-muted-color)}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:.45rem;background:color-mix(in oklch,var(--m) 13%,transparent);color:var(--m);flex:none}.mark.tier-routine{--m:var(--t1)}.mark.tier-notable{--m:var(--t2)}.mark.tier-sensitive{--m:var(--t3)}.chips .mark{width:20px;height:20px}.chips .mark .ic{width:13px;height:13px}
mark,.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.76rem;font-weight:700;vertical-align:middle;line-height:1.45}mark{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-line)}.badge{background:var(--surface-2);color:var(--pico-muted-color);border:1px solid var(--line)}
.warn{color:var(--bad)}p.warn{padding:10px 14px;border-radius:.5rem;background:var(--bad-bg);border:1px solid var(--bad-line);font-weight:600}
input[type=checkbox]{appearance:auto;width:22px;height:22px;margin:0;flex:none;vertical-align:middle}select{appearance:auto;background-image:none}input[type=search]{background-image:none;padding-inline-start:var(--pico-form-element-spacing-horizontal)}
label{font-size:.88rem;font-weight:600}label:has(input[type=checkbox]){display:flex;align-items:center;gap:10px;min-height:44px;font-weight:400;cursor:pointer}fieldset{margin:0 0 8px;padding:0;display:grid;gap:5px}legend{padding:0;margin-bottom:4px;width:100%}
fieldset label{padding:7px 10px;border:1px solid transparent;border-radius:.45rem;font-size:.96rem;margin:0}fieldset label:hover{background:var(--surface-2)}fieldset label span{min-width:0;overflow-wrap:anywhere}fieldset label code{background:none;padding:0;font-weight:650;font-size:.92em;color:var(--pico-color)}fieldset label small{display:block;font-size:.84rem;line-height:1.38;color:var(--pico-muted-color)}fieldset label.tier-notable{background:color-mix(in oklch,var(--t2) 5%,transparent);border-color:color-mix(in oklch,var(--t2) 20%,transparent)}fieldset label.tier-notable:hover{background:color-mix(in oklch,var(--t2) 9%,transparent)}fieldset label.tier-sensitive{background:color-mix(in oklch,var(--t3) 7%,transparent);border-color:color-mix(in oklch,var(--t3) 26%,transparent)}fieldset label.tier-sensitive:hover{background:color-mix(in oklch,var(--t3) 11%,transparent)}
button,.action-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:auto;min-height:44px;padding:0 16px;margin:0;font-size:.92rem;font-weight:650;white-space:nowrap;text-decoration:none}button.approve{background:var(--ok-btn);border-color:var(--ok-btn);color:#fff;font-weight:750}button.approve:hover{filter:brightness(.94)}button.secondary,.action-btn{background:var(--surface);color:var(--pico-color);border:1px solid var(--line)}button.secondary:hover,.action-btn:hover{background:var(--surface-2)}button.deny{background:transparent;color:var(--bad);border:1px solid var(--bad-line)}button.deny:hover{background:var(--bad-bg)}.stub button.deny{color:var(--pico-color);border-color:var(--line);font-weight:600}.stub button.deny:hover{background:var(--surface-2);border-color:color-mix(in oklch,var(--pico-color) 24%,var(--line))}form[data-busy]{opacity:.55}
.ib{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 6px;border:0;background:transparent;color:var(--pico-muted-color);font:650 .8rem var(--pico-font-family-monospace);border-radius:.4rem;text-decoration:none}.ib:hover{background:var(--surface-2);color:var(--pico-color)}.ib.revoke:hover,.ib.del:hover{color:var(--bad)}form:has(>.ib){display:contents}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.stub button{flex:1;min-height:48px;font-size:.98rem}.stub button:first-child{flex:1.6}
.chips,.jump-links,.on{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}.chips input[type=text]{flex:1 1 220px;max-width:260px;margin:0;min-height:44px}.chips label,.jump-links a,.on a:not(.action-btn){position:relative;display:inline-flex;gap:7px;align-items:center;min-height:44px;padding:0 12px;margin:0;border:1px solid var(--line);border-radius:.45rem;background:var(--surface);color:var(--pico-color);text-decoration:none;font-size:.86rem;font-weight:600;cursor:pointer}.chips label:has(:checked){background:var(--pico-primary-background);color:var(--pico-primary-inverse);border-color:var(--pico-primary-background)}.chips label input{position:absolute;opacity:0}.jump-links a:hover,.on a:not(.action-btn):hover{background:var(--surface-2)}.on a:not(.action-btn){border-radius:999px}
details{margin-bottom:0}details>summary{display:flex;align-items:center;min-height:44px;padding:4px 0;color:var(--pico-primary);font-weight:650;line-height:1.35}details>summary::after{width:7px;height:7px;margin:0 4px 0 auto;border:solid currentColor;border-width:0 2px 2px 0;background:none;float:none;transform:rotate(45deg)}details[open]>summary{margin-bottom:8px}details[open]>summary::after{transform:rotate(225deg)}.panel>details{border-top:1px solid var(--line);margin-top:10px}.sub-details{border-top:1px solid var(--line);margin:8px 0 12px}
.log-filter{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-bottom:8px}.log-filter>label{flex:1 1 220px;margin:0}.log-filter input{margin:0}.log-filter>details{flex-basis:100%}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:0 12px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0 0 8px;font-size:.86rem}.kv dt{color:var(--pico-muted-color)}.kv dd{margin:0;font:.9em var(--pico-font-family-monospace);overflow-wrap:anywhere}
table.data-table{margin:0 0 8px;font-size:.9rem}table.data-table th{color:var(--pico-muted-color);font-size:.8rem;white-space:nowrap}table.data-table th,table.data-table td{padding:6px 12px 6px 0;vertical-align:top;overflow-wrap:anywhere}table.data-table td:first-child{overflow-wrap:normal}td.act .actions{flex-wrap:nowrap}table.data-table tr.more td{border-top:0;padding-top:0}.more summary{justify-content:flex-start;gap:6px}.more summary::after{content:none}
.ah{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-height:34px}.ah .nt{display:flex;gap:8px;align-items:baseline;min-width:0}.ah .nt>*,.ah .md{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.ah .grow{flex:1}.ah q{color:var(--pico-muted-color);quotes:"\\201C" "\\201D"}.ah .ib{margin:0 -4px}.t{display:inline-flex;align-items:center;gap:3px;color:var(--pico-muted-color);font-size:.82rem}.t .ic{width:14px;height:14px}
.pop{position:relative}.pop>summary{min-height:28px;min-width:28px;padding:0;justify-content:center}.pop>summary::after{content:none}.pop>div{position:absolute;right:0;z-index:5;width:min(92vw,420px);padding:12px 14px;border:1px solid var(--line);border-radius:.5rem;background:var(--surface);box-shadow:var(--pico-box-shadow)}
.gr{--ac:3.6rem;border-top:1px solid var(--line);font-size:.88rem}.gr.ph{opacity:.6}.sc{--in:1.4rem}.xb{display:none}
.rw{--nw:12rem;display:grid;grid-template-columns:calc(20px + var(--in,0rem)) minmax(0,calc(var(--nw) - var(--in,0rem))) minmax(0,20rem) 1.8rem 1.8rem 2.6rem minmax(var(--ac),1fr);align-items:center;gap:0 8px;min-height:32px;padding:0;color:var(--pico-color);font-weight:400;cursor:default}.rw>*{min-width:0}.rw::after{content:none}.rw>.k{justify-self:end}.rw code{font-size:.84rem;padding:0;background:none}.rw.sv{--nw:14rem;--ac:9rem;grid-template-columns:calc(20px + var(--in,0rem)) minmax(0,calc(var(--nw) - var(--in,0rem))) minmax(0,20rem) 1fr var(--ac);min-height:36px}.rw.cs{grid-template-columns:20px minmax(0,1fr)}.n{text-align:right}.acts{display:flex;justify-content:flex-end}.nm{display:flex;gap:6px;align-items:center}.nm strong{overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}.nm>*{flex:none}
.lv{font:700 .72rem var(--pico-font-family-monospace);color:var(--pico-muted-color)}.lv.w{color:var(--warn)}
.cs div{display:flex;flex-wrap:wrap;gap:4px 6px;padding:3px 0}.cs span.c{display:inline-flex;align-items:center;gap:4px;padding:0 0 0 9px;border:1px solid var(--line);border-radius:999px;font:.8rem var(--pico-font-family-monospace);min-height:24px}.cs span.c.held{padding-right:9px}.cs .c .ib{opacity:.6}.cs .c:hover .ib{opacity:1}
.ev>summary{display:grid;grid-template-columns:6.5rem 8rem minmax(0,1fr) 7rem 1rem;gap:0 10px;min-height:30px;padding:0;color:var(--pico-color);font-weight:400;font-size:.84rem;border-top:1px solid var(--line)}.ev>summary>*{min-width:0}.ev>summary::after{margin:0}.ev code{padding:0;background:none}.ev time .dim{opacity:.6}.ev .kv{padding:6px 0 6px 6.5rem}.ev.g>summary{grid-template-columns:4.4rem minmax(0,1fr) 7rem 1rem}.ev.g .kv{padding-left:4.4rem}
.gh{display:flex;gap:10px;align-items:baseline;margin:14px 0 2px;font-size:.9rem}.gh .r{margin-left:auto}
.keyline{display:flex;gap:8px;align-items:center;margin:0 0 12px}.keyline input{margin:0;min-height:38px;min-width:0;font:.84rem var(--pico-font-family-monospace)}.keyline button{flex:none}
.seg{display:inline-flex;margin:0 0 0 auto}.seg a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid var(--line);color:var(--pico-color);text-decoration:none;font-size:.86rem;font-weight:600}.seg a:first-child{border-radius:.45rem 0 0 .45rem}.seg a:last-child{border-radius:0 .45rem .45rem 0;border-left:0}.seg a[aria-current]{background:var(--pico-primary-background);color:var(--pico-primary-inverse);border-color:var(--pico-primary-background)}
.auth-wrap{min-height:100dvh;display:grid;place-items:center;padding:20px}.auth{width:100%;max-width:420px}.auth-brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:16px;font-size:1.3rem;font-weight:800;letter-spacing:-.03em}.auth button{width:100%}
dialog>article{max-width:440px}dialog>article>header,dialog>article>footer{border:0;background:none}dialog>article>header{padding-bottom:0}dialog>article>footer{padding-top:0}
@media(pointer:fine){.keyline button{min-height:36px}.ib{min-width:28px;min-height:28px}.ib .ic{width:16px;height:16px}.cs .ib{min-width:22px;min-height:22px}.cs .ic{width:13px;height:13px}.rw:not(.sv) .acts{opacity:0}.sv .acts{opacity:.65}.gr:hover .acts,.gr:focus-within .acts{opacity:1}.chips label,.jump-links a,.on a:not(.action-btn),.seg a{min-height:34px}}
@media(pointer:coarse){.gr{--ac:6rem}.rw.sv{--ac:14rem}.cs .c .ib{min-width:44px;min-height:44px;margin:-10px -12px -10px -6px}}
@media(max-width:640px){.rw,.ev>summary{display:flex;gap:8px;min-height:44px;font-size:.94rem}.sc{padding-left:1.2rem}.rw>.mc,.rw>.n,.rw>.acts,.ev>summary>.ag{display:none}.rw>.nm1,.ev>summary>.w{flex:1 1 0}.rw.cs{min-height:0}.cs div{flex:1}.cs span.c{font-size:.88rem}details[open]>.xb{display:grid;gap:8px;padding:4px 0 10px 26px;font-size:.94rem}.xb .bt{display:flex;flex-wrap:wrap;gap:8px}.xb .bt>*{flex:1 1 40%}.xb .bt button,.xb .bt .action-btn{width:100%}.ev .kv{padding-left:0}.ah .nt{flex:1 1 100%}.ah .md{flex:1 1 0}.stub button{min-height:46px}.keyline{flex-wrap:wrap}.keyline input{flex:1 1 100%}.pop>div{right:auto;left:0}.top .in{padding-inline:10px}h1{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}nav.tabs{margin-left:0}nav.tabs a{padding:0 10px}.bar>a,.bar small:not(.offline){display:none}main{padding:14px 12px calc(56px + env(safe-area-inset-bottom))}.panel{padding:14px}.panel.region{padding:10px}.region article{padding:14px 14px 0}.stub{margin:12px -14px 0;padding:12px 14px 14px}.chips input[type=text]{flex:1 1 100%;max-width:none}table.data-table thead{display:none}table.data-table,table.data-table tbody,table.data-table tr,table.data-table td{display:block;width:100%!important}table.data-table tr{padding:10px 0;border-top:1px solid var(--line)}table.data-table td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border:0;padding:3px 0;text-align:right}table.data-table td::before{content:attr(data-label);color:var(--pico-muted-color);font-size:.8rem;font-weight:600;text-align:left;flex:none}table.data-table td:empty{display:none}table.data-table td:first-child{display:block;text-align:left}table.data-table td:first-child::before{display:block}table.data-table td.act{justify-content:flex-end}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}}
`
export const icons: Record<string, [icon: string, hue: number]> = {
  brand: ['key-round', 264],
  service: ['server', 225],
  'service-rw': ['server-cog', 264],
  secret: ['key-round', 68],
  site: ['globe', 225],
  folder: ['folder', 225],
  'folder-rw': ['folder-pen', 264],
  mcp: ['wrench', 225],
  ext: ['puzzle', 225],
  host: ['shield-check', 68],
  agent: ['bot', 225],
  ssh: ['terminal', 68],
  browser: ['app-window', 264],
  info: ['info', 225],
  edit: ['pencil', 0],
  log: ['scroll-text', 0],
  del: ['trash', 0],
  revoke: ['circle-x', 0],
  extend: ['clock-plus', 0],
  more: ['ellipsis', 0],
  add: ['plus', 0],
  check: ['refresh-cw', 0],
  left: ['hourglass', 0],
  used: ['activity', 0],
}
const glyph = (kind: string) => html`<svg class="ic"><use href="/admin/assets/icons.svg#i-${kind}"></use></svg>`
// A kind's icon, named for assistive tech and as a tooltip.
const ico = (kind: string) =>
  html`<span class="k" role="img" aria-label="${kinds[kind as keyof typeof kinds]}" title="${kinds[kind as keyof typeof kinds]}">${glyph(kind)}</span>`
const mark = (kind: string, tier?: string, label?: string) =>
  html`<span class="mark ${tier ? `tier-${tier}` : ''}" style="--h:${icons[kind][1]}" ${raw(label ? `role="img" aria-label="${String(html`${label}`)}" title="${String(html`${label}`)}"` : 'aria-hidden="true"')}>${glyph(kind)}</span>`

// The page's only script (htmx is loaded without eval): group checkboxes, live filtering with empty-kind hiding,
// relative times, Approve labels that follow the duration and selection, conditional auth header field, live-polling
// status, deep links that open the disclosure holding their target, and accessible <dialog> confirmations.
const pageScript = `const units = [['d', 86400], ['h', 3600], ['m', 60]]
Idiomorph.defaults.callbacks.beforeAttributeUpdated = (name) => name !== 'open'
Idiomorph.defaults.callbacks.beforeNodeMorphed = (node) => !node.getAttribute?.('id')?.startsWith('request-')
const syncHeaderField = () => {
  const sel = document.querySelector('select[name=authType]')
  const box = document.querySelector('[data-auth-header]')
  if (sel && box) box.hidden = sel.value !== 'header'
  const root = document.querySelector('[data-root]')
  if (root) root.hidden = document.querySelector('[name=account]')?.value.trim() !== 'root'
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
    const full = at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })
    const secs = Math.round((at - Date.now()) / 1000)
    const [unit, size] = units.find(([, size]) => Math.abs(secs) >= size) ?? []
    const clock = at.toLocaleTimeString([], { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const day = at.toDateString() === new Date().toDateString() ? '' : at.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' '
    const text = 'rel' in t.dataset ? (unit ? Math.trunc(Math.abs(secs) / size) + unit : 'now') : 'short' in t.dataset ? (t.dataset.short ? '' : day) + clock : full
    t.textContent = text
    if ('rep' in t.dataset) t.innerHTML = '<span class="dim">' + text.slice(0, -2) + '</span>' + text.slice(-2)
    if ('rel' in t.dataset || 'short' in t.dataset) t.title = (t.dataset.rel ?? '') + full
  })
  document.querySelectorAll('button[data-sync]:not([data-was])').forEach((b) => {
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
  if (e.target.matches('[data-copy]')) {
    const b = e.target
    b.closest('.keyline').querySelector('input').select()
    const done = () => { const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = was }, 1500) }
    if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done, () => {})
  }
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
  const action = btn?.getAttribute('aria-label') || btn?.textContent?.trim() || 'Confirm'
  document.getElementById('confirm-title').textContent = action
  document.getElementById('confirm-body').textContent = e.detail.question
  document.getElementById('confirm-yes').textContent = action
  pendingConfirm = e.detail.issueRequest
  dlg.showModal()
})
const busy = (elt, on) => {
  if (elt?.tagName !== 'FORM') return
  elt.toggleAttribute('data-busy', on)
  elt.querySelectorAll('button').forEach((b) => {
    b.disabled = on
    if (on && b.matches('.approve, .deny') && !b.dataset.was) { b.dataset.was = b.textContent; b.textContent = b.matches('.deny') ? 'Denying…' : 'Approving…' }
    if (!on && b.dataset.was) { b.textContent = b.dataset.was; delete b.dataset.was }
  })
}
const say = (text, bad) => {
  const live = document.getElementById('live-status')
  if (!live) return
  live.textContent = text
  live.classList.toggle('offline', bad)
}
document.addEventListener('htmx:confirm', (e) => { if (!e.detail.question) busy(e.detail.elt, true) })
document.addEventListener('htmx:beforeRequest', (e) => busy(e.detail.elt, true))
document.addEventListener('htmx:afterRequest', (e) => {
  busy(e.detail.elt, false)
  if (e.detail.elt?.id === 'agents' || !e.detail.xhr.status) say(e.detail.successful ? 'Live' : 'Offline', !e.detail.successful)
})
document.addEventListener('htmx:beforeSwap', (e) => {
  const { xhr, target } = e.detail
  if (xhr.status < 400 || target?.id !== 'agents') return
  e.detail.shouldSwap = false
  say(xhr.responseText.trim().slice(0, 100) || 'Request failed', true)
})
document.addEventListener('input', tick)
document.addEventListener('htmx:afterSwap', tick)
const b64 = (s) => Uint8Array.from(atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
let sse
const connectEvents = () => {
  if (sse || !('EventSource' in window)) return
  let first = true
  sse = new EventSource('/admin/events')
  sse.addEventListener('change', () => {
    say('Live', false)
    if (first) { first = false; return }
    window.dispatchEvent(new CustomEvent('speaker:change'))
  })
  sse.onerror = () => say('Offline', true)
}
const syncPush = async () => {
  const btn = document.querySelector('[data-push-toggle]')
  const note = document.getElementById('push-status')
  if (!btn || !note) return
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.disabled = true
    note.textContent = 'Unavailable here (on iOS, use Share -> Add to Home Screen over HTTPS first).'
    return
  }
  const reg = await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin' }).catch(() => null)
  const sub = await reg?.pushManager.getSubscription()
  btn.textContent = sub ? 'Disable push on this device' : 'Enable push on this device'
  note.textContent = sub ? 'Enabled on this device.' : 'Off on this device.'
  const test = document.querySelector('[data-push-test]')
  if (test) test.hidden = !sub
}
document.addEventListener('click', async (e) => {
  if (e.target.matches('[data-push-test]')) {
    const btn = e.target
    const note = document.getElementById('push-status')
    btn.disabled = true
    try {
      const res = await fetch('/admin/push/test', { method: 'POST' })
      if (!res.ok) throw new Error((await res.text()).trim() || 'Test push failed')
      if (note) note.textContent = 'Test push sent.'
    } catch (err) {
      if (note) note.textContent = err.message || 'Test push failed'
    } finally {
      btn.disabled = false
    }
    return
  }
  if (!e.target.matches('[data-push-toggle]')) return
  const btn = e.target
  const note = document.getElementById('push-status')
  btn.disabled = true
  try {
    const reg = await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin' })
    const existing = await reg.pushManager.getSubscription()
    if (existing) {
      await fetch('/admin/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: existing.endpoint }) })
      await existing.unsubscribe()
    } else {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') throw new Error('Notification permission denied')
      const { publicKey } = await (await fetch('/admin/push/key')).json()
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) })
      const res = await fetch('/admin/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })
      if (!res.ok) throw new Error('Could not save subscription')
    }
    await syncPush()
  } catch (err) {
    if (note) note.textContent = err.message || 'Push setup failed'
  } finally {
    btn.disabled = false
  }
})
document.addEventListener('DOMContentLoaded', () => { tick(); reveal(); connectEvents(); syncPush() })
document.addEventListener('htmx:afterSettle', () => { syncPush() })
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
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="htmx-config" content="${htmxConfig}"><title>Speaker for the creds</title><link rel="manifest" href="/admin/manifest.json"><link rel="apple-touch-icon" href="/admin/assets/icon.svg"><link rel="stylesheet" href="/admin/assets/pico.css"><style>${raw(css)}</style><script src="/admin/assets/htmx.js"></script><script src="/admin/assets/idiomorph.js"></script><script nonce="${nonce}">${raw(pageScript)}</script></head>`
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
  browser: 'Browser sites',
}
const filterBar = html`<div class="chips" role="search" hidden><input type="text" name="q" placeholder="Filter by name or item" aria-label="Search"><label><input type="radio" name="kind" value="" checked>All</label>${Object.entries(kinds).map(([k, text]) => html`<label><input type="radio" name="kind" value="${k}">${mark(k)}${text}</label>`)}</div>`
const filterEmpty = html`<div id="filter-empty" class="panel" hidden><p>No items match this filter.</p><button type="button" class="secondary" data-clear-filter>Clear filter</button></div>`
const logo = html`<span class="logo" aria-hidden="true"><svg class="ic"><use href="/admin/assets/icons.svg#i-brand"></use></svg></span>`
const confirmDialog = html`<dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body"><article><header><h3 id="confirm-title">Confirm</h3></header><p id="confirm-body"></p><footer class="actions"><button type="button" class="secondary" data-no>Keep</button><button type="button" class="deny" id="confirm-yes" data-yes>Confirm</button></footer></article></dialog>`
export const layout = (nonce: string | undefined, section: Section, body: Html | string, pending = 0) =>
  html`${head(nonce)}<body hx-boost="true" hx-ext="morph"><header class="top"><div class="in"><div class="bar">${logo}<h1>Speaker for the <em>creds</em></h1><nav class="tabs" aria-label="Sections">${sections.map(
    ([id, label, href]) =>
      html`<a href="${href}" ${raw(id === section ? 'aria-current="page"' : '')}>${label}${id === 'agents' ? html`<span class="count" id="nav-count" ${raw(pending ? '' : 'hidden')}>${pending}</span>` : ''}</a>`,
  )}</nav><small id="live-status">Live</small><a href="/admin">Refresh</a></div></div></header><main>${section === 'agents' ? html`${filterBar}${filterEmpty}` : ''}${typeof body === 'string' ? raw(body) : body}</main>${confirmDialog}</body></html>`
const authPage = (
  heading: string,
  intro: string,
  fields: Html,
  button: string,
  action: string,
  exposed: boolean,
  error?: string,
) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Speaker for the creds</title><link rel="stylesheet" href="/admin/assets/pico.css"><style>${raw(css)}</style></head><body><main class="auth-wrap"><div class="auth"><div class="auth-brand">${logo}<span>Speaker for the <em>creds</em></span></div><section class="panel"><h2>${heading}</h2><p>${intro}</p>${exposed ? html`<p class="warn" role="note">This page uses plain HTTP, so your password crosses the network unencrypted.</p>` : ''}${error ? html`<p class="warn" role="alert">${error}</p>` : ''}<form method="post" action="${action}">${fields}<button>${button}</button></form></section></div></main></body></html>`
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
  path: 'Path (the key is a URL segment)',
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
// A form with one button: text, or an icon (a name in `icons`, or compact text such as +30d) named by its label.
const button = (action: string, fields: Html | Html[] | string, label: string, confirm = '', icon = '') =>
  html`<form method="post" action="${action}" ${raw(confirm ? `hx-confirm="${String(html`${confirm}`)}"` : '')}>${fields}${icon ? html`<button class="ib ${icons[icon] ? icon : ''}" aria-label="${label}" title="${label}">${icons[icon] ? glyph(icon) : icon}</button>` : html`<button class="secondary">${label}</button>`}</form>`
// One line of an agent's identity: the self-reported or the speaker-known fields it has, as `say value` joined by dots.
const idLine = (from: 'self' | 'known', values: Partial<Record<keyof typeof identityFields, string>>) =>
  `${from === 'self' ? 'Self-reported' : 'Speaker-known'}: ${Object.entries(identityFields)
    .filter(([field, spec]) => spec.from === from && values[field as keyof typeof identityFields])
    .map(([field, spec]) => `${spec.say} ${values[field as keyof typeof identityFields]}`)
    .join(' · ')}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
// A local-time stamp the page script rewrites: a bare duration with `rel` (the hover title's prefix), else a 24-hour
// clock (`short`: with the date when not today; 'time': clock only; `rep`: the minute dimmed as repeated).
const local = (ms: number, rel?: string, short?: '' | 'time', rep = false) =>
  html`<time datetime="${new Date(ms).toISOString()}" data-local ${raw(rel !== undefined ? `data-rel="${rel}"` : short === undefined ? '' : `data-short="${short}"${rep ? ' data-rep' : ''}`)}>${time(ms)} UTC</time>`
// A small icon naming what the value beside it is.
const tm = (icon: string, label: string, body: Html | string) =>
  html`<span class="t" title="${label}" aria-label="${label}">${glyph(icon)}${body}</span>`
const registered = (h: { source: string; registeredAt: number }) =>
  html`from ${h.source} · registered ${local(h.registeredAt)}`
const empty = (text: string) => html`<p><small>${text}</small></p>`
type Card = View['cards'][number]
type Grant = View['grants'][number]
const enforcing = {
  sent: ['applying', 'Approved, applying'],
  'host-offline': ['offline', 'Host unavailable; enforcement unconfirmed'],
}
const uses = (n: number, query: string) =>
  n ? html`<a href="/admin/log?${query}">${plural(n, 'use', 'uses')}</a>` : 'unused'
const span = (ms: number) =>
  ms % 86_400_000 === 0
    ? `${ms / 86_400_000}d`
    : ms % 3_600_000 === 0
      ? `${ms / 3_600_000}h`
      : `${Math.round(ms / 60_000)}m`
const level = (item: string) => (/\.full$|:rw$/.test(item) ? 'RW' : /\.read$|^folder:/.test(item) ? 'R' : '')
// An address without its scheme; a service under a parent's address shows only what follows it, marked as a child.
const addr = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')
const under = (full: string, parent?: string) => (parent && full.startsWith(parent) ? full.slice(parent.length) : full)

// An action, as an icon on a row and as a button in the row's open body on a phone.
type Act = [Html, Html]
const go = (href: string, icon: string, label: string, text: string): Act => [
  html`<a class="ib" href="${href}" aria-label="${label}" title="${label}">${glyph(icon)}</a>`,
  html`<a class="action-btn" href="${href}">${text}</a>`,
]
const post = (action: string, fields: Html, icon: string, label: string, text: string, confirm = ''): Act => [
  button(action, fields, label, confirm, icon),
  button(action, fields, text, confirm),
]
// The Agents panel: what needs a decision, then each agent with its access beneath it, then the quiet rest. The one
// view gives every count; the panel is morphed every 5 seconds. The morph skips request cards, so unticked items, a
// chosen duration and an open Review stay.
export function agents(
  { hosts, agents: all, cards, grants, sessions }: View,
  groups: Record<string, Group>,
  connected: Set<string>,
  services: Record<string, Service>,
) {
  const byId = new Map(all.map((a) => [a.id, a]))
  const title = (a: View['agents'][number]) => (a.title ? html` <small>${a.title}</small>` : '')
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
  const itemIcon = (i: Card['items'][number]): [icon: string, label: string] => {
    if (i.kind === 'service')
      return i.item.endsWith('.full') ? ['service-rw', 'Service (read/write)'] : ['service', 'Service (read)']
    if (i.kind === 'folder')
      return i.item.endsWith(':rw') ? ['folder-rw', 'Folder (read/write)'] : ['folder', 'Folder (read-only)']
    if (i.kind === 'site') return ['site', 'Network site']
    if (i.kind === 'secret') return ['secret', 'Secret']
    if (i.kind === 'ssh') return ['ssh', 'SSH shell']
    if (i.kind === 'browser') return ['browser', 'Browser session']
    if (i.kind === 'mcp') return ['mcp', 'In-sandbox MCP']
    if (i.kind === 'ext') return ['ext', 'Pi extension']
    return ['host', 'Sandbox host']
  }
  const pick = (i: Card['items'][number]) => {
    const [icon, label] = itemIcon(i)
    const tier = i.tier ?? 'routine'
    return html`<label class="tier-${tier}"><input type="checkbox" name="items" value="${i.item}" ${raw(i.wider ? '' : 'checked')}>${mark(icon, tier, label)}<span><code>${i.item}</code> <small>${i.text}</small>${i.kind === 'browser' ? html` <a href="/admin?section=services#setup-browsers" hx-boost="false">Open it to log in</a>` : ''}${i.warning ? html` <mark title="${i.hint ?? ''}">${i.warning}</mark>` : ''}</span></label>`
  }
  const isPrivate = (kind: string, item: string) =>
    kind === 'service'
      ? services[item.replace(/\.(read|full)$/, '')]?.auth.type !== 'none'
      : ['folder', 'ssh', 'browser', 'secret'].includes(kind)
  const isWeb = (kind: string, reach: string[]) => kind === 'site' || (kind === 'ext' && reach.length > 1)
  // Self-reported identity and what speaker itself knows stay on separate, labelled lines.
  const meta = ({ who, type, subject }: Card) =>
    type === 'host'
      ? html`<small class="card-meta" id="host-${subject}">${registered({ source: who.source, registeredAt: who.at as number })}</small>`
      : html`${who.agent !== undefined ? html`<small class="card-meta">${idLine('self', { agent: who.agent })}</small>` : ''}<small class="card-meta">${idLine('known', who)}${twin(byId.get(subject))}</small>`
  const cardHtml = (r: Card) => {
    const host = r.type === 'host'
    const a = byId.get(r.subject)
    const heldGrants = host ? [] : grants.filter((g) => g.subject === r.subject)
    const reqPrivate = !host && r.items.some((i) => isPrivate(i.kind, i.item))
    const reqWeb = !host && r.items.some((i) => isWeb(i.kind, i.reach))
    const heldPrivate = heldGrants.some((g) => isPrivate(g.kind, g.item))
    const heldWeb = heldGrants.some((g) => isWeb(g.kind, g.detail.reach))
    const combo =
      reqPrivate && reqWeb
        ? 'Combines private access with web egress.'
        : reqPrivate && heldWeb
          ? 'Agent already holds web egress.'
          : reqWeb && heldPrivate
            ? 'Agent already holds private access.'
            : ''
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
    const noted = r.items.filter((i) => i.warning || i.tier === 'sensitive')
    // A bundle reads as its name, size and a scope summary, with sensitive items or server warnings outside the Review; loose items show directly.
    const bundle = asked.length
      ? html`<p class="scope"><strong>${asked.map((g) => g.name).join(', ')}</strong> · ${plural(r.items.length, 'capability', 'capabilities')} · <small>${some.join(', ')}${r.items.length > 3 ? ` and ${r.items.length - 3} more` : ''}</small></p>${noted.map(
          (i) => {
            const [icon, label] = itemIcon(i)
            return html`<p class="alert">${mark(icon, i.tier ?? 'sensitive', label)}<span><code>${i.item}</code>${i.warning ? html` <mark title="${i.hint ?? ''}">${i.warning}</mark>` : ''}</span></p>`
          },
        )}`
      : ''
    return html`<article id="request-${r.id}" data-kind="${[...new Set(r.items.map((i) => i.kind))].join(' ')}"><header><div class="card-head"><strong>${a ? a.label : r.who.label}</strong>${a ? title(a) : ''}${r.as ? html` <small>as <code>${r.as}</code></small>` : ''}<small>${host ? 'wants to register' : html`${a?.sandboxHost ? `${a.sandboxHost} · ` : ''}requested ${local(r.createdAt, 'Requested ')}`}</small></div>${meta(r)}</header>${host ? '' : html`<p class="reason"><span class="reason-label">Reason</span> ${r.reason || html`<small>none supplied yet</small>`}</p>`}${bundle}${combo ? html`<p class="context-note">${glyph('info')}<span>${combo}</span></p>` : ''}<form method="post" action="/admin/requests/${r.id}/approve">${r.items.map((i) => hidden('shown', i.item))}${asked.length ? html`<details class="sub-details"><summary>Review ${plural(r.items.length, 'capability', 'capabilities')}</summary>${sets}</details>` : sets}<div class="stub">${duration}<div class="actions"><button class="approve" ${raw(host ? '' : 'data-sync')}>${host ? 'Approve host' : `Approve ${r.duration === 'permanent' ? 'until revoked' : `for ${r.duration}`}`}</button><button class="deny" formaction="/admin/requests/${r.id}/deny">${host ? 'Deny host' : 'Deny'}</button></div></div></form>${r.trigger ? html`<footer><small>Triggered by <code>${r.trigger}</code></small></footer>` : ''}</article>`
  }

  const end = (g: { expiresAt: string | null }) => (g.expiresAt ? Date.parse(g.expiresAt) : Number.POSITIVE_INFINITY)
  const sid = (g: Grant) => g.item.replace(/\.(read|full)$/, '')
  const agentBlock = (a: View['agents'][number]) => {
    const mine = grants.filter((g) => g.subject === a.id).sort((x, y) => end(x) - end(y))
    const open = sessions.filter((s) => s.agent === a.id)
    const c = a.counts
    const odd = [c.refused && `${c.refused} refused`, c.blocked && `${c.blocked} blocked`].filter(Boolean).join(' · ')
    const held = a.launched ?? []
    // The expiry every grant shares is shown once on the header; a grant shows its own only when it differs.
    const common = mine.length && mine.every((g) => g.expiresAt === mine[0].expiresAt) ? mine[0].expiresAt : undefined
    const when = (g: Grant) =>
      g.expiresAt === common
        ? ''
        : g.expiresAt === null
          ? html`<span title="no expiry">∞</span>`
          : local(Date.parse(g.expiresAt), 'Expires ')
    const state = (g: Grant) => {
      const [text, title] = enforcing[g.enforcement as keyof typeof enforcing] ?? []
      return text ? html`<mark data-state="${g.enforcement}" title="${title}">${text}</mark>` : ''
    }
    const extendable = (g: Grant) => g.expiresAt !== null && g.grantedMs !== undefined
    const span1 = (g: Grant) => span(g.grantedMs ?? 0)
    const acts = (g: Grant): Act[] => {
      const id = hidden('id', g.id)
      const gone = `Revoke ${g.item} for ${g.label}? Calls using it are blocked immediately.`
      return [
        ...(extendable(g)
          ? [post('/admin/grants/extend', id, 'extend', `Extend ${g.item} by ${span1(g)}`, `Extend by ${span1(g)}`)]
          : []),
        post('/admin/grants/revoke', id, 'revoke', `Revoke ${g.item}`, 'Revoke', gone),
      ]
    }
    const tag = (g: Grant) => html`id="grant-${g.id}" data-item="${g.item}" data-expires="${g.expiresAt ?? ''}"`
    // One grant, one line: kind icon, name, detail (an address for a service), level, uses, own expiry, actions. On a
    // phone only the icon, name, level and expiry stay on the line; tapping it opens the rest.
    const line = (g: Grant, name: Html | string, main: Html | string, cls = '') => {
      const lv = level(g.item)
      const note = html`${main}${state(g)}${g.detail.warning ? html` <mark title="${g.detail.hint ?? ''}">${g.detail.warning}</mark>` : ''}`
      const n = g.uses
        ? html`<a href="/admin/log?grant=${encodeURIComponent(g.id)}" title="${plural(g.uses, 'use', 'uses')}">${g.uses}</a>`
        : ''
      return html`<details class="gr ${cls}" ${tag(g)}><summary class="rw">${ico(g.kind)}<span class="clip nm1">${name}</span><span class="clip dim mc">${note}</span><span class="lv ${lv === 'RW' ? 'w' : ''}" title="${lv === 'RW' ? 'read and change' : lv ? 'read only' : ''}">${lv}</span><span class="n">${n}</span><span class="dim">${when(g)}</span><span class="acts">${acts(g).map((a) => a[0])}</span></summary><div class="xb"><span class="dim">${note}</span>${g.uses ? html`<a href="/admin/log?grant=${encodeURIComponent(g.id)}">${plural(g.uses, 'use', 'uses')}</a>` : ''}<div class="bt">${acts(g).map((a) => a[1])}</div></div></details>`
    }
    const addrOf = (id: string) => (services[id] ? addr(services[id].baseUrl) : id)
    // A service is its name; a scope `parent:name` sits under its parent, which is always shown (dimmed when this
    // agent holds only scopes), as `:name` with the address beyond the parent's.
    const service = (g: Grant, parent?: string) => {
      const id = sid(g)
      return line(
        g,
        parent ? html`<span class="dim">:</span>${id.slice(parent.length + 1)}` : id,
        html`<code title="${services[id]?.baseUrl ?? ''}">${under(addrOf(id), parent && addrOf(parent))}</code>`,
        parent ? 'sc' : '',
      )
    }
    const svc = mine.filter((g) => g.kind === 'service')
    const lead = (g: Grant) => sid(g).split(':')[0]
    const tree = [...new Set(svc.map(lead))]
      .sort((x, y) => addrOf(x).localeCompare(addrOf(y)))
      .flatMap((h) => {
        const own = svc.filter((g) => sid(g) === h).sort((x, y) => x.item.localeCompare(y.item))
        return [
          ...(own.length
            ? own.map((g) => service(g))
            : [
                html`<div class="gr rw ph">${ico('service')}<span class="clip nm1">${h}</span><span class="clip mc"><code>${addrOf(h)}</code></span><span class="lv">–</span></div>`,
              ]),
          ...svc
            .filter((g) => lead(g) === h && sid(g) !== h)
            .sort((x, y) => x.item.localeCompare(y.item))
            .map((g) => service(g, h)),
        ]
      })
    const others = mine.filter((g) => !['service', 'site', 'ext'].includes(g.kind))
    const chip = (g: Grant) =>
      html`<span class="c" ${tag(g)} title="${[g.item, g.kind === 'ext' ? g.detail.text : '', g.detail.warning].filter(Boolean).join(' · ')}">${g.item.replace(/^\w+:/, '')}${when(g)}${state(g)}${acts(
        g,
      )
        .slice(when(g) ? 0 : -1)
        .map((a) => a[0])}</span>`
    const chips = (kind: string, list: Html[]) =>
      list.length ? html`<div class="gr rw cs">${ico(kind)}<div>${list}</div></div>` : ''
    const ids = (list: Grant[]) => list.map((g) => hidden('id', g.id))
    const toExtend = mine.filter(extendable)
    const model = a.agent.split(' · ')[0].replace(` on ${a.sandboxHost}`, '')
    const head = html`<header class="ah"><span class="nt"><strong>${a.label}</strong>${a.title ? html`<q>${a.title}</q>` : ''}</span><small class="md">${[a.sandboxHost, model].filter(Boolean).join(' · ')}</small>${mine.some((g) => g.enforcement !== 'enforced') ? html`<mark title="Some access is not yet confirmed in force">not confirmed</mark>` : ''}${odd ? html`<a class="warn" hx-boost="false" href="/admin/log?agent=${encodeURIComponent(a.id)}" title="${c.lastRefusal ?? ''}">${odd}</a>` : ''}${cards.filter((r) => r.subject === a.id).map((r) => html`<a href="#request-${r.id}"><mark>request waiting</mark></a>`)}<span class="grow"></span>${tm('used', a.lastUsedAt ? 'Last used' : 'Unused', a.lastUsedAt ? local(a.lastUsedAt, 'Last used ') : '–')}${common === null ? tm('left', 'No expiry', '∞') : common ? tm('left', 'Time left', local(Date.parse(common), 'Expires ')) : ''}${common !== undefined && mine.length > 1 ? html`${toExtend.length ? button('/admin/grants/extend', ids(toExtend), 'Extend all grants', '', `+${span1(toExtend[0])}`) : ''}${button('/admin/grants/revoke', ids(mine), `Revoke all ${mine.length} grants of ${a.label}`, `Revoke all ${mine.length} grants of ${a.label}? Calls using them are blocked immediately.`, 'revoke')}` : ''}<details class="pop"><summary class="ib" aria-label="Details and agent controls" title="Details and agent controls">${glyph('more')}</summary><div><p><small>${idLine('self', a)}<br>${idLine('known', { ...a, via: a.sandboxHost, key: a.tokenHash.slice(0, 8) })}<br>Id <code>${a.id}</code> · enrolled ${local(a.createdAt)}<br>${uses(a.uses, `agent=${encodeURIComponent(a.id)}`)}${a.lastUsedAt ? html`, last used ${local(a.lastUsedAt)}` : ''}<br>${plural(a.requests, 'request', 'requests')} · ${a.granted} granted · ${a.denied} denied · ${c.refused} refused · ${c.blocked} blocked</small></p>${button(`/admin/agents/${a.id}/revoke`, '', 'Revoke agent', `Revoke agent ${a.label}? Its token and all its grants end immediately.`)}</div></details></header>`
    const session = (x: (typeof open)[number]) =>
      html`<details class="gr"><summary class="rw">${ico('ssh')}<span class="clip nm1">${x.what}</span><span class="clip dim mc">${local(x.started, 'Open since ')}</span><span class="lv"></span><span class="n"></span><span></span><span class="acts">${button('/admin/ssh/sessions/end', hidden('id', x.id), `End SSH session ${x.what}`, `End this SSH session now? ${x.what}`, 'revoke')}</span></summary><div class="xb"><div class="bt">${button('/admin/ssh/sessions/end', hidden('id', x.id), 'End session', `End this SSH session now? ${x.what}`)}</div></div></details>`
    return html`<article id="agent-${a.id}" data-kind="${[...new Set([...mine.map((g) => g.kind), ...open.map(() => 'ssh'), ...held.map(() => 'ext')])].join(' ')}">${head}${tree}${others.sort((x, y) => x.item.localeCompare(y.item)).map((g) => line(g, g.item.replace(/^\w+:|:rw$/g, ''), g.detail.text))}${open.map(session)}${chips('site', mine.filter((g) => g.kind === 'site').map(chip))}${chips('ext', [...held.map((item) => html`<span class="c held" title="${item}: held for the task by the launch template; not revoked here">${item.replace(/^\w+:/, '')}</span>`), ...mine.filter((g) => g.kind === 'ext').map(chip)])}</article>`
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
    html`<section id="agents" hx-get="/admin/panel/agents" hx-trigger="speaker:change from:window, every 30s" hx-target="#agents" hx-swap="morph:outerHTML" hx-sync="body:queue all" data-pending="${cards.length}">${cards.length ? html`<section id="needs" class="panel region"><h2>Needs attention <small class="count">${cards.length}</small></h2><div class="cards">${cards.map(cardHtml)}</div></section>` : ''}<section id="current" class="panel"><h2>Current agents ${current.length ? html`<small class="count">${current.length}</small>` : ''}</h2>${current.length ? html`<div class="list">${current.map(agentBlock)}</div>` : empty('No agent has current access.')}<p><small>Expiry and revocation block new calls; a response already streaming may finish.</small></p></section>${rest.length ? html`<details id="idle" class="panel"><summary>No current access (${rest.length})</summary><div class="list">${rest.map(agentBlock)}</div></details>` : ''}${approved.length ? html`<details id="hosts" class="panel"><summary>Hosts (${approved.length})</summary><table class="data-table"><thead><tr><th scope="col">Host</th><th scope="col">Connection</th><th scope="col">Kinds</th><th scope="col" aria-label="Actions"></th></tr></thead><tbody>${approved.map((h) => html`<tr id="host-${h.id}"><td data-label="Host"><strong>${h.name}</strong></td><td data-label="Connection">${connected.has(h.id) ? 'Connected' : 'Not connected'}</td><td data-label="Kinds">${h.kinds.join(' ') || 'none'}</td><td class="act"><details><summary>Details</summary><p><small>Id <code>${h.id}</code> · ${registered(h)}</small></p>${button(`/admin/hosts/${h.id}/remove`, '', 'Remove host', `Remove sandbox host ${h.name}? Its agents and their grants end immediately.`)}</details></td></tr>`)}</tbody></table></details>` : ''}</section>`,
  )
}
const groupErrors: Record<string, string> = {
  empty: 'Group not saved: list at least one item, one per line.',
  line: 'Group not saved: each line must be an item: <service>.read, <service>.full, site:<host>, secret:<NAME>, ssh:<target>, folder:<share>[:rw], browser:<site>, mcp:<id> or ext:<id>.',
  id: 'Group not saved: the id may use letters, numbers, - and _ (up to 64 characters).',
  description: 'Group not saved: keep the description to one line of at most 200 characters.',
}
const secretErrors: Record<string, string> = {
  secretName: 'Secret not saved: the name may use letters, digits, _ and -.',
  secretHosts: 'Secret not saved: give at least one host and a variable name, or choose Released.',
  secretValue: 'Secret not saved: the value must be one line.',
  secretFlip: 'Secret not saved: type the value again to release a secret that is inserted today.',
}
const td = (label: string, body: Html | string) => html`<td data-label="${label}">${body}</td>`
const act = (...buttons: (Html | string)[]) => html`<td class="act"><div class="actions">${buttons}</div></td>`
// A disclosure row under its table row, spanning every column.
const more = (cols: number, summary: string, body: Html) =>
  html`<tr class="more"><td colspan="${cols}"><details><summary aria-label="${summary}" title="${summary}">${glyph(summary === 'Edit' ? 'edit' : 'more')}</summary>${body}</details></td></tr>`
const table = (heads: string[], rows: Html[]) =>
  html`<table class="data-table"><thead><tr>${heads.map((h) => html`<th scope="col" ${raw(h === 'Actions' ? 'aria-label="Actions"' : '')}>${h === 'Actions' ? '' : h}</th>`)}</tr></thead><tbody>${rows}</tbody></table>`
// The first two entries, one per line; the rest behind "N more".
const preview = (items: string[], mono = false) => {
  const one = (i: string) => html`<div>${mono ? html`<code>${i}</code>` : i}</div>`
  return html`${items.slice(0, 2).map(one)}${items.length > 2 ? html`<details><summary>${items.length - 2} more</summary>${items.slice(2).map(one)}</details>` : ''}`
}
const consequence = (text: string) => html`<p><small>${text}</small></p>`
export function setup({
  services,
  keyed,
  owned,
  groups,
  ssh,
  mcp,
  selected,
  scope,
  sshTarget,
  sshShare,
  browsers,
  live,
  brokerReady,
  error,
}: Setup) {
  const chosen = selected && Object.hasOwn(services, selected) ? services[selected] : undefined
  const authType = chosen?.auth.type ?? 'bearer'
  // Adding a scope starts the form at `parent:` with the parent's address; a scope uses the parent's key and authentication.
  const prefix = !chosen && scope && Object.hasOwn(services, scope) ? `${scope}:` : ''
  const formId = chosen ? (selected ?? '') : prefix
  const hasAdvanced = Boolean(chosen?.readPaths?.length || chosen?.mcp || chosen?.notes)
  const serviceForm = html`<form method="post" action="/admin/services/save">${input('id', 'Service id (parent:scope for a scope)', 'text', formId)}${input('baseUrl', 'Upstream base URL', 'url', chosen?.baseUrl ?? (prefix ? services[scope ?? ''].baseUrl : undefined))}${formId.includes(':') ? hidden('authType', 'bearer') : html`${select('authType', 'Authentication', ['bearer', 'header', 'basic', 'path', 'none'], authType)}<div data-auth-header ${raw(authType === 'header' ? '' : 'hidden')}>${input('headerName', 'Credential header', 'text', chosen?.auth.type === 'header' ? chosen.auth.headerName : '')}</div>${input('secret', 'Credential (blank keeps current)', 'password')}`}${select('read', 'Read rule (GET / HEAD / OPTIONS)', ['ask', 'open', 'never'], chosen?.read ?? 'ask')}${select('write', 'Write rule (all other methods)', ['ask', 'never'], chosen?.write ?? 'ask')}<details class="sub-details" ${raw(hasAdvanced ? 'open' : '')}><summary>Advanced options (read paths, MCP, notes)</summary>${area('readPaths', 'Read-only POST paths, one per line', chosen?.readPaths?.join('\n'))}<label><input type="checkbox" name="mcp" ${raw(chosen?.mcp ? 'checked' : '')}> MCP server: classify tool calls by their read-only hints</label>${area('notes', 'Notes for agents (markdown, optional)', chosen?.notes, 5)}</details>${consequence('Saving ends any grant that now reaches further or is no longer allowed.')}<button>Save service</button></form>`
  const tools = (id: string) =>
    html`<div class="actions">${error === 'tools' ? html`<p class="warn" role="alert">Could not list tools; check the URL and credential.</p>` : ''}<small>${mcp[id] ? `Tools: ${mcp[id].read} read · ${mcp[id].write} write${mcp[id].unannotated ? ` (${mcp[id].unannotated} without hints, treated as write)` : ''}` : 'Tools not listed yet'}</small>${button('/admin/services/tools', hidden('id', id), 'Refresh tools')}</div>`
  // A scope `parent:name` is listed under its parent.
  const parentOf = (id: string) =>
    id.includes(':') && Object.hasOwn(services, id.split(':')[0]) ? id.split(':')[0] : undefined
  // Only departures from the default rule (ask) show; the default stays as text for assistive technology.
  const rule = (letter: string, label: string, value: string) =>
    value === 'ask'
      ? html`<span class="vh" data-label="${label}">ask</span>`
      : html`<span class="lv ${value === 'open' ? 'w' : ''}">${letter} <span data-label="${label}">${value}</span></span>`
  // One Setup line (a service, a scope, an SSH target or share): kind icon, name, address or path, marks, and its
  // actions.
  const entry = (
    kind: string,
    sub: boolean,
    name: Html,
    shown: string,
    title: string,
    marks: Html | string,
    acts: Act[],
  ) =>
    html`<details class="gr ${sub ? 'sc' : ''}"><summary class="rw sv">${ico(kind)}<span class="nm nm1">${name}</span><code class="clip mc" title="${title}">${shown}</code><span class="nm">${marks}</span><span class="acts">${acts.map((a) => a[0])}</span></summary><div class="xb"><code>${shown}</code><div class="bt">${acts.map((a) => a[1])}</div></div></details>`
  const nameOf = (label: string, sub: boolean, title = label) =>
    html`<strong title="${title}">${sub ? html`<span class="dim">:</span>` : ''}${label}</strong>`
  const serviceRow = (id: string, parent?: string) => {
    const s = services[id]
    const q = encodeURIComponent(id)
    const own = s.auth.type !== 'none' && s.auth.secret === id
    const key =
      s.auth.type !== 'none' && !keyed.has(id)
        ? html`<mark data-label="Credential">no key</mark>`
        : own
          ? html`<span class="vh" data-label="Credential">Set</span>`
          : ''
    const kids = Object.keys(services).filter((k) => parentOf(k) === id)
    return entry(
      'service',
      Boolean(parent),
      html`${nameOf(parent ? id.slice(parent.length + 1) : id, Boolean(parent), id)}${s.mcp ? html`<span class="badge">MCP</span>` : ''}`,
      under(addr(s.baseUrl), parent && addr(services[parent].baseUrl)),
      s.baseUrl,
      html`${rule('R', 'Read policy', s.read)}${rule('W', 'Write policy', s.write)}${key}`,
      [
        ...(own && !id.includes(':')
          ? [go(`/admin?section=services&scope=${q}`, 'add', `Add a scope to ${id}`, 'Add scope')]
          : []),
        go(`/admin?section=services&service=${q}`, 'edit', `Edit ${id}`, 'Edit'),
        go(`/admin/log?service=${q}`, 'log', `Activity of ${id}`, 'Activity'),
        post(
          '/admin/services/delete',
          hidden('id', id),
          'del',
          `Delete ${id}`,
          'Delete',
          `Delete service ${id}? Its credential is erased and its grants and pending requests are removed.${kids.length ? ` ${kids.join(', ')} use${kids.length === 1 ? 's' : ''} its key and will stop working.` : ''}`,
        ),
      ],
    )
  }
  const serviceRows = Object.keys(services)
    .filter((id) => !parentOf(id))
    .flatMap((id) => [
      serviceRow(id),
      ...Object.keys(services)
        .filter((k) => parentOf(k) === id)
        .map((k) => serviceRow(k, id)),
    ])
  const secretForm = (name = '', o?: Owned[string]) =>
    html`<form method="post" action="/admin/secrets/save">${input('name', 'Name (agents ask for secret:NAME)', 'text', name)}${input('env', 'Environment variable the agent sees', 'text', o?.env)}${area('hosts', 'Allowed hosts, one per line', o?.hosts?.join('\n'))}${consequence('Adding a host ends the grants already given for this secret.')}<label><input type="checkbox" name="release" ${raw(o?.release ? 'checked' : '')}> Released: the agent receives the value, no hosts</label>${input('value', o ? 'Replace value; blank keeps current' : 'Value (never shown again)', 'password')}<button>Save secret</button></form>`
  const secretRows = Object.entries(owned).flatMap(([name, o]) => [
    html`<tr>${td('Name', html`${ico('secret')}<strong>${name}</strong>`)}${td('Allowed destinations', o.release ? html`<mark title="Approving lets the agent read the value itself">released</mark>` : preview(o.hosts ?? []))}${td('Agent variable', o.release ? '' : html`<code>${o.env}</code>`)}${act(button('/admin/secrets/delete', hidden('name', name), `Delete ${name}`, `Delete secret ${name}? Its value is erased.`, 'del'))}</tr>`,
    more(4, 'Edit', secretForm(name, o)),
  ])
  const targets = Object.entries(ssh.targets)
  const shares = Object.entries(ssh.shares)
  const shareRow = ([name, share]: [string, SshSetup['shares'][string]]) => {
    const home = ssh.targets[share.target]?.home === share.path
    const q = encodeURIComponent(name)
    return entry(
      'folder',
      Boolean(ssh.targets[share.target]),
      nameOf(name, Boolean(ssh.targets[share.target])),
      share.path,
      share.path,
      ssh.targets[share.target]
        ? home
          ? html`<mark>home directory</mark>`
          : ''
        : html`<mark>unknown target ${share.target}</mark>`,
      [
        go(`/admin/log?share=${q}`, 'log', `Activity of ${name}`, 'Activity'),
        post(
          '/admin/ssh/shares/delete',
          hidden('name', name),
          'del',
          `Delete ${name}`,
          'Delete',
          `Delete share ${name}? Open sessions and grants for it end.`,
        ),
      ],
    )
  }
  const targetRow = ([alias, t]: (typeof targets)[number]) => {
    const q = encodeURIComponent(alias)
    const mates = shares.filter(([, share]) => share.target === alias).map(([name]) => name)
    return entry(
      'ssh',
      false,
      html`<strong title="${alias}">${alias}</strong>`,
      `${t.account}@${t.host}:${t.port}`,
      `host key ${t.fingerprint}`,
      html`${t.account === 'root' ? html`<mark title="root has no limits">root</mark>` : ''}${t.sudo ? html`<mark title="passwordless sudo works">sudo</mark>` : ''}${t.sftp ? '' : html`<mark title="no sftp-server found: no file delivery">no sftp</mark>`}`,
      [
        go(`/admin?section=services&sshShare=${q}`, 'add', `Add a share to ${alias}`, 'Add share'),
        go(`/admin?section=services&sshTarget=${q}`, 'edit', `Details of ${alias}`, 'Details'),
        post('/admin/ssh/targets/check', hidden('alias', alias), 'check', `Re-check ${alias}`, 'Re-check'),
        go(`/admin/log?target=${q}`, 'log', `Activity of ${alias}`, 'Activity'),
        post(
          '/admin/ssh/targets/delete',
          hidden('alias', alias),
          'del',
          `Delete ${alias}`,
          'Delete',
          `Delete target ${alias}?${mates.length ? ` Its shares (${mates.join(', ')}) go too, and open` : ' Open'} sessions and grants for it end.`,
        ),
      ],
    )
  }
  const sshRows = [
    ...targets.flatMap((target) => [
      targetRow(target),
      ...shares.filter(([, share]) => share.target === target[0]).map(shareRow),
    ]),
    ...shares.filter(([, share]) => !ssh.targets[share.target]).map(shareRow),
  ]
  // The line to paste into a target's authorized_keys, with a copy button for it and for a shell command that adds it.
  const keyLine = (line: string) =>
    html`<div class="keyline"><input readonly value="${line}" aria-label="Line for authorized_keys" spellcheck="false" data-1p-ignore><button type="button" class="secondary" data-copy="${line}">Copy</button><button type="button" class="secondary" data-copy="echo '${line}' >> ~/.ssh/authorized_keys">Copy as command</button></div>`
  const picked = sshTarget && ssh.targets[sshTarget]
  const targetForm = html`<form method="post" action="/admin/ssh/targets/add">${input('alias', 'Name (agents ask for ssh:NAME)')}${input('host', 'Host name or address')}${input('account', 'Account (a limited login, not root)')}<label data-root hidden><input type="checkbox" name="confirmRoot"> I understand: root has no limits</label><details class="sub-details"><summary>Advanced</summary>${input('port', 'SSH port', 'number', '22')}${input('from', 'Addresses speaker connects from (blank: detected)')}${input('sftp', 'sftp-server path (blank: probed)')}</details><button>Add target and pin its host key</button></form>`
  const sshPanel = html`${ssh.error ? html`<p class="warn" role="alert">${ssh.error}</p>` : ''}${ssh.note ? html`<p role="status"><mark>${ssh.note}</mark></p>` : ''}${ssh.publicKey ? keyLine(`from="${targets[0]?.[1].from ?? "<speaker's address>"}",restrict ${ssh.publicKey}`) : ''}${picked && sshTarget ? html`<article><h3>${sshTarget}</h3>${keyLine(picked.line)}<p><small>Host key <code>${picked.fingerprint}</code>${picked.sftp ? html` · sftp-server <code>${picked.sftp}</code>` : ''}</small></p><form method="post" action="/admin/ssh/targets/from" class="actions">${hidden('alias', sshTarget)}${input('from', 'Addresses speaker connects from (comma-separated)', 'text', picked.from)}<button class="secondary">Save addresses</button></form></article>` : ''}${sshRows.length ? html`<div>${sshRows}</div>` : ''}${
    targets.length
      ? html`<details><summary>Add a target</summary>${targetForm}</details><details ${raw(sshShare ? 'open' : '')}><summary>Add a share</summary><form method="post" action="/admin/ssh/shares/save">${input('name', 'Name (agents ask for folder:NAME)')}${select(
          'target',
          'Target',
          targets.map(([alias]) => alias),
          sshShare,
        )}${input('path', 'Absolute path on the target')}<button>Save share</button></form></details>`
      : targetForm
  }`
  const groupForm = (id: string, group: Group) =>
    html`<form method="post" action="/admin/groups/save">${input('id', 'Group id', 'text', id)}${input('description', 'Description (one line, optional)', 'text', group.description)}${area('items', 'Items, one per line', group.items.join('\n'), 5)}<button>Save group</button></form>`
  const groupRows = Object.entries(groups).flatMap(([id, group]) => [
    html`<tr>${td('Group', html`<strong>${id}</strong><br><small>${plural(group.items.length, 'item', 'items')}</small>`)}${td('Purpose', group.description ?? '')}${td('Members', preview(group.items, true))}${act(button('/admin/groups/delete', hidden('id', id), `Delete ${id}`, `Delete group ${id}? Agents can no longer request it. Existing grants stay.`, 'del'))}</tr>`,
    more(4, 'Edit', groupForm(id, group)),
  ])
  const browserForm = (name = '', site?: BrowserSite) =>
    html`<form method="post" action="/admin/browsers/save">${input('name', 'Name (agents ask for browser:NAME)', 'text', name)}${input('startUrl', 'Start URL (the sign-in page)', 'url', site?.startUrl)}${area('domains', 'Domains it may reach, one per line (example.com, *.example.com)', site?.domains.join('\n'))}${consequence('Saving closes an open session for it; adding a domain ends the grants already given.')}<button>Save browser site</button></form>`
  const browserRows = Object.entries(browsers).flatMap(([name, site]) => {
    const q = encodeURIComponent(name)
    const until = live[name]
    const open = html`<form method="post" action="/admin/browser/${q}/open" hx-boost="false" class="actions"><select name="life" aria-label="Lifetime" style="width:auto;margin:0">${Object.keys(lifetimes).map((life) => html`<option>${life}</option>`)}</select><button class="secondary">Open</button></form>`
    return [
      html`<tr>${td('Name', html`${ico('browser')}<strong>${name}</strong>`)}${td('Start URL', html`<code>${site.startUrl}</code>`)}${td('Domains', preview(site.domains, true))}${td('State', until ? html`open, closes ${local(until, 'Closes ')}` : 'closed')}${act(
        until
          ? html`<a class="action-btn" href="/admin/browser/${q}" hx-boost="false">View</a>${button(`/admin/browser/${q}/close`, '', `Close ${name}`, `Close ${name}? Its login ends.`)}`
          : open,
        button(
          '/admin/browsers/delete',
          hidden('name', name),
          `Delete ${name}`,
          `Delete browser site ${name}? Its session and grants end.`,
          'del',
        ),
      )}</tr>`,
      more(5, 'Edit', browserForm(name, site)),
    ]
  })
  const browserPanel = html`${brokerReady ? '' : html`<p class="warn" role="note">${brokerMissing}.</p>`}${error === 'browser' ? html`<p class="warn" role="alert">Browser site not saved: the name uses letters, numbers, - and _; the start URL is http(s), without a query, on one of the domains.</p>` : ''}${browserRows.length ? table(['Name', 'Start URL', 'Domains', 'State', 'Actions'], browserRows) : empty('No browser sites. A browser site is a website you sign in to by hand; agents then use it without seeing the login.')}<details><summary>Add a browser site</summary>${browserForm()}</details>`
  const jumpNav = html`<nav class="jump-links" aria-label="Setup sections"><a href="#setup-services">Services</a><a href="#setup-secrets">Secrets</a><a href="#groups">Groups</a><a href="#setup-ssh">SSH</a><a href="#setup-browsers">Browsers</a><a href="/admin#hosts" hx-boost="false">Hosts</a><a href="#setup-password">Owner security</a></nav>`
  return html`${jumpNav}<section class="panel" id="setup-services"><h2 title="A service is an upstream API speaker proxies: it adds the credential to each call, so the agent never holds it.">Services <small>rules are ask unless shown</small></h2>${chosen ? html`<article><h3>Edit service: ${selected}</h3>${serviceForm}${chosen.mcp ? tools(selected ?? '') : ''}</article>` : ''}${serviceRows.length ? html`<div>${serviceRows}</div>` : empty('No services configured. Add a service to let agents request access to an upstream API.')}${chosen ? '' : prefix ? html`<article><h3>Add a scope to ${scope}</h3>${serviceForm}</article>` : html`<details><summary>Add service</summary>${serviceForm}</details>`}</section><section class="panel" id="setup-secrets"><h2 title="A secret is a value speaker inserts into an agent's requests, only to the hosts you allow; the agent sees just a variable holding a placeholder.">Secrets</h2>${secretErrors[error ?? ''] ? html`<p class="warn" role="alert">${secretErrors[error ?? '']}</p>` : ''}${secretRows.length ? table(['Name', 'Allowed destinations', 'Agent variable', 'Actions'], secretRows) : empty('No secrets yet.')}<details><summary>Add a secret</summary>${secretForm()}</details></section><section class="panel" id="groups"><h2 title="A group is what an agent may ask for; a bottle template names the group to request at launch. Changes apply to new requests; requests already pending keep their items.">Groups</h2>${groupErrors[error ?? ''] ? html`<p class="warn" role="alert">${groupErrors[error ?? '']}</p>` : ''}${groupRows.length ? table(['Group', 'Purpose', 'Members', 'Actions'], groupRows) : empty('No groups. A group collects items so an agent can request them with one approval.')}<details><summary>Add group</summary>${groupForm('', { items: [] })}</details><p><small>Deleting a group does not end existing grants.</small></p></section><section class="panel" id="setup-ssh"><h2>SSH targets and shares</h2>${sshPanel}</section><section class="panel" id="setup-browsers"><h2 title="A browser site is a headless Chromium session you open and sign in to by hand; agents with a grant drive it with commands and never see its cookies.">Browser sites</h2>${browserPanel}</section><section class="panel" id="setup-password"><h2>Owner security</h2><p class="actions"><button type="button" class="secondary" data-push-toggle>Enable push on this device</button><button type="button" class="secondary" data-push-test hidden>Send test push</button><small id="push-status"></small></p><details><summary>Change owner password</summary><form method="post" action="/admin/password">${password('current', 'Current password', 'current-password')}${password('password', 'New password', 'new-password')}${password('confirm', 'Repeat the new password', 'new-password')}<button>Change password</button></form></details></section>`
}
const s = (value: unknown) => String(value ?? '')
const arr = (v: unknown) => (Array.isArray(v) ? v.map(s) : [])
const itemKind = (item: string) =>
  /^(site|ext|secret|folder|ssh|mcp|browser):/.exec(item)?.[1] ?? (/\.(read|full)$/.test(item) ? 'service' : '')
const tokens: Record<string, string> = {
  request_created: 'request',
  grant_created: 'grant +',
  grant_revoked: 'grant −',
}
// What an event did, on one line: the call (service, method, path) or the event with its item or target, plus the
// kind icon's name when the event concerns an item of a known kind.
const what = (e: LogEntry) => {
  const items = [e.item, ...arr(e.items), ...arr(e.granted)].filter(Boolean).map(s)
  const kind =
    e.event === 'proxy'
      ? e.mcp
        ? 'mcp'
        : 'service'
      : e.event === 'ssh_file'
        ? 'folder'
        : e.event.startsWith('ssh')
          ? 'ssh'
          : itemKind(items[0] ?? '')
  const same = new Set(items.map(itemKind)).size === 1
  const text =
    e.event === 'proxy'
      ? `${s(e.service)}${e.mcp ? ` · ${s(e.mcp)}` : ''} ${s(e.method)} ${s(e.path)}`
      : [
          tokens[e.event] ?? e.event.replaceAll('_', ' '),
          e.share ?? e.target,
          e.op,
          e.path,
          e.command ?? (e.event === 'ssh_session' ? 'sftp' : ''),
          ...items.map((i) => (same ? i.replace(/^(site|ext|secret|folder|ssh|mcp|browser):/, '') : i)),
          e.why,
          e.reason,
        ]
          .filter(Boolean)
          .map(s)
          .join(' ')
  return { kind, text }
}
// Only what is informative: an HTTP status with its latency, or what went wrong or is still open.
const result = (e: LogEntry): Html | string => {
  if (e.event === 'proxy')
    return html`<span class="${Number(e.status) >= 400 ? 'warn' : 'ok'}">${s(e.status)}</span> <small>${s(e.latencyMs)}ms</small>`
  if (e.event === 'upstream_failed') return html`<mark title="Upstream unreachable">unreachable</mark>`
  if (e.event === 'request_unavailable' || e.event.endsWith('_refused')) return html`<span class="warn">denied</span>`
  if (e.event.endsWith('_failed')) return html`<span class="warn">failed</span>`
  if (e.event === 'grant_expired') return 'expired'
  return e.event === 'request_created' ? html`<small>waiting</small>` : ''
}
export function log(
  entries: LogEntry[],
  total: number,
  query: Record<string, string | undefined>,
  choices: Record<string, [string, string][]>,
  machines: Record<string, string | undefined>,
) {
  const names = Object.fromEntries(Object.entries(choices).map(([n, o]) => [n, new Map(o)]))
  // An id that is no longer current stays selected and shown, so the filter is not silently dropped.
  const choose = (name: string, options: [string, string][]) => {
    const v = query[name]
    const all = v && !names[name].has(v) ? [...options, [v, `${v} (not current)`]] : options
    return html`<label>${name[0].toUpperCase() + name.slice(1)}<select name="${name}"><option value="">Any</option>${all.map(([value, text]) => html`<option value="${value}" ${raw(v === value ? 'selected' : '')}>${text}</option>`)}</select></label>`
  }
  const on = ['q', ...Object.keys(choices)].filter((n) => query[n])
  const grouped = query.group === 'agent'
  // Every link keeps the current filters; only the dropped one and the grouping change.
  const href = (drop = '', group = grouped) =>
    `/admin/log?${new URLSearchParams([...on.filter((o) => o !== drop).map((o) => [o, query[o] ?? '']), ...(group ? [['group', 'agent']] : [])])}`
  // One line per event: time, agent (unless grouped), what, result; the raw record opens from the row itself.
  const line = (e: LogEntry, i: number, list: LogEntry[]) => {
    const { kind, text } = what(e)
    const repeat = i > 0 && list[i - 1].time.slice(0, 16) === e.time.slice(0, 16)
    return html`<details class="ev ${grouped ? 'g' : ''}"><summary>${local(Date.parse(e.time), undefined, grouped ? 'time' : '', repeat)}${grouped ? '' : html`<span class="clip ag">${s(e.label)}</span>`}<span class="clip w" title="${text}">${kind ? ico(kind) : ''}<code>${text}</code></span><span class="clip">${result(e)}</span></summary><dl class="kv">${Object.entries(e).map(([k, v]) => html`<dt>${k}</dt><dd>${typeof v === 'string' ? v : JSON.stringify(v)}</dd>`)}</dl></details>`
  }
  const byAgent = new Map<string, LogEntry[]>()
  for (const e of entries) byAgent.set(e.agent ?? '', [...(byAgent.get(e.agent ?? '') ?? []), e])
  // Newest-active agent first (entries are newest first); events without an agent come last.
  const groups = [...byAgent].sort(([x], [y]) => Number(x === '') - Number(y === ''))
  const body = grouped
    ? groups.map(
        ([id, list]) =>
          html`<div class="gh"><strong>${id ? (names.agent.get(id) ?? list[0].label ?? id) : 'Owner and host events'}</strong>${id && machines[id] ? html`<small>${machines[id]}</small>` : ''}<small>${plural(list.length, 'event', 'events')}</small><small class="r">latest ${local(Date.parse(list[0].time), undefined, '')}</small></div>${list.map(line)}`,
      )
    : entries.map(line)
  return html`<section class="panel"><h2>Activity <small class="count">${total > entries.length ? `${entries.length} of ${total}` : total}</small></h2><form method="get" action="/admin/log" class="log-filter"><label><input type="search" name="q" value="${query.q ?? ''}" placeholder="Search" aria-label="Search"></label>${grouped ? hidden('group', 'agent') : ''}<button>Apply</button><nav class="seg" aria-label="Order"><a href="${href('', false)}" ${raw(grouped ? '' : 'aria-current="true"')}>By time</a><a href="${href('', true)}" ${raw(grouped ? 'aria-current="true"' : '')}>By agent</a></nav><details><summary>Filters${on.length - (query.q ? 1 : 0) ? ` (${on.length - (query.q ? 1 : 0)} active)` : ''}</summary><div class="filters">${Object.entries(choices).map(([name, options]) => choose(name, options))}</div></details></form>${on.length ? html`<p class="on">${on.map((n) => html`<a href="${href(n)}" aria-label="Remove ${n} filter">${n === 'q' ? 'Search' : n[0].toUpperCase() + n.slice(1)}: ${n === 'q' ? query.q : (names[n].get(query[n] ?? '') ?? query[n])} ×</a>`)}<a class="action-btn" href="/admin/log${grouped ? '?group=agent' : ''}">Clear filters</a></p>` : ''}${
    entries.length
      ? html`<div class="log">${body}</div>`
      : on.length
        ? empty('No events match these filters.')
        : empty('No events yet. Calls and decisions appear here as they happen.')
  }</section>`
}

// The live view of one open browser site: frames drawn on a canvas, the owner's mouse and keys sent back (browser.ts relays
// only input events). No htmx here, so leaving the page closes the stream.
const viewScript = `const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), status = document.querySelector('#status')
const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + location.pathname + '/ws')
ws.binaryType = 'blob'
ws.onmessage = async (e) => { ctx.drawImage(await createImageBitmap(e.data), 0, 0, canvas.width, canvas.height); status.textContent = 'Live' }
ws.onclose = () => { status.textContent = 'Closed: reopen it from Setup' }
const send = (message) => ws.readyState === 1 && ws.send(JSON.stringify(message))
const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * 1280 / r.width), y: Math.round((e.clientY - r.top) * 720 / r.height) } }
const mouse = (eventType, e, more = {}) => send({ type: 'input_mouse', eventType, ...at(e), button: 'left', clickCount: 1, ...more })
canvas.onmousedown = (e) => { canvas.focus(); mouse('mousePressed', e) }
canvas.onmouseup = (e) => mouse('mouseReleased', e)
canvas.onmousemove = (e) => mouse('mouseMoved', e, { button: 'none', clickCount: 0 })
canvas.onwheel = (e) => { e.preventDefault(); mouse('mouseWheel', e, { button: 'none', clickCount: 0, deltaX: e.deltaX, deltaY: e.deltaY }) }
const codes = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }
const char = (text) => send({ type: 'input_keyboard', eventType: 'char', text })
canvas.onkeydown = (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  e.preventDefault()
  if (codes[e.key]) for (const eventType of ['keyDown', 'keyUp'])
    send({ type: 'input_keyboard', eventType, key: e.key, code: e.code, windowsVirtualKeyCode: codes[e.key], ...(e.key === 'Enter' && eventType === 'keyDown' ? { text: '\\r' } : {}) })
  else if (e.key.length === 1) char(e.key)
}
// A pasted password (from a password manager) is typed in, one character at a time.
document.onpaste = (e) => { for (const c of e.clipboardData.getData('text')) char(c) }`
export const browserPage = (nonce: string | undefined, site: string, until: number) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${site} · Speaker for the creds</title><link rel="stylesheet" href="/admin/assets/pico.css"><style>${raw(css)}canvas{display:block;width:100%;aspect-ratio:16/9;border:1px solid var(--line);border-radius:.45rem;background:var(--surface-2)}</style></head><body><main><h2>${site} <small id="status">Connecting</small></h2><p>Click into the page and sign in; paste works for passwords. Agents holding <code>browser:${site}</code> use this session until it closes ${local(until, 'Closes ')}. <a href="/admin?section=services#setup-browsers">Back to Setup</a></p><canvas width="1280" height="720" tabindex="0" aria-label="Live view of ${site}"></canvas><script nonce="${nonce ?? ''}">${raw(viewScript)}</script></main></body></html>`
