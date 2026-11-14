<!-- author: ai -->

# Plan: a smaller speaker-for-the-creds, with Herdr as a place to work

<sub>AI-written, 2026-11-14. Nothing here is built yet. Line counts are estimates.</sub>

## Intent

Who is who in this document: **the owner** is the human who runs this project and makes every decision. **The main session** is the coding agent carrying out the plan; **subagents** are cheaper agents it hands mechanical edits to. "The agent", "Pi" or "a task" elsewhere means an AI agent that speaker and bottle serve, not the one doing this work.

1. **Make the project smaller before making it bigger.** Fewest lines of custom code is a high priority: remove (with approval) what nothing uses, keep an eye out for dead code, and let well-kept libraries do what custom code does today. The owner is open to tweaking or simplifying features if that helps reduce custom code, but some expensive features are cool and worth it; those stay.
2. **Then make Herdr a place to work with it, at the smallest cost.** Each bottle task shows up as an agent in the Herdr app that the owner can talk to, and Herdr tells the owner when a card is waiting. The web `/admin` stays the one complete UI; approving inside Herdr is a later, small step, not a second frontend.
3. **Keep it easy for others to deploy.** One laptop or several boxes, minimal setup on remote machines, latest dependencies by default with a tested lockfile available.
4. **Don't weaken security boundaries without specifically checking.** Any cut or library swap that touches grants, token binding, secret handling, audit logging or share containment is raised with the owner first.

## What decides the design

- **Herdr is two products.** The Herdr app is a window (`herdr-app`) plus `herdr-core` / `hc`, which runs every terminal. The older Herdr TUI (`herdr`) is a separate program with its own server.
- **A Herdr app pane is a terminal**, so anything that runs in a terminal already works there.
- **A core terminal with the labels `herdr.space` and `herdr.tab` shows up in the app**, on its machine, even when a script started it. Other machines are added with `hc machine add <ssh target>`, which copies `hc` there.
- **App mods are native JavaScript with no web view.** `/admin` cannot be embedded. A mod reuses nothing from the web UI except an HTTP endpoint, so every mod feature is new code.
- **Speaker has no owner JSON API**; the owner side is HTML forms behind a cookie. It already pushes new cards to ntfy.

## Chunk 1: agents in Herdr, cards announced (about 60 new lines)

| Change | Where | Lines |
| --- | --- | --- |
| **Launch hook.** When a task starts, bottle runs `hc run --bg --name pi-<id> --label herdr.space=bottle --label herdr.tab=<id> -- bottle attach <id>`. Herdr shows a **bottle** space on that machine with one tab per task, however the task was started. On by default when `hc` is on `PATH`, off otherwise; `"herdr": false` in `config.json` turns it off. | `bottle/src/tasks.ts`, `config.ts` | ~15 |
| **Status: nothing added.** Whatever Pi itself reports reaches Herdr through dtach and the attach terminal. A pending speaker request does not show as blocked; the toast below covers it. | none | 0 |
| **Notify mod.** Listens to the ntfy topic, shows a Herdr toast per new card, click opens `/admin` in the browser. Needs ntfy configured. | `herdr/mods/speaker/` | ~40 |
| **"Pi (sandbox)" in Herdr's + menu.** A `programs.json` entry that runs `bottle run`. Config, documented in the README. | docs | 0 |

Spikes first, because these are unverified:

- Pi's status reports reach Herdr through dtach and `msb exec -t`. If Pi reports nothing, the fallback is a guest extension of about 20 lines.
- A labelled `hc run` on a remote machine appears as a tab, and the tab closes when the task archives.
- A mod can hold an ntfy subscription (or poll it) with `fetch`.
- Terminal resize through dtach.

## Chunk 2: approve in Herdr (about 150 lines), only if the browser hop annoys

