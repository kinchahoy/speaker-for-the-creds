---
project: speaker-for-the-creds
topic: Agents & security
state: paused
updated: 2026-11-15T22:30
repo: ~/code/workshop/speaker-for-the-creds
tags: [workshop, status]
---

# speaker-for-the-creds status

Newest first. Frontmatter `state`/`updated` mirror the newest entry.

## 2026-11-15 22:30 · paused

**Next**
- Owner: decide whether to build the Atuin threads push (`bottle thread <id>` plus a Save to Atuin button on the Herdr inbox's finished rows); written up under Future work in the root README (`plan.md` is removed; it was all done).

**Open**
- bottle runs on macOS with `setsid` (util-linux) installed; docs say so. One documented way to put `bottle` on PATH: symlink into `~/.local/bin` plus a mise global Node.
- Docs pass done against the latest commits (Pi load wait, attach restarting a quit Pi, init's Enter-to-check, the mod's bottle machine and 10 s inbox poll, `mod.open:speaker`).

## 2026-11-15 21:10 · paused

**Next**
- trusted needs secret `GITHUB_READ` and the obsidian/karakeep services in speaker.
- Owner: re-point bottle at the new speaker (`mise run init bottle`), `bottle register`, approve the host. Fresh server lacks openrouter/anthropic/openai services (old volume): add them or wipe the volume.
- Owner: link the Herdr mod (`ln -s "$PWD/herdr/mods/speaker" ~/.config/herdr-app/mods/speaker`), set URLs in the inbox's Settings, optionally `"global": {"alt-s": "speaker.open"}` in keys.json. Then try Start (template x model), Stop, waiting-agent highlight, Recently finished.

**Open**
- A `-m deepseek` launch on the laptop speaker timed out at the launch request (no request_created in audit; agent left failed-archive). Likely the missing openrouter service there; not investigated.
- Nothing in the Herdr mod was clicked live (Start via `hc run --bg --rm`, `tab.new` for archives, highlight). The mod passes `herdr-app check`.
- Qwen consulting DeepSeek via the subagent extension: not started; the model door serves one model per VM today.
- Herdr's built-in agents sidebar needs OSC 7501 status from `bottle attach`; the payload format is undocumented, parked.

**Settled**
- Pi liveness: Pi runs as `node-MainThread` until loaded, so `ps -C pi` failed every cold launch ("Pi exited right after launch", also the 18:08 run). Now matched by comm or args. Verified live: sealed on local Qwen starts, `/space/agent-space` writes reach the host.
- Launch folders (option 1): `bottle run -f <path>[:rw]` and template `folders` bind host folders into the VM without speaker (the launch is the approval; recorded in policy-events.jsonl). All three templates mount `~/agent-space:rw` at `/space/agent-space`; the `bottle-agent-space` speaker share is dropped. Speaker-approved local folders mid-run (option 2) not built.
- Local model: llama.cpp router at 192.168.0.83:8080, preset `qwen27b` (Qwen 3.8 27B Q8_0), alias `qwen`. The router loads models on demand, so a cold first call is slow.
- Three templates: sealed (agent space, no network, default qwen), builder (space plus public network, default deepseek, 72 h, 1500 requests), trusted (builder plus GITHUB_READ, obsidian.read, karakeep.read up front). Writes, SSH and notes otherwise are always mid-run cards; no ceilings. Template `attended` removed.
- Model aliases (`-m qwen`); a down local model server fails `run` at once. `bottle templates [--json]` works without the service.
- Read-write shares mount at `/space/<share>`, read-only at `/input/<share>`.
- `/api/state` carries `outputDir` and `finished` (from archive folders, shared with `ls`). Herdr mod settings live in Herdr `shared("speaker.settings")`; config.json is gone.

## 2026-11-15 11:30 · paused

**Next**
- Owner: try `bottle run "<prompt>"` attached, Ctrl-\ to detach (tab should appear in Herdr's bottle space), and `bottle run -d`. Not exercised with a TTY yet.
- Owner: install the Herdr mod's new Agents section (`"bottle": "http://127.0.0.1:7001"` in the mod's config.json) and click an agent; focus across spaces is untested.
- Owner: add the OpenRouter key in speaker Setup, then run `E2E.md` (check H now uses `bottle run -d`).

**Open**
- Herdr mod waits for a new terminal with `exec("sleep")` polls (up to ~3 s); revisit if tabs appear slowly.
- `speaker/ui.ts` host card casts `who.at as number` (a host card always has a host).
- Validating "no skill for Pi in bottle" would need an A/B eval (see chat 2026-11-15); not started.

**Settled**
- "Agent" everywhere (code, API `/api/agents`, `maxAgents`, `_control/agent.json`); no compat code kept anywhere.
- `bottle run` starts bottle on demand; it stops 10 min after its last agent (`idleStopMinutes`), verified live. `bottle down` is the kill switch; `bottle:up`/`bottle:down` are gone. `bottle` is linked into `~/.local/bin`.
- run attaches by default; `-d` detaches; attended follows attach. The CLI opens Herdr tabs (detached runs only).
- One agent help route: `/_speaker/help` (`/skill.md` removed). Granted secrets carry only `environment`.
- UI screenshots: one dated set in `speaker/docs/ui/2026-11-15/`.

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
