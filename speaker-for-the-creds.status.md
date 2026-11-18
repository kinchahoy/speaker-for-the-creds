---
project: speaker-for-the-creds
topic: Agents & security
state: paused
priority: P1
updated: 2026-11-18T16:40
repo: ~/code/workshop/speaker-for-the-creds
tags: [workshop, status]
---

# speaker-for-the-creds status

Newest first. Frontmatter `state`/`updated` mirror the newest entry.

## Real-time guidance (to be questioned)

- 2026-11-18: "I like the purity of I just type in the creds and they die after X time (speaker recycles box) but in the future giving speaker some creds to automate this sounds helpful."

## Ideas

- Secret-URL credentials in the encrypted store: some upstreams use the URL itself as the credential (ha-mcp's in-process server at `.../api/webhook/<id>` or `:9584/private_<random>`), so today that secret sits in plain service config as `baseUrl`; let a service's `baseUrl` (or a path segment) come from an encrypted secret instead: serves the star because the Home Assistant path the to-do agent depends on would keep its credential under the same unlock-and-log rules as every other key · cost S · 2026-11-18
- Logged-in browser held by speaker: agent-browser runs outside any agent's VM, the owner types the login into the approval card (in-memory profile, killed on expiry, revoke or lock), agents get page outlines, clicks and screenshots through speaker as an MCP service with eval, state, upload and download denied; later speaker keeps the password in its store and logs in again itself. Where it runs is open: B, a child process of speaker as a separate user with Chromium's sandbox, or D, a separate bottle VM (stronger isolation and a real allowlist, but bottle would hold a secret): serves the star because the Home Assistant frontend keeps its token in the browser, so this is the way an agent can see HA dashboards without the token · cost L · 2026-11-18

## Next steps

- [x] Review the uncommitted combined diff (speaker, bottle, Herdr mod; the Herdr mod is about 23% over the owner's 20% budget) `size:M` `needs:agent`
- [x] Format `speaker/init.ts` and `speaker/test/proxy.test.ts` so `mise run check` passes (formatting only) `size:S` `needs:agent`
- [x] Give the go-ahead to commit and deploy the working tree (deployed speaker and bottle run `06525ba`) `size:S` `needs:me`
- [ ] Rebuild the guest image and check titles, pi-subagents and Pi status reports in a real bottle; also that the build passes its tools check and that `agent-browser open example.com` (granted) plus `screenshot` work in the guest `size:M` `needs:me`
- [ ] Decide the wake-on-demand design: bottle events to URLs with an optional sidecar, in place of `localModel.wake.command` `size:M` `needs:me`
- [ ] Decide whether to build the Atuin threads push (`bottle thread <id>` plus a Save to Atuin button) `size:M` `needs:me`

## 2026-11-18 16:40 · paused

The guest's tools now come from one file, `bottle/guest/locally-available-tools.md`: the Dockerfile installs each line in its source's layer (a first build stage splits it per source, so cache layers hold), ships the file to `/opt` for Pi, and fails the build when a named command is missing. `guest/mise.toml`, `guest/python/requirements.in` and `CLI_TOOLS` in `bottle/src/pi.ts` are gone; Pi's system note points to the file. agent-browser joined Playwright, on Playwright's Chromium, set up by `/etc/agent-browser.json`. Checked: the list split (lists stage built alone), `mise run check`, bottle tests 7/7. Not checked: a full image build and agent-browser in a real VM (on the rebuild task). Restore tag `pre-guest-tools-2026-11-18`.

**Next**
- See Next steps above.

**Open**
- 2026-11-18: Not verified until the rebuild: that Chromium starts as the guest user with `--no-sandbox`, that agent-browser accepts the full system bundle as `caCert`, and that the Debian `imagemagick` provides `magick`.
- 2026-11-18: Per-call text from bottle is now one system line plus a short `request_capability` description (about 430 characters, was about 4,700); the briefing goes once as the first message and sits at `/etc/bottle/briefing.md`. Not run in a real bottle yet: watch that an attended launch without a prompt gets the briefing with the owner's first message, that Pi re-reads the file after compaction, and that it still uses uv and asks for access in one call. This needs a real Pi run (model calls), not an image rebuild.
- Goal check: proposed addition to the North star, for the owner to rewrite: "Agents can see and act in logged-in web apps (Home Assistant first) through a browser speaker holds; the owner types the login and it dies with the session." (what changed: the 2026-11-18 guidance line about typing the login and letting it expire; question: is the logged-in browser part of the to-do agent's path, or a side track?)

## 2026-11-18 14:55 · paused

Sync merge. Local `main` was 26 commits behind `origin/main` (`6894162`), while Syncthing had brought in a working tree that was `origin/main` plus newer uncommitted work: the guest `speaker` command, `/_speaker/enroll.sh`, clearer unknown-service and upstream-error answers for agents, a shorter SKILL.md, and config.json hot reload. That tree was committed as a snapshot (`cbd928b`), merged with `origin/main` keeping the synced tree (`de19ea8`), then the config watcher was fixed to ignore a missing config.json (tests failed on it) and four files were formatted. `mise run check` passes; speaker tests 17/17, bottle tests 7/7. Not checked: a real bottle run of the guest `speaker` command, and the deployed install. Restore tag `pre-sync-merge-2026-11-18` (`git reset --hard` to it returns to the snapshot); final commit is the one that adds this entry.

**Next**
- See Next steps above.

**Open**
- 2026-11-18: Next steps had two tasks that were never committed and already shipped in `1274bd4` (releasable secrets, readable secret form errors); they were removed. The "review the combined diff" and "format" tasks were ticked as done.
- 2026-11-18: Kept: sandboxed Pi is told to file a request and keep working instead of blocking on `Speaker-Wait: 60` (direct agents still use the header). Owner agreed.
- 2026-11-18: Cleanup done with the owner's go-ahead: branches `ws/2026-11-08` and `batch-extensions-attended` (remote too) deleted, both stashes dropped, `main` pushed. `.claude/worktrees/` (Mac clone's agent worktrees, gitignored) left in place.
- 2026-11-18: Whether the deployed speaker and bottle still run `06525ba` is unknown.

## 2026-11-16 12:46 · paused

**State**
Docs revamped so they read user-first: the top-level README is now the product doc (what it is, what works today, how it works, getting started, side tracks); component READMEs are reference; `speaker/DESIGN.md` is the one design doc and now carries the use cases and the end-to-end check plan. `speaker/USECASES.md` and `E2E.md` were removed after folding their content in (git keeps them). Docs only: no code, config or tests changed, and the pending code round is still uncommitted. Restore tag `pre-docs-revamp-2026-11-16` (`git reset --hard` to it undoes the revamp).

**Next**
- See Next steps above.

**Open**
- Goal check: proposed North star, for the owner to rewrite. "A to-do list kept by an agent that wakes about every 3 hours, with back-and-forth from the owner's phone, that updates the owner's iOS Reminders through Home Assistant. Everything else is a step toward that." Win: that agent runs for a week and the owner trusts its Reminders without checking the approvals each time. Miss: a polished approval desk with nothing driving it, or a native phone app built first. Interim phone path (the owner: "we're using herdr + the webpage for now on the phone. Not perfect, but its something! We'll get to an app but its not super urgent right now.") counts as progress. Not now: a native app or push, money budgets, more UI polish.
- Conflict, unresolved: the 01:46 entry and Next steps say the round is uncommitted and deployed is `06525ba`, but HEAD was `9776986` ("Improved speaker and bottle for deployment") and the handoff says the new code is pushed and live (it names `6a5db02`, which is not in this repo). Which is true?
- Is this yours? `AGENTS.md` (project rules) carries an AI marker but reads like the owner's rules; left verbatim. Every other tracked doc was marked AI, so no owner text was edited.
- `speaker/skill/SKILL.md` is served to agents at runtime and says the owner "approves each use from a phone"; left alone as it is product text. Suggested replacement: "approves each use in the admin page or Herdr".
- `ui-improvements-ideas.md` (tracked): recommend delete once the pending `/admin` rework is reviewed, since it is the proposal that round implements; move at most three lines into Next steps. `ui-density-ideas.md` (untracked): recommend keep until that review, then fold its few actionable points or delete. Neither was touched.
- `.claude/worktrees/` stale copies and the branches `ws/2026-11-08` and `origin/batch-extensions-attended` are undocumented; not touched.

## 2026-11-16 01:46 · paused

**State**
Speaker and bottle work, but a large round is still uncommitted: the `/admin` rework, the Herdr mod rework, agent titles, pi-subagents, the cron template, per-model OpenRouter routing and `localModel.wake`. Tests pass (82 speaker; 55 bottle, 6 skipped), yet the combined diff has never been reviewed. Work is paused until the owner gives the go-ahead to commit and deploy.

**Next**
- See Next steps above.

**Open**
- Should the working tree be committed and deployed as one round, after the review?
- Wake-on-demand design: bottle events to URLs with an optional sidecar, in place of `localModel.wake.command`?
- Build the Atuin threads push, or leave it parked?

## 2026-11-16 01:00 · paused

**Next**
- Read `personal/HANDOFF-2026-11-16.md` first (git-ignored; it holds the full state, the open list and how to work with the owner's machines).
- Owner: give the go-ahead to review, commit and deploy the working tree. Nothing from this round is committed; deployed speaker and bottle run `06525ba`.
- Design with the owner before shipping wake-on-demand: bottle events delivered to URLs, with an optional sidecar running small scripts per event, in place of `localModel.wake.command`.

**Open**
- Uncommitted: the `/admin` rework (one Agents page, Setup and Activity tables, idiomorph polling), the Herdr mod rework, the bottle CLI output, agent titles (proper-base in the guest, `titles` host message), pi-subagents always on with limits, the `cron` template, the `life` group and its example services, per-model OpenRouter routing, `localModel.wake`, `bottle ls --json`, and a Dockerfile and compose file for bottle.
- Never done: a full review of the combined diff. Tests pass (82 speaker; 55 bottle, 6 skipped); two speaker sign-in tests are timing-sensitive. `mise run check` fails only on the formatting HEAD already has in `speaker/init.ts` and `speaker/test/proxy.test.ts`.
- Unverified in a real bottle: everything that needs the guest image rebuilt (titles, pi-subagents, Pi status reports), the Herdr dialog beyond its signed-out state, and the web pages under real clicks.
- The Herdr mod is about 23% larger than before this round; the owner's budget was 20%.

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

- Settled, for reference:
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

- Settled, for reference:
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

- Settled, for reference:
- Speaker is one approval engine (`speaker/engine.ts`): every kind is a uniform adapter, sandbox hosts included; one lifecycle table; `reconcile()` after Setup changes; one card shape for the web inbox, `/admin/api` and Herdr. Merged from the worktree branch, which is removed.
- Host approvals are not kept across a speaker restart: known hosts come back pending. bottle treats a pending host as an outage and gives up after its limit (5 minutes, or 30 s at its own startup), naming the approval.

## 2026-11-14 19:30 · paused

**Next**
- Run `E2E.md` once: the owner runs `mise run init` and enters the OpenRouter key on the openrouter service; a subagent drives checks A–L while the owner approves live (browser and the Herdr inbox).
- After it passes: `mise run lock` to record the tested dependency set.

**Open**
- Herdr mod: the bar and the inbox dialog are meant to share one sign-in (a module-level token); unverified in a live Herdr window (E2E check K).
- Herdr names the bottle space after its first terminal's folder; rename it to "bottle" once.

- Settled, for reference:
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