| Change | Where | Lines |
| --- | --- | --- |
| **Owner API, three routes**: sign in with the password (returns a bearer token held in the same in-memory session map), view (pending cards, locked state), decide. They call the core functions the forms already call. Bearer only, never the cookie, so no CSRF surface is added. | `speaker/admin.ts` | ~50 |
| **The notify mod becomes an inbox**: password field, pending cards, a duration picker and one **Approve as asked** button per card, and **Deny**. Everything finer (unticking items, Extend, Revoke, Setup, Log) is an **Open in browser** button. | `herdr/mods/speaker/` | ~100 |

The password is typed once per Herdr start and the token lives in a variable, never on disk. Signing in here also unlocks speaker after a restart, as `/admin` does.

Security level: sandboxed agents cannot reach the Mac, the mod or the token. Direct agents running as the owner's user account on the same Mac could edit the mod's files, which matches what `DESIGN.md` already says about a single machine (accident protection, not a hostile local agent). A stored token in the OS keystore is a possible later step; through the `security` CLI any process running as the owner's user account can read it back, so it only helps with a signed helper and Touch ID.

## Not building

- **A terminal UI for speaker.** At inbox-only scope it is no smaller than the mod, and adds a dependency.
- **Setup and Active in Herdr.** They stay in the browser.
- **herdr-core inside each VM.** The guest stays sealed.
- **A web-to-TUI or TUI-to-web bridge.** No converter is good enough to replace the phone cards.

## Deployment models

| Model | Speaker | bottle host in Herdr | Note |
| --- | --- | --- | --- |
| Everything on the MacBook | `localhost` | this machine | Needs bottle to run on macOS, which the README lists as unverified. |
| Always-on box + mi60 or a NUC | LAN or tailnet URL | `hc machine add <host>` from the Mac | The speaker box needs nothing new. |
| bottle in WSL on the desktop | same | `hc machine add --via 'wsl.exe -d Ubuntu -e sh -c' --name wsl` | |

Remote setup is `bottle` on `PATH` on the bottle host; `hc` arrives over ssh.

## Order of execution

Not started; this is the drafted sequence. Work happens on `main`, in one working tree, with cheap subagents doing the mechanical edits and the main session reviewing each diff before it is committed.

| Step | What | Who | Check |
| --- | --- | --- | --- |
| 0 | Commit, tag `pre-cuts-2026-11-14` | main session | |
| 1a | **Speaker low-risk cuts**: the `core` unpacking blocks in `api.ts` and `admin.ts`, old-host defaults, unused `version` field | cheap subagent A (speaker files only) | `tsc`, lint, speaker tests |
| 1b | **Bottle low-risk cuts**: Herdr TUI integration in `cli.ts`, `shareRoots`, the reload route, the duplicate check in `start.sh`, the CLI error prettifier; matching README lines | cheap subagent B (bottle files only), in parallel with A | `tsc`, lint, bottle tests |
| 1c | **One copy of the init helpers** | cheap subagent C, after A and B (it touches both packages and their init tests) | both test suites |
| 2a | **Slim trace**: replace the trace export with one JSON line per model call (see below) | cheap subagent, bottle files | bottle tests; a task archive holds `model-calls.jsonl` |
| 2b | **Cut VM-mount folder delivery** from speaker; `DESIGN.md` updated in the same commit | cheap subagent, speaker files, in parallel with 2a | speaker tests |
| 2c | **In-VM MCP servers stay**: add a test that an approved `mcp:<id>` puts the server into Pi's MCP config and a revoke removes it (no VM needed), and a short README example of a catalog entry | cheap subagent, after 2a | the new test passes |
| 2d | **Cut `bottle doctor`** | cheap subagent, bottle files, after 2a | bottle tests; README no longer names it |
| 2e | **MCP tool listing through `@modelcontextprotocol/client` v2**, classification unchanged; the unused v1 SDK is removed; skipped if the v2 check fails | subagent on a mid-tier model, after 2b (same files) | `speaker/test/proxy.test.ts` and the MCP tests pass unchanged |
| 2f | **Require the proxy and SSH ports** in speaker and bottle | cheap subagent, after 2e | both test suites |
| 3a | **One pnpm workspace, latest by default**: a root `pnpm-workspace.yaml` with each shared dependency declared once, one lockfile, one set of mise tasks; floating specs; `install` takes latest and `install:locked` uses the lockfile; `speaker/Dockerfile` reworked for the workspace, floating by default with a locked build on request | main session | `mise run install`, check, tests, and a container build both ways |
| 3b | **Library changes** (findings below): `commander` for bottle's CLI and the root `init.ts`, Hono's proxy helper, Node's key handling, one commit each. The MCP client is step 2e. | cheap subagents | tests pass unchanged; the CLI checked by hand |
| 3c | **Hono's typed client**: both servers' routes become one chained definition that exports its type; bottle's calls to speaker and the bottle CLI's calls to its control API use the typed client | subagent on a mid-tier model, after 3b | `tsc` catches a wrong path or body; both test suites |
| 4 | **Herdr chunk 1**: spikes, launch hook, notify mod | main session | a real task shows as a tab; a card toasts |
| 5 | **Herdr chunk 2**, if wanted | main session | approve a card from Herdr |

