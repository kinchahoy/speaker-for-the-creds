# UI improvement proposal

<sub>AI-written · 2026-11-15 · Proposal only; no implementation authorized by this document.</sub>

## Product intent

The owner needs command and control over several agents: usually one or two, commonly four or five, occasionally eight to ten. The everyday questions are: **What is running? What is it doing? Does it need a decision? How can the owner join it? What access does it retain?**

Routine bundles should take one deliberate approval. Dissecting individual capabilities is an exception, often a sign that the launching workflow or agent behavior needs improvement. Making that exception possible remains essential; making it the default reading experience is unnecessary.

Herdr and the phone browser are primary operating surfaces. Herdr should handle as much routine supervision as practical. The web remains the complete frontend and the appropriate place for new configuration. Joining or continuing an existing agent matters more than starting another. Recent activity is useful supporting evidence, below current work and current permissions.

This is a hierarchy and interaction cleanup, with narrowly identified integration work. Learning, automatic policy decisions, native phone applications, and notification infrastructure are follow-ons.

## Evidence and limits

Reviewed:

- Repository `README.md`, `speaker/README.md`, `bottle/README.md`, and `speaker/USECASES.md` for product intent and supported flows. Some use-case descriptions are aspirational; implementation takes precedence below.
- `speaker/ui.ts` and `speaker/admin.ts`: web layout, polling, requests, live access, configuration, log, and owner API.
- `bottle/src/cli.ts`, `bottle/src/server.ts`, and relevant parts of `bottle/src/agents.ts`: launch, list, attach/resume, close/archive, status fields, and control boundary.
- `herdr/mods/speaker/main.js`, its `mod.json`, and the Herdr app mod documentation at `~/.config/herdr-app/AGENTS.md`.
- All four supplied Desktop screenshots: `Screenshot 2026-11-15 at 6.26.43 PM.png` (Herdr), `7.01.58 PM.png` (Active), `7.02.06 PM.png` (Setup), and `7.02.15 PM.png` (Log).
- Supporting guidance in `../mostly-impeccable/design-craft-lite-refs/{critique,type-color-layout,harden}.md`, especially grouping by task, progressive disclosure, evidence-backed critique, and resilient states.

The Herdr captured-context error in the first screenshot is fixed and is **not** an outstanding finding. Screenshots establish visual evidence, not current runtime correctness. No live application, contrast measurement, accessibility audit, or iOS capability verification was performed for this proposal. Screenshot pixel sizes should not be treated as CSS sizes.

## Critique: the main structural problems

1. **The default destination is organized around an intermittent event.** `/admin` opens Inbox even though it is usually empty. Active is a separate destination, requiring navigation to understand what an agent already has while deciding what more it wants. Request and access are two states of the same agent relationship.
2. **Access state stands in for agent state.** The Active screenshot explains grants thoroughly but gives little sense of current work. Enrollment, a live grant, a busy process, and a reachable sandbox host are different facts. A direct agent with a grant cannot honestly be called “working” on that evidence alone.
3. **Routine information has too little hierarchy.** Active places name, model/harness, uses, last-used date, and a five-part tally into the header. Full dates, URLs, zero counts, icons, and separate destructive buttons dominate the scan. The important reading path—agent, task, state, decision or join—is missing.
4. **Herdr accumulates separate lists instead of assembling agent context.** Pending requests, bottle agents, recently finished agents, launch controls, active grants, and settings share one long dialog. Grants appear below launch controls rather than next to their agent. Repeated `sealed` names and full model paths make runs difficult to distinguish. A template-by-model button matrix both truncates template explanations and launches on what looks like model selection.
5. **Supporting screens consume too much attention.** Setup gives Delete nearly the same visual presence as Edit, and credential badges repeat on every service. Log devotes its first substantial area to six filters and repeats long identities and full dates in every row. These screens retain useful functionality, but their presentation should follow the owner's questions.

Keep the strengths: per-item decisions, explicit durations, visible reasons and warnings, write-only credentials, grant enforcement states, scoped log links, server-rendered forms, phone support, existing terminal integration, and the CLI. No visual simplification should remove their underlying controls or information.

## Proposed information architecture

### One operational destination: Agents

Replace the separate top-level Inbox and Active destinations with **Agents**, followed by **Activity** and **Setup**. Keep old URLs and request/grant/agent anchors working through aliases or redirects that preserve their target. Configuration and history remain available; this proposal changes their placement, not their capabilities.

