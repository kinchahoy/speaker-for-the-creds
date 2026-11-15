---
project: speaker-for-the-creds
topic: Agents & security
state: paused
updated: 2026-11-15T02:30
repo: ~/code/workshop/speaker-for-the-creds
tags: [workshop, status]
---

# speaker-for-the-creds status

Newest first. Frontmatter `state`/`updated` mirror the newest entry.

## 2026-11-15 02:30 · paused

**Next**
- Run `E2E.md` once against the new approval engine (owner runs `mise run init`, enters the OpenRouter key on the openrouter service; a subagent drives checks A–L while the owner approves live).
- After it passes: `mise run lock`.

**Open**
- Speaker is 4,984 non-test lines (main before the engine: 4,748); the rest of the extra is the engine itself.

**Settled**
- Speaker is one approval engine (`speaker/engine.ts`): every kind is a uniform adapter, sandbox hosts included; one lifecycle table; `reconcile()` after Setup changes; one card shape for the web inbox, `/admin/api` and Herdr. Merged from the worktree branch, which is removed.
- Host approvals are not kept across a speaker restart: known hosts come back pending. bottle treats a pending host as an outage and gives up after its limit (5 minutes, or 30 s at its own startup), naming the approval.

## 2026-11-14 19:30 · paused

**Next**
- Run `E2E.md` once: the owner runs `mise run init` and enters the OpenRouter key on the openrouter service; a subagent drives checks A–L while the owner approves live (browser and the Herdr inbox).
- After it passes: `mise run lock` to record the tested dependency set.

**Open**
- Herdr mod: the bar and the inbox dialog are meant to share one sign-in (a module-level token); unverified in a live Herdr window (E2E check K).
- Herdr names the bottle space after its first terminal's folder; rename it to "bottle" once.

**Settled**
- Plan steps 0 to 5 are built, with step 5 as read-only-plus-decide: owner API at `/admin/api` (bearer only, never the cookie) and the Herdr inbox (approve as asked, deny, revoke). The web `/admin` stays on its forms; both call the same core functions.
- ntfy is removed. Folders are SSH-only (the share delivery setting is gone); a local folder is a share on a target for this machine.
- Hosted models are speaker services (OpenRouter is a starter service): one key, entered in speaker; bottle's model door forwards as the task's agent; the speaker door refuses those services, so every model call is capped and recorded in `model-calls.jsonl`.
- A service's write rule is only ask or never; "open" is read-only.
- Sandbox-host registration cards stay browser-only (rare, and the most powerful approval).

## 2026-11-14 17:30 · paused

**Next**
- plan.md steps 0 to 4 are built and committed on `main` (tags `pre-cuts-2026-11-14`, `pre-workspace-2026-11-14`, `pre-typed-client-2026-11-14`). Non-test source is 8,752 → 8,003 lines.
- Try Herdr chunk 1 for real: run one bottle task on a host with `hc` and check it shows as a tab and closes on archive; link `herdr/mods/speaker` into the Herdr app with a `config.json` and check a new card toasts.
- One real VM task after the dependency float (microsandbox 0.7.14 → 0.7.15, undici 6 → 8); no test boots a guest.
- Step 5 (approve inside Herdr) waits until the browser hop annoys.

**Open**
- Herdr names the bottle space after its first terminal's folder; there is no label for a space name, so it needs one rename by hand.
- Settled: SSH_PORT and PROXY_PORT are now required; placeholder ports after `init --skip-register` are fine; the jump test runs agent lines with `-F /dev/null` (the test plays an agent, whose VM has no ssh config), so `mise run test` passes in full here.

## 2026-11-14 14:00 · paused

**Next**
- Herdr integration is planned in `plan.md` (approvals as a Herdr app mod over a new owner JSON API; bottle tasks as attach terminals under herdr-core). Nothing built. First step: the four spikes in its "Order of work".
- NAS deploy and the SSH certificate test below are still open.

**Open**
- The seven questions at the end of `plan.md` (blocked vs working for pending requests, who creates the tab, A0 stopgap, TUI effort, where the mod lives, bottle vs bottle-school).

## 2026-11-08 03:15 · blocked

**Next**
- Deploy on the NAS (needs SSH access, tomorrow): 9-step checklist in WORKSHOP-PLAN.md.
- One real approve-and-ssh test with a time-boxed certificate; check the `ssh_certificate_issued` audit line.

**Open**
- Should SSH certs be revocable early (key revocation list), or is a short TTL enough?
- SSH is off unless SSH_PORT is set: keep optional or require it?
- Enrollment rate limit: shared budget (current) or per address?
- List issued certificates on the admin page?
- Commit or gitignore `.vscode/`?