Rules for the subagents: each gets an exact file list and the audit's line ranges, removes only what is listed, never edits a test to make it pass (a failing test is reported back), and does not commit. A and B run together because their files do not overlap; nothing else runs in parallel in the one tree.

Agreed: all low-risk cuts (1a to 1c) including the Herdr TUI integration, the slim trace (2a), cutting VM-mount delivery (2b), keeping in-VM MCP servers with a test (2c), cutting `bottle doctor` (2d), and simplifying the MCP tool listing without losing the feature (2e). Also agreed: requiring the proxy and SSH ports (2f). Every other feature stays.

Not doing: reformatting speaker to width 160. It removes 363 lines without removing any code, and 160 is not a common width (formatter defaults are 80 to 100, and 120 is a common wider choice), so speaker's 120 is the more standard of the two. The packages keep their current widths.

## Open

Nothing is waiting on a decision. No agent starts any step until the owner says go.

## Line-reduction audit of the existing code

A read-only audit by a subagent, which read every non-test source file (8,752 lines) and did not run the tests. Only the Herdr count is measured; the rest are estimates of about ±25%. Nothing is cut yet.

### Low risk, no feature lost (about 230 lines) — agreed

| Cut | Lines |
| --- | --- |
| Drop the blocks in `speaker/api.ts` and `admin.ts` that only unpack `core` into locals | ~-60 |
| One copy of the prompt helpers duplicated between `speaker/init.ts` and `bottle/init.ts` | ~-50 |
| Herdr TUI integration in `bottle/src/cli.ts` | -42, exact |
| Small items: old-host defaults, an unused `version` field, a duplicate storage check in `start.sh`, a CLI error prettifier | ~-35 |
| Dead branches in `bottle/src/trace.ts` left from when all egress was recorded (absorbed by the slim trace, step 2a) | ~-20 |
| `shareRoots`, which no longer does anything (old configs containing it stop loading) | ~-10, plus ~15 in tests |
| `POST /api/catalog/reload`, which duplicates the SIGHUP reload | -9 |

### Feature cuts already decided

| Cut | Lines | Decision |
| --- | --- | --- |
| Trace export, replaced by the slim version below | ~-320 | do it |
| VM-mount folder delivery in speaker | ~-45, plus ~60 in tests | cut |
| In-VM MCP servers (`mcp:` items) | 0 | keep, add a test and a README example |

### Further feature cuts

Decided:

| Cut | Lines | Decision |
| --- | --- | --- |
| `bottle doctor` | ~-59 | cut. `init` and `start.sh` keep their own host checks. |
| Read/write classification of remote MCP tools | ~-35 | **simplify, do not remove.** About 50 of its lines are a hand-written MCP client that lists a server's tools (handshake, paging, event-stream parsing, session close). The official MCP client does that in about 20 (details under Library pass). The classification itself stays as it is. |
| Require `PROXY_PORT` and `SSH_PORT` (and bottle's matching settings) | ~-40 | cut. Speaker no longer runs without the secrets proxy or jump server; `init` already sets both. |

Kept, by the owner's decision: hosted model providers (a key feature), the speaker link as it is, all of `init`, the `/admin` extras, the three-denials lock, extension-bundled sites, the Docker path and the demo service.

### Library pass: findings

A standing rule for this project: prefer a well-kept library over custom code wherever it makes the total smaller. A subagent read the source and checked npm on 2026-11-14; it ran nothing except the Node key round trip. Line counts are estimates of about ±25%. About 90 lines beyond what was already agreed.

Agreed, all four:

| Change | Lines | Dependencies | Changes in behaviour | Risk |
| --- | --- | --- | --- | --- |
| **bottle CLI on `commander`** (15.1.0, MIT, released 2026-11-07) in place of the hand-written help tables, option parsing and dispatch in `bottle/src/cli.ts` | ~-35 | +1 | Help wording; keeping exit code 2 for usage errors needs one setting. | Low to medium. `cli.ts` has no tests. |
| **MCP tool listing on the official client** (step 2e). Checked in the installed SDK: it takes the credential header, refuses redirects and returns the raw read-only and destructive hints. | ~-30 | Use `@modelcontextprotocol/client` 2.4.0 (7 direct dependencies) rather than the v1 SDK, which would pull about 60 packages into the container. The v1 SDK is already a dev dependency that nothing imports; it goes. | Tool schemas are validated, so an odd server could fail to list where it lists today. Not yet checked for v2: its class names and that the hints pass through. | Medium. Covered by `proxy.test.ts`. |
| **Upstream forwarding on Hono's proxy helper**, already installed | ~-12 | 0 | Compression is negotiated instead of forced off; a malformed `Connection` header is answered 400. The header strip list, redirect refusal and audit stay. | Low to medium. Covered by `proxy.test.ts`. |
| **Secrets-proxy key handling on Node's built-in key export and import** | ~-11 | 0 | None; stored keys stay readable. Verified by running it. | Low. |

**Latest by default; a lockfile is available** (the owner's rule, now in `~/AGENTS.md`). In this repo, as step 3a:

- **One pnpm workspace.** Eight dependencies are declared in both packages today, with two lockfiles and every mise task written twice. A root `pnpm-workspace.yaml` declares each once, leaves one lockfile, and halves the mise tasks. It also gives the root `init.ts` somewhere to get `commander` from (~-23 lines more).
- **Specs float.** `mise run install` takes the newest versions and leaves the lockfile alone (`pnpm install --no-lockfile`).
- **Locked is available.** `mise run install:locked` installs exactly the committed lockfile, the last tested set.
- **The speaker container floats too.** `speaker/Dockerfile` installs latest by default; a build argument gives the locked build when the owner asks for it. The Dockerfile is reworked anyway, because it copies only speaker's own files today.
- **Agents update the lockfile only when the owner specifically asks.**
- This settles the two things the scan flagged: `undici` in bottle (two major versions behind) moves up with the first latest install, and Pi as `latest` in the guest image is within the rules.

**Hono's typed client** (step 3c, adopted for type safety rather than line count). Both servers register their routes as separate statements today, so they are first restructured into one chained definition each. bottle's calls to speaker and the CLI's calls to bottle's control API then go through the client, and a wrong path or body shape fails `tsc`. The scan expected this to be about neutral in lines, possibly slightly up. One naming trap: Hono's client function is called `hc`, the same as herdr-core's command; import it under another name.

`@clack/prompts` is already the prompt library in both `init` files; nothing to adopt there.

Checked and rejected, so they are not looked at again:

- **A reconnecting WebSocket wrapper** for bottle's speaker link: it could replace only the backoff timer (about 6 lines), and would need a workaround to send the auth header. Net zero or worse.
- **`@clack/prompts` built-ins** for the init helpers: they do not cover the flag-or-default-or-prompt pattern. The helpers are shared instead (step 1c, ~-42).
- **`age-encryption`** for the key store: changes the on-disk format, is pre-1.0, and touches secret handling.
- **A MITM proxy library** for the secrets proxy, **`ssh2`** for the SFTP relay, **Hono's bearer-auth** for agent tokens: each would lose a security check or need the same code written around it.
- **Merging speaker's secrets proxy with bottle's `proxy-chain`**: they do different jobs.
- Removing `hono-rate-limiter` or `write-file-atomic`, and about ten small utilities: each under 5 net lines.

**Hosted model providers, in plain words.** By default the Pi inside a VM talks to the owner's own model server. This feature lets a task use a cloud model instead (`--model <provider>/<model>`). The provider's API key is a speaker secret; the task's first card asks for it, Pi starts once the owner approves, and the VM only ever sees a placeholder that speaker's proxy swaps for the real key. Cutting it leaves local models only.

**The speaker link, in plain words.** bottle holds one WebSocket to speaker to receive grants. Around it are four behaviours: it reconnects with a growing delay; on a failed connect it asks speaker whether its token is still accepted, and stops at once with a "register again" message if not; it shuts bottle down if speaker was never reached within 30 seconds of startup or has been gone for 5 minutes; and it drops every grant after 30 seconds of silence. The cut would keep only the last one and retry forever. The token check and the give-up limits are the fast-fail path, which is why they are kept.

### The trace export: why it is large, and a slim version

`bottle/src/trace.ts` is 437 lines. About 90 of them write the archive manifest and stay either way. The rest goes to:

- saving each model request and reply as size-capped blobs, with truncation bookkeeping and an allowlist of 23 headers (~105 lines);
- rebuilding tool calls from Pi's session file and pairing each call with its result (~90);
- reassembling streamed replies into finished messages (~25);
- shaping all of it into a linked run tree in the format LangSmith and Phoenix import (~55). That import is unverified.

**Slim version, about 25 lines (decided):** the model door appends one JSON line per model call to `model-calls.jsonl`: time, status, duration, the request body and the raw reply, each cut off at a size cap. It keeps the one thing nothing else records, which is exactly what the model was sent and what it answered. It drops the header capture, the reassembled messages (the raw stream is kept instead), the tool-call records (Pi's session file already has them) and the importable run tree. Net saving about 320 lines instead of 380.

### In-VM MCP and VM-mount delivery, in plain words

- **In-VM MCP servers (`mcp:<id>`).** A catalog entry names an MCP server program already inside the guest image. A task asks for `mcp:<id>`; when the owner approves, bottle writes it into Pi's MCP config and restarts Pi at its next idle moment, and Pi gains that server's tools. Revoking removes them. The shipped catalog has no entries, so nothing uses this today. Remote MCP servers are unaffected: they are speaker services.
- **VM-mount folder delivery.** Speaker can deliver a `folder:` grant two ways. Over SSH, the sandbox mounts the share with `sshfs` through speaker's jump server, which is what happens today. As a VM mount, a sandbox host that has the folder on its own disk would map it straight into the VM, which is much faster for `grep -r`, `find` and `git status`. bottle always tells speaker it cannot mount, so speaker's VM-mount branch never runs. Cutting it removes the unused branch and closes the door on the fast path until it is rebuilt.

### Not recommended (weakens a security boundary)

- Replacing the filtering SFTP relay with a plain `sftp-server` (~-300): loses share containment, read-only enforcement and per-file logging.
- Dropping the custom Origin check in `admin.ts` (~-14): Hono's CSRF helper only checks form posts.