Agents has this reading order:

1. Compact status line: `4 agents · 2 requests need approval`, plus an honest refresh/connection state.
2. **Needs attention**, only when present: pending agent requests, new host registration requests, and actionable runtime/enforcement failures. Visually distinguish approval requests from faults; a fault never receives an approval button.
3. **Current agents**, ordered consistently, with work summary, runtime status where known, a Join action where supported, and a concise access summary.
4. **No current access**, collapsed by default when populated: enrolled agents without live grants, launch-held capabilities, or open sessions. Do not label them stopped merely because access expired.
5. A compact **Hosts** disclosure with connection/enforcement health and a route to host management. Healthy hosts are supporting infrastructure; pending host trust decisions remain prominent above.

When nothing needs attention, omit that region entirely or show one quiet inline `No decisions waiting`. Current agents become the page's first substantive content. Do not retain a large empty Inbox panel.

### Agent identity is the parent

Within an agent, show pending requests, current grants, launch-held capabilities, and sessions as related sections. Pending requests can be surfaced in Needs attention without repeating the entire agent card: use a concise agent header and link to the same stable agent identity. Prefer one expanded decision location, with a pending count/link in its current-agent row, over duplicated approval forms.

Illustrative structure, not fabricated live data:

```text
Agents                              4 current · 1 needs approval

Needs attention
  Notes research · bottle / laptop
  Wants: research bundle · 6 capabilities · requested for 1h
  Reason: Find sources for the comparison
  [Review capabilities]                [Approve for 1h] [Deny]

Current agents
  Notes research     Waiting for approval             [Join]
  Latest message: Found two sources; needs search access
  Access: 3 grants · next expiry in 42m                 [Details]

  Home audit         Working                          [Join]
  Latest message: Checking device configuration
  Access: 2 grants · next expiry in 18m                 [Details]

No current access (2) ▸     Hosts (1) ▸
```

## Shared structuring rule for every surface

Apply this approach across the entire UI, including configuration, activity, host management, launching, history, and CLI output—not only requests or agent cards. The goal is to preserve useful information while making comparable facts easy to scan. Do not interpret compactness as permission to hide current access or consequential state.

- Give each repeated field a consistent position. On wide surfaces use aligned columns; on narrow surfaces use the same labeled fields in a predictable stacked order. Avoid concatenating identity, addresses, timestamps, counters, and actions into a long dot-separated sentence.
- Identify the object, its location/target, scope or policy, current state, and available action separately. Group child rows under their actual parent without repeating the entire parent identity on every row.
- Show enough endpoint, machine, account, and path information to distinguish targets. Prefer concise labels such as `R` / `R/W` when accurate, retaining accessible full meanings. Do not shorten different targets into identical labels or turn every capability into a read/write classification.
- Keep operational facts visible: current endpoints and access, pending scope, enforcement uncertainty, significant warnings, failures, and affected action scope. Use disclosure for exact IDs, redundant representations, full timestamps, detailed explanations, and less frequently needed diagnostics—not as a substitute for organizing the main view.
- Separate narrative text from comparable fields. Give task summaries, reasons, notes, and errors a dedicated line or region; allow expansion for long text without letting it push every other field out of alignment. Critical warning/scope text must remain readable before the action.
- Keep actions next to the object they affect. Agent controls belong with agent identity; grant controls with the endpoint; configuration actions with the resource; filter controls with the filtered collection. Use quieter secondary actions without making them undiscoverable.

Use these field structures as the starting point, adapting to actual data and width:

