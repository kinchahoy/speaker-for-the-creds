<!-- author: ai -->

# Plan: speaker approvals and sandboxed agents inside Herdr

<sub>AI-written, 2026-11-14. Nothing here is built yet. Line counts are estimates.</sub>

**Priority: fewest lines of code across the whole project.** That rules out a second full frontend. The web `/admin` stays the one complete UI; Herdr gets the smallest thing that works.

Goals:

1. See each bottle task as an agent in the Herdr app and type to it there.
2. Know in Herdr when a card is waiting, and later approve it there.

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

Security level: sandboxed agents cannot reach the Mac, the mod or the token. Direct agents running as you on the same Mac could edit the mod's files, which matches what `DESIGN.md` already says about a single machine (accident protection, not a hostile local agent). A stored token in the OS keystore is a possible later step; through the `security` CLI any process running as you can read it back, so it only helps with a signed helper and Touch ID.

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
| 1b | **Bottle low-risk cuts**: Herdr TUI integration in `cli.ts`, dead trace branches, `shareRoots`, the reload route, the duplicate check in `start.sh`, the CLI error prettifier; matching README lines | cheap subagent B (bottle files only), in parallel with A | `tsc`, lint, bottle tests |
| 1c | **One copy of the init helpers** | cheap subagent C, after A and B (it touches both packages and their init tests) | both test suites |
| 2a | **Slim trace**: replace the trace export with one JSON line per model call (see below) | cheap subagent, bottle files | bottle tests; a task archive holds `model-calls.jsonl` |
| 2b | **Cut VM-mount folder delivery** from speaker; `DESIGN.md` updated in the same commit | cheap subagent, speaker files, in parallel with 2a | speaker tests |
| 2c | **In-VM MCP servers stay**: add a test that an approved `mcp:<id>` puts the server into Pi's MCP config and a revoke removes it (no VM needed), and a short README example of a catalog entry | cheap subagent, after 2a | the new test passes |
| 3 | **Further feature cuts**, if you approve any from the table below, one commit per feature with docs | one cheap subagent per feature; those sharing files run in sequence | tests; `DESIGN.md` and READMEs match |
| 4 | **Herdr chunk 1**: spikes, launch hook, notify mod | main session | a real task shows as a tab; a card toasts |
| 5 | **Herdr chunk 2**, if wanted | main session | approve a card from Herdr |

Rules for the subagents: each gets an exact file list and the audit's line ranges, removes only what is listed, never edits a test to make it pass (a failing test is reported back), and does not commit. A and B run together because their files do not overlap; nothing else runs in parallel in the one tree.

Agreed: all low-risk cuts (1a to 1c) including the Herdr TUI integration, the slim trace (2a), cutting VM-mount delivery (2b), and keeping in-VM MCP servers with a test (2c). Step 3 waits on your picks.

Not doing: reformatting speaker to width 160. It removes 363 lines without removing any code, and 160 is not a common width (formatter defaults are 80 to 100, and 120 is a common wider choice), so speaker's 120 is the more standard of the two. The packages keep their current widths.

## Open

1. **Which further feature cuts to take** (table below).

## Line-reduction audit of the existing code

A read-only audit by a subagent, which read every non-test source file (8,752 lines) and did not run the tests. Only the reformat and Herdr counts are measured; the rest are estimates of about ±25%. Nothing is cut yet.

### Low risk, no feature lost (about 230 lines) — agreed

| Cut | Lines |
| --- | --- |
| Drop the blocks in `speaker/api.ts` and `admin.ts` that only unpack `core` into locals | ~-60 |
| One copy of the prompt helpers duplicated between `speaker/init.ts` and `bottle/init.ts` | ~-50 |
| Herdr TUI integration in `bottle/src/cli.ts` | -42, exact |
| Small items: old-host defaults, an unused `version` field, a duplicate storage check in `start.sh`, a CLI error prettifier | ~-35 |
| Dead branches in `bottle/src/trace.ts` left from when all egress was recorded | ~-20 |
| `shareRoots`, which no longer does anything (old configs containing it stop loading) | ~-10, plus ~15 in tests |
| `POST /api/catalog/reload`, which duplicates the SIGHUP reload | -9 |