| Surface | Default visible structure | Supporting detail |
| --- | --- | --- |
| Current agents/access | Agent/task, machine, endpoint, access, expiry/enforcement, scoped actions; status/message beneath agent | Exact IDs, full model ID, full timestamps, complete tallies |
| Pending decisions | Agent/task and machine; bundle/target, requested scope, duration, warnings, decision actions; reason on its own line | Expanded membership/selection, trigger and diagnostic identity |
| Services | Name, distinguishable endpoint, read policy, write policy, credential requirement/state, Edit | Auth configuration, notes, tool classification, secondary actions |
| Secrets | Name, allowed destination hosts, exposed variable name, configured/missing state, Edit | Host-list expansion and change consequences; never reveal saved values |
| Groups | Name, description, member count and recognizable scope summary, Edit | Exact membership and editing controls; review reveals all members |
| SSH targets/shares | Machine/target, account or share path, access/delivery mode, trust/warnings, actions; shares nested beneath target | Full fingerprints, setup instructions, diagnostics |
| Hosts | Host/machine, supported kinds, trust state, connection/enforcement health, actions | Source address, registration timestamp, detailed consequences |
| Activity | Time, agent/task, machine when known, operation/endpoint, result; event detail separated | Exact timestamp, full command/path, identity, latency, grant provenance |
| Launch | Separate labeled template, model, task/prompt, machine, execution mode, folders/access preview; explicit Start | Full model IDs, advanced options, longer template explanations |
| Recently finished | Task label, machine, outcome, finished time, Open archive | Archive path, model, error details; failures remain visible |
| Connection/settings | Component, address, machine, connection/auth state, relevant action | Technical diagnostics; credentials remain protected |
| CLI lists | The same identity/target/state fields in aligned columns with labeled continuation lines at narrow widths | Exact IDs and command-ready values remain available |

These are presentation structures, not instructions to fabricate unavailable fields or add unrelated APIs. Mark unknown/unavailable facts honestly. Where additional transport is necessary, use the explicitly scoped integration work below. Consistent semantics matter more than forcing every surface into an identical number of columns.

## Specific proposed changes

### 1. Merge web Inbox and Active — priority 1

- Implement the Agents destination using the same authoritative speaker view for pending and current access. Derive counts from that view rather than separately timed panel snapshots.
- Preserve `request-*`, `agent-*`, `grant-*`, and host registration deep links. A link to collapsed content must open and reveal it below the sticky header.
- Keep ordering stable during review. Place newly relevant attention items prominently without jumping the focused card or moving an approval button under the pointer. On initial load use oldest pending first; runtime faults have their own labeled group.
- Use a simple list of agent sections rather than a grid of equally weighted dashboard tiles. Ten agents should remain scannable without ten fully expanded grant lists.
- Retain search and capability filters in a compact disclosure/tool row. Filtering must show a visible filtered state and clear action; distinguish “no matches” from “no agents.” A global attention count must not disappear just because a filter hides a request.

**Acceptance:** with zero pending requests and four current agents, the owner immediately sees those agents. With a pending request for an existing agent, its current access is available in place, without a tab change. Existing bookmarked request links still reach the intended decision.

### 2. Make agent rows communicate work first — priority 1

- Primary line: useful run label, explicit status, Join when available. Secondary line: latest message or supplied task summary, with a clear source label. Keep that line visible; do not truncate it to zero width behind model metadata.
- On desktop, align Agent, Machine, Endpoint, Access, Expires, and Actions as parallel columns. Group multiple endpoint rows under one agent identity and machine; put status/latest message beneath the agent label and Join beside the agent. Keep permission actions beside their endpoint. On phone and narrow Herdr panels, stack the same information into labeled rows.
- Keep current endpoints and access visible in the overview rather than hiding the permission list behind a grant count. Show enough hostname and meaningful base path to distinguish the actual target; omit redundant protocol/identifiers when they add no identifying information. Use `R` and `R/W` with accessible expanded labels where those accurately describe scope; retain appropriate scope labels for SSH and other capabilities. Put exact capability IDs and full timestamps in Details. Prioritize structure and removal of repetition over smaller text or hiding useful information.
- Supporting information: model alias, harness, age, and usage. Full provider/model ID, source address, key identity, exact timestamps, and complete counts belong in Details. Machine remains a visible identity field, with an explicit unknown state when unavailable.
- Show nonzero refusal/block counts as an exception indicator linked to explanation. Preserve all tallies in Details; stop spending default row space on `0 denied · 0 refused · 0 blocked`.
- Distinguish lifecycle (`Starting`, `Closing`, `Archive failed`), runtime (`Working`, `Idle`, `Pi exited` when known), and attention (`Waiting for approval`). An idle agent can still need a decision; do not flatten independent facts into misleading success/failure labels.
- For direct agents without runtime telemetry, say `Runtime status unavailable` or summarize `Access live · last used 3m ago`. Never infer active work from a grant or HTTP use alone.
- Have the agent propose a short task label, ideally two to six words describing the work, such as `Compare inference costs` or `Fix checkout tests`, instead of relying on a template or model name. Investigate whether an existing Pi extension/plugin or session-title mechanism already provides this before implementing a custom hook; support is not verified by this review. Prefer the existing agent/session mechanism over a separate model call or naming service.
- Keep the task label separate from stable run IDs, template, model, and machine identity. Preserve an explicit owner-supplied name; use the proposed label as the default display label when no owner name exists. Until a label arrives, fall back to the existing name plus a short ID. Labels are untrusted display text, never authorization or correlation keys. Keep them stable during normal progress; allow deliberate updates when the task changes without reshuffling the list on every message.
- When names collide, append a short stable ID and machine rather than merging runs. Show the same task label across Herdr, speaker, and bottle CLI, while retaining the original identity in Details. Any required metadata transport should reuse the existing status/session path where practical.
- Join reuses the existing Herdr terminal or existing bottle attach/resume behavior. It must not launch a replacement agent. Archived sessions are not resumable merely because their archive exists.

**Acceptance:** two identically named runs are distinguishable; the owner can identify what each is doing and join the right live run. A proposed task label appears consistently across surfaces without changing the run ID or overriding an owner name. Endpoints remain distinguishable in the overview. Unknown runtime status never appears as Working.

### 3. Optimize approval for familiar bundles — priority 1

- Default card: agent identity, requested bundle name(s), capability count, short scope summary, reason, duration, important warnings, Approve, Deny, and Review capabilities.
- Example action copy: `Approve for 1h`. Duration remains visible and editable, with the existing requested/default duration and supported values. The cleanup must not silently change duration defaults or introduce permanent access.
- Review capabilities reveals the full exact item list and existing per-item selection. Preserve group selection, dependencies, bundled lifetimes, and trigger details. After a selection change, the action must state that approval is for selected capabilities.
- Always expose server-reported risk/warning content, including destructive tools, SSH account/sudo concerns, read-write scope, and indefinite duration. A collapsed list must not hide the facts that alter an approval decision. For individual requests with no named bundle, show a concrete scope summary, not an invented familiar-bundle label.
- Keep self-reported model/harness identity visibly distinguishable from speaker-known host/source identity. Cosmetic simplification must not imply identity verification.
- No cross-agent “Approve all,” learned trust badge, automatic approval, or skipped approval in this pass. Fast approval means fewer reading/navigation steps for the same explicit decision.
- Disable duplicate submissions per request, preserve form choices across polling, and show the server result. If another surface already decided it, refresh its outcome rather than claiming the current click granted access.

**Acceptance:** a routine bundle takes one approval from its visible card. An unusual capability or warning remains noticeable before that click. The owner can still approve only a subset through the detailed flow.

### 4. Put access under its agent — priority 1

- Keep a compact visible endpoint/access list beneath each agent, with expiry and enforcement exceptions aligned alongside it. An optional collapsed summary can supplement that list or support an owner-selected compact view; it must not be the default replacement for current permissions. Count launch-held capabilities separately: they are not speaker grants.
- Expanded list: plain scope description first, exact identifier alongside it, remaining time, enforcement state, scoped activity link, Extend and Revoke. Full upstream URLs and exact expiry times remain available in details.
- Prefer `Expires in 55m` to a full date plus meter plus repeated duration. A meter may supplement the label but is not necessary. Say `Extend by 30m` when the action adds 30 minutes; use the actual server behavior.
- Keep `Approved, applying` and `Host unavailable; enforcement unconfirmed` distinct from in-force access. Approval is not evidence the sandbox applied a grant.
- Separate launch-held extensions and open SSH sessions with their actual controls and lifetime semantics. Do not place a per-item revoke button on launch-held extensions when none exists.
- Keep Revoke available alongside each visible permission row. Place whole-agent revocation in a clearly labeled secondary action/disclosure with confirmation naming its scope. Preserve session-end controls. Herdr Stop and speaker Revoke agent must remain distinct: stopping archives a bottle run; revoking invalidates access/identity according to speaker's existing behavior.
- Preserve the documented streaming caveat near access controls: revocation blocks new calls; an existing streaming response may finish. Avoid stronger instant-stop promises than the backend makes.

**Acceptance:** access can be inspected and revoked without searching a second global list; launch-held items, timed grants, open sessions, and unconfirmed enforcement remain distinguishable.