One medium-risk extra: replace speaker's hand-written upstream forwarding with Hono's proxy helper (~-15 to -20). The header strip list must survive, and the helper's behaviour is unchecked.

### Feature cuts already decided

| Cut | Lines | Decision |
| --- | --- | --- |
| Trace export, replaced by the slim version below | ~-320 | do it |
| VM-mount folder delivery in speaker | ~-45, plus ~60 in tests | cut |
| In-VM MCP servers (`mcp:` items) | 0 | keep, add a test and a README example |

### Further feature cuts: your decision (about 780 lines in total)

| Cut | Lines | What you lose |
| --- | --- | --- |
| Narrow `init`, four separable pieces | ~-185 | Re-running `init` to update an install with your old answers as defaults (~45); `init bottle` unlocking speaker and approving the sandbox host with the owner password, instead of you doing it in `/admin` (~65); the smoke-test task at the end (~55); the reverse-proxy questions in `init speaker` (~20). Flags-only init would be ~-400. |
| Read/write classification of remote MCP tools | ~-120 | `.read` grants for MCP services; every tool call would need `.full`. Coarser grants. |
| `/admin` extras: filter bar, custom confirm dialog, per-agent counts, countdown meters | ~-125 | Polish on the owner pages. |
| Hosted model providers in bottle | ~-110 | Hosted models through a speaker secret; local models only. Removes the `awaiting-key` task state. |
| Simpler speaker link in bottle (keep the 30-second grant drop) | ~-60 | The specific "token rejected" message and auto-shutdown after 5 minutes without speaker. |
| `bottle doctor` | ~-59 | The preflight command; `init` and `start.sh` check most of the same things. |
| Docker path for speaker | -47 | The hardened container. This is the planned NAS deployment, so probably keep. |
| Require `PROXY_PORT` and `SSH_PORT` | ~-40 | Running speaker without the secrets proxy or jump server. |
| Extension-bundled sites | ~-30 | Site grants ending automatically with their extension. |
| Three-denials lock | ~-25 | Auto-deny for 15 minutes after three denials. |
| Built-in demo service | ~-20 | The no-key demo on a fresh install. |

### The trace export: why it is large, and a slim version

`bottle/src/trace.ts` is 437 lines. About 90 of them write the archive manifest and stay either way. The rest goes to:

- saving each model request and reply as size-capped blobs, with truncation bookkeeping and an allowlist of 23 headers (~105 lines);
- rebuilding tool calls from Pi's session file and pairing each call with its result (~90);
- reassembling streamed replies into finished messages (~25);
- shaping all of it into a linked run tree in the format LangSmith and Phoenix import (~55). That import is unverified.

**Slim version, about 25 lines (decided):** the model door appends one JSON line per model call to `model-calls.jsonl`: time, status, duration, the request body and the raw reply, each cut off at a size cap. It keeps the one thing nothing else records, which is exactly what the model was sent and what it answered. It drops the header capture, the reassembled messages (the raw stream is kept instead), the tool-call records (Pi's session file already has them) and the importable run tree. Net saving about 320 lines instead of 380.

### In-VM MCP and VM-mount delivery, in plain words

- **In-VM MCP servers (`mcp:<id>`).** A catalog entry names an MCP server program already inside the guest image. A task asks for `mcp:<id>`; when you approve, bottle writes it into Pi's MCP config and restarts Pi at its next idle moment, and Pi gains that server's tools. Revoking removes them. The shipped catalog has no entries, so nothing uses this today. Remote MCP servers are unaffected: they are speaker services.
- **VM-mount folder delivery.** Speaker can deliver a `folder:` grant two ways. Over SSH, the sandbox mounts the share with `sshfs` through speaker's jump server, which is what happens today. As a VM mount, a sandbox host that has the folder on its own disk would map it straight into the VM, which is much faster for `grep -r`, `find` and `git status`. bottle always tells speaker it cannot mount, so speaker's VM-mount branch never runs. Cutting it removes the unused branch and closes the door on the fast path until it is rebuilt.

### Not recommended (weakens a security boundary)

- Replacing the filtering SFTP relay with a plain `sftp-server` (~-300): loses share containment, read-only enforcement and per-file logging.
- Dropping the custom Origin check in `admin.ts` (~-14): Hono's CSRF helper only checks form posts.