### 5. Recompose Herdr around the same hierarchy — priority 1

- Keep the docked bar compact: `Speaker · 1 approval · 4 bottle agents`, with sign-in, unreachable, and stale states taking precedence over a reassuring zero. Label the agent count by its actual coverage until direct-agent inventory is available.
- Dialog order: compact heading/status and New agent action; Needs attention; current agents with compact visible endpoint/access rows and disclosures for supporting details; collapsed recently finished; connection/settings disclosure. Remove the always-open settings form from the normal supervision path.
- Join is the principal action on live bottle rows. Keep Stop in the row's secondary actions with clear close/archive wording and a guard against accidental activation. Do not make destructive Stop the only visibly labeled row action.
- Associate grants and requests using stable IDs, not matching labels. Direct agents with grants must remain represented even though they do not have bottle rows or Join actions.
- Keep duration choice, Approve as asked, Deny, and individual grant revocation native. Add grant extension and whole-agent revocation through narrowly scoped owner API routes using the existing authorization model. For rare per-item dissection, a browser deep link is an acceptable first increment; native subset selection can follow if small enough.
- Keep the browser escape hatch available at the header and specific request/access context. Do not require scrolling past launch controls and settings to reach it.
- Keep Herdr a focused operations companion. Do not recreate the web service/secret/SSH configuration editors inside it in this cleanup.
- Recently finished defaults to a compact count/disclosure. Distinguish Archived from Archive failed; make archive failure visible as attention even when history is collapsed. Clicking an archived run opens its output, with an explicit `Open archive` affordance and correct machine context. It does not promise Resume.

**Acceptance:** the owner can approve, deny, inspect access, extend/revoke access, join, and stop a bottle run from Herdr without traversing unrelated sections. Joining and archive browsing respect remote-machine context. New configuration can remain web-only.

### 6. Replace Herdr's launch matrix with a deliberate launch flow — priority 2

- New agent opens a small form/disclosure; it is not permanently inserted between running agents and their grants.
- Choose template, choose model, enter optional prompt/name, review folders, then press an explicit `Start agent`. Choosing a model must not launch immediately. Keep every currently available template and model reachable.
- Show the selected template's meaningful description and launch-held capabilities. Preserve template defaults; do not infer that familiar means unrestricted or rewrite the security model.
- Use model aliases in the chooser; expose full IDs and availability in supporting text. Explain unavailable models without relying on disabled color alone.
- Keep folder syntax supported initially, with an explicit example showing read-only and `:rw`. Disclose the existing default `~/agent-space` read-write mount as well as extra mounts; Extra folders is not the complete filesystem scope.
- Show attended/unattended semantics consistent with `bottle run -d` and the existing flags. Starting through Herdr currently invokes detached execution; selecting a layout must not silently change execution policy.
- Preserve form values until launch handoff succeeds; show `Starting…` and a route to the launch terminal. Distinguish accepted launch command from an agent actually running or waiting for approval.

**Acceptance:** model exploration cannot accidentally start a VM. Starting another agent takes an explicit final action and clearly shows template, model, execution mode, and folder scope.

### 7. Make phone supervision complete without unsafe bottle access — priority 1 design, staged implementation

- Use the same Agents hierarchy in one column. Put pending decisions before current agents and retain compact labeled endpoint/access rows, with disclosures for supporting details. Join actions only appear where a supported destination exists; do not show a dead desktop terminal button on a phone.
- A phone should show real bottle status and latest messages when available, not just a renamed Active page. This requires an integration addition: speaker does not currently receive bottle's full runtime/status summaries in its web view.
- Preferred route: narrowly defined runtime metadata reported over the existing authenticated bottle-host connection, joined to speaker's own agent IDs. Expose an allowlisted owner view of that data. Define freshness and bounded message length. Treat messages as untrusted text, not executable HTML or trusted instructions.
- Do not have the phone directly fetch bottle's control API, broaden its bind address, remove its Host/Origin checks, or weaken speaker's same-origin policy. The existing speaker CSP also limits browser connections to self. A UI request does not authorize changing those boundaries.
- If this integration is deferred, ship accurate permissions/decisions first with `Runtime status unavailable`; do not claim full work supervision on phone until telemetry exists.
- Preserve read position during refresh, 44px touch targets, 16px input text, keyboard/zoom behavior, and duration/selection state. Avoid a sticky approval button detached from the identity and request it will approve.

**Acceptance:** phone decisions work without direct exposure of bottle control. Offline/stale data is labeled; unknown status never masquerades as current work.

### 8. Simplify Setup around resources and policy — priority 2

- Keep the Setup destination, but provide a compact section chooser so a phone can go straight to Services, Secrets, SSH targets/shares, Groups, Hosts, or owner security without scrolling the full catalogue. Retain addressable sections and all existing forms.
- Services and Secrets are different mechanisms; keep them distinct, with one sentence explaining proxy-service credentials versus host-bound injected secrets. Do not merge them into an ambiguous Credentials list.
- Group shares under their SSH target and group bundle membership under Groups. Explain that groups define requestable access while bottle templates also define runtime configuration; they are not interchangeable.
- Service rows: name and endpoint on separate lines, compact read/write policy, exceptional missing-credential state, Edit as the obvious action. Put Log and Delete in secondary controls; keep deletion confirmations and consequences intact.
- Treat `No credential required` as neutral information, not a green success badge. Do not call missing sample credentials a live outage without evidence that a usable service is affected. Do not delete example entries as part of cleanup.
- Preserve blank-keeps-current credential behavior, allowed-host constraints, MCP tool classification/refresh, SSH account/host-key/sudo information, and the existing change consequences. When an edit ends grants, state that beside Save.
- In host management, show identity, supported kinds, trust/connection state, and removal consequences. This is a secondary home for healthy hosts, not a reason to hide new host approval requests.

### 9. Make Activity answer a scoped question — priority 2

- Rename Log to Activity in navigation, while keeping existing `/admin/log` links functional. Preserve the audit records and their detailed contents.
- Default toolbar: Search plus Filters disclosure. Keep all five current entity filters available; display active filters and Clear without requiring the disclosure to be reopened.
- Compact rows: time-of-day for today, short agent label plus disambiguating ID when needed, operation/target, and result. Keep exact timestamps, full identity, path/command, duration, and grant provenance in an expandable event detail.
- Separate upstream HTTP errors, access denied, request refused before approval, grant decisions, and enforcement faults with explicit text. A 404 is not automatically a security denial.
- Scoped links from agents, grants, and services should land with context visible. Preserve historical references even when an agent or grant is no longer current; the present filter choices come from current state and may not describe older records.
- Preserve the current newest-first behavior and 500-entry display limit transparently. Pagination and a richer incident timeline are optional later work; do not silently truncate or aggregate away audit evidence.

### 10. Align bottle CLI with the operating model — priority 2

- Keep a plain CLI; no new TUI. Reuse the existing command library and output helpers.
- `bottle ls`: lead with ID/name, state/attention, and latest message. Put model/mode/age on a secondary line at narrow widths rather than letting full model IDs expand the entire table. Preserve all fields through wrapping/disclosure options if introduced; do not drop information silently.
- Keep pending request scope/reason and approval URL adjacent to the affected agent. Include the existing request anchor so the owner reaches the correct decision rather than an empty or unrelated home view.
- `run`: distinguish starting, waiting for approval, attached, detached, and finished. Print one short next-action block with the agent ID, attach command, and approval link when relevant. Keep the archive location available without repeating it across every lifecycle message.
- `attach`: explain when it reconnects versus restarts Pi on the same live session. Do not advertise archived session continuation. `stop`: say Closing/archiving until completion is known; never report archive success on an accepted close request alone.
- Label launch-held extensions consistently with Herdr and web. Keep finished rows compact but give Archive failed a clear next step to inspect the existing error/output; do not invent a recovery command.

### 11. Establish quieter visual and interaction rules — priority 2

- Keep the existing general identity and light/dark support. Reduce the header's visual dominance and use restrained borders/spacing to group agent content. A rebrand or new component framework is unnecessary.
- Four text roles suffice: page/section title, agent/resource name, body/scope, metadata. Reserve bold for identity, decisions, and meaningful exceptions. Use monospace for exact identifiers and commands, not every URL or description.
- Primary emphasis belongs to the current approval or Join/Start context; routine Delete/Remove/Revoke controls should not form a repeated red column in the overview. Dangerous scope remains explicit when those controls are opened.
- Keep desktop lists reasonably dense while retaining generous decision controls on phones. Target four or five collapsed agent summaries in a typical desktop panel when practical; validate at the actual Herdr dialog size rather than forcing a fixed row height.
- Use color plus text for status, enforce visible focus, preserve keyboard order, and announce decision outcomes without reading every polling update. Check actual light/dark contrast rather than judging screenshots alone.
- Independent failures need independent messages: speaker sign-in expired, speaker unreachable, bottle unreachable, model unavailable, archive failed. `Nothing waiting` is only valid after a successful authenticated request. Keep last-known data with its timestamp rather than clearing it into a false empty state.

## Implementation boundaries and handoff

The following is proposed work for a subsequent agent, not a claim that the existing APIs already support it.

| Area | Existing base | Proposed minimum addition |
| --- | --- | --- |
| Web Agents hierarchy | `speaker/ui.ts` inbox/active/layout; `speaker/admin.ts` page and panel routes | Combined operational rendering, stable anchors, preserved form/disclosure state |
| Herdr correlation | bottle state includes `speakerAgentId`; requests include subjects | Owner payloads with explicit stable agent IDs and enough agent/enforcement context; never join by label |
| Herdr access controls | Owner API currently lists grants, approves/denies whole requests, revokes grants | Narrow authenticated extension and agent-revocation routes; reuse existing core decisions, validation, audit behavior |
| Phone work status | bottle state includes `summary`, `done`, runtime state; speaker web lacks this feed | Optional bounded host-reported telemetry through the existing authenticated host channel |
| Herdr layout/launch | `herdr/mods/speaker/main.js`, `mod.json` | Reorder existing controls, agent disclosures, explicit launch form; use native Herdr theme and controls |
| CLI | `bottle/src/cli.ts` | Responsive text layout, lifecycle copy, precise approval links |

Before adding an owner endpoint, inspect the current core path and preserve its semantics, server validation, authorization, and audit trail. Do not broaden grants, token binding, credential exposure, origin handling, or share containment. Browser sessions and owner bearer tokens remain separate. Herdr's token remains in memory. Do not persist passwords/tokens to make sign-in quieter.

Keep the present lightweight Hono/htmx, Commander, and Herdr components. Do not update dependencies, remove dead code, delete files, or narrow existing features as a side effect. Moving controls into a labeled disclosure retains their functionality; removal needs a separate owner decision.

Suggested execution sequence:

1. Web Agents hierarchy, bundle-first request presentation, access disclosures, accurate state labels, and route compatibility.
2. Small owner payload/control additions, then Herdr supervision hierarchy and explicit launch form. Match identities before moving grants into rows.
3. Phone telemetry integration if included in approved scope; otherwise clearly mark the visibility limit.
4. Setup/Activity density, CLI consistency, and visual polish.

Implement each increment with its acceptance cases. Avoid a large backend redesign just to reorder the interface.

## Verification requested of the executing agent

Use representative fixtures, not real credentials or transcripts. Include zero requests; four agents and one pending bundle; ten agents; duplicate names; a direct agent without runtime telemetry; mixed live and launch-held access; open SSH sessions; indefinite grants; applying/offline enforcement; archive failure; and long names/model IDs/messages.

- Verify complete approval, subset approval, denial, extend, revoke, session end, host registration, join/rejoin, launch, and stop/archive behavior appropriate to the changed surface. Two surfaces deciding the same request must converge safely.
- Verify polling does not reset duration, checkbox selection, disclosure state, focus, scroll position, or an in-progress launch form. Refresh must not move a destructive action beneath an active pointer.
- Verify the shared field structure across every changed surface, not only approval cards. Compare before/after using real-shaped content: essential targets, scope, state, and actions must stay visible and distinguishable. Reject changes that merely shrink text, replace useful fields with counts, or hide information to achieve a cleaner screenshot.
- Verify speaker/bottle failures independently, expired sign-in, slow requests, double clicks, and recovery. Stale views must not claim fresh status or successful enforcement.
- Render web at approximately 390px phone width and desktop width, both themes and 200% zoom. Inspect the real Herdr overlay with eight to ten rows and long content. Keyboard-check primary operations and modal focus behavior.
- Run the repository's relevant checks for changed behavior. For any changed Herdr mod, follow the Herdr documentation's `herdr-app check <mod-directory>` requirement; do not claim a passing static check proves live behavior.
- Record what was actually tested. Physical phone behavior, iOS notifications, remote terminals, and live revocation are unverified unless exercised specifically.

## Broader product concerns

These concerns should inform design choices; they do not authorize additional implementation beyond the cleanup. They are product judgments from this review, not claims that each failure has been reproduced.

1. **Identity is part of command and control.** With eight agents, repeated template names become an operational risk. A stable run identity, recognizable task label, host, and relationship to its terminal should carry across speaker, bottle, and Herdr. Keep agent-supplied descriptions distinct from system-known identity. Cosmetic name matching must never decide which run receives a control action.
2. **Routine approval can turn into approval fatigue.** The useful distinction is expected access for the task versus an unexpected expansion. Showing a request's difference from the launch bundle may be more valuable than learning to approve automatically. Familiarity alone does not establish that the requested scope is appropriate.
3. **Control-plane failures need explicit semantics.** Approved, applied, usable, and revoked are different states. Define what the owner can conclude when a host is unreachable, which enforcement facts are confirmed, and how recovery reconciles state. This requires a behavioral contract as well as clear labels; avoid inferring enforcement guarantees from a successful control request.
4. **Access expiry can interrupt useful work.** A later design should identify which task is blocked by expired access and offer a scoped extension with its consequences visible. Avoid solving continuity by encouraging blanket long-lived access or automatic renewal. Distinguish an expired grant from a task that has actually stopped.
5. **Stop, revoke, disconnect, and archive need one coherent contract.** For each action, specify whether execution continues, access remains usable, outputs survive, and the session can be rejoined. Surface these consequences consistently across commands and interfaces. Do not imply that an archived run is resumable or that a disconnected terminal means an agent stopped.
6. **Task summaries are untrusted reports.** Summaries help supervision but cannot establish safety or completion. Keep agent-reported completion, observed process state, and successful archival distinguishable. Display supplied text safely and avoid presenting its instructions as owner actions or trusted system guidance.
7. **Deployment simplicity is a product feature.** More capable Herdr and phone surfaces should not multiply configuration and connectivity paths. Prefer one speaker address, clearly identified bottle hosts, and actionable connection diagnostics. Preserve multi-machine deployment without exposing bottle control or requiring a second collection of secrets on every client.

## Follow-ons, explicitly outside the cleanup

1. **Learning from routine decisions.** Suggest commonly requested bundles or identify unusual additions compared with previous approvals. Start with explainable suggestions; any automatic grant or remembered approval policy is a separate product/security decision. No fake “familiar” classification in this cleanup.
2. **Improve launch contracts.** Repeated item-by-item intervention should inform better template/group definitions and agent instructions. A later comparison could show how a request differs from the intended launch bundle without conflating template settings with grants.
3. **Herdr iOS signals and notifications: discovery first.** Determine whether the actual Herdr iOS app supports custom mod rendering, remote mod signals, deep links, badges, background delivery, and actionable notifications. This review establishes none of those capabilities. Evaluate a phone-browser/PWA route alongside Herdr integration before proposing a new native frontend.
4. **Notification policy.** Notify for a new approval or actionable fault, deduplicate by request identity, reconcile decisions across surfaces, and route to the exact request. Avoid per-capability notification storms. Credentials, agent messages, and sensitive target names need an explicit lock-screen disclosure policy before shipping.
5. **Remote continuation.** Define whether “continue on phone” means seeing a summary, opening an existing Herdr terminal, or interacting with the agent. Runtime telemetry is not a remote-control channel; each needs explicit capability and boundary design.
6. **Session history and saved work.** Better archived-session discovery, optional transcript destinations, richer activity timelines, and genuine archive resume can be evaluated separately. Preserve the distinction between reading output and restoring execution.
7. **A per-agent “What changed?” view.** Show access added, access expired, new requests, host connectivity changes, and completion reports since the owner last looked. Keep it compact and scoped to the agent, with links to exact requests and audit events. This could make supervising several agents easier without requiring a full activity dashboard or automatic policy system. Before implementation, define what counts as seen across Herdr and phone, distinguish agent reports from observed events, and ensure acknowledging a change never approves access or clears an unresolved fault.

The proposed cleanup should succeed before these features exist: current work is easy to scan, routine access takes one informed decision, existing agents are easy to rejoin, and exact permissions remain immediately inspectable.
