<!-- author: ai -->

# Plan: speaker approvals and sandboxed agents inside Herdr

<sub>AI-written, 2026-11-14. Nothing here is built yet.</sub>

Two goals:

1. **Approve in Herdr.** Decide speaker's cards (and later configure speaker) from the Herdr app on the Mac or PC, without switching to the browser.
2. **See and talk to sandboxed agents in Herdr.** Each bottle task (Pi today, other agents later) shows up as an agent in the Herdr app, with its status, and you type to it there.

Decisions already taken with you: owner sign-in is **the password, typed once per Herdr start, kept in memory only**; agents appear by **attaching a terminal through the bottle host** (nothing new inside the VM except status reports). UI scope is open, so the options are laid out below with a recommended order.

## What I found

Verified by reading the installed app's own docs (`~/.config/herdr-app/AGENTS.md`, `herdr.d.ts`), the `hc` and `herdr` CLIs, the Redline mod in `~/code/checkouts/herdr-redline`, and this repo.

**Herdr is two products.**

| | Herdr app (the target) | Herdr TUI (`herdr` 0.9.5) |
| --- | --- | --- |
| Parts | `herdr-app` (the window) + `herdr-core` / `hc` (runs every terminal, survives the window) | one terminal app with its own server |
| Extending it | **mods**: JavaScript (gpui-kit) drawn natively, hot-reloaded from `~/.config/herdr-app/mods/<name>/` | plugins: manifest actions, event hooks, panes that run a command |
| Other machines | `hc machine add <ssh target>` or `--via '<command>'`; `hc` copies itself there | `herdr machine add`, `herdr --machine` |
| Agent status | the program prints OSC 7501 reports (`idle`, `working`, `done`, `blocked`, `error`; blocked has a kind: `permission`, `question`, `auth`) | `herdr pane report-agent` over its socket |

bottle already integrates with the **TUI only** (`bottle/src/cli.ts:173-179`, `:256`, `:318`: it splits a pane and calls `herdr pane report-agent`). None of that reaches the app.

**What a mod can do** (this decides the UI options):

- Draw native UI: lists, inputs, textareas, checkboxes, markdown, popovers. **No HTML and no web view**, so `/admin` cannot be embedded; anything inside Herdr is rebuilt natively.
- Live in several places: a dialog on a key (Redline does this), a docked sidebar or status block, a floating block, a **pane beside a terminal** (`pane.split {mod, props}`), a whole tab.
- `fetch` URLs, run programs **on any machine** (`exec(cmd, args, {on: machine})`, 30 s limit, rides hc's ssh link), read files there, post toasts whose click runs a command (`notify({action})`), keep shared state.
- Know every space, tab, pane, terminal and agent, focus one (`agent.focus`), start one (`tab.new {argv, task}`).
- Mods are trusted code on the machine showing the window. Shipped layouts are read-only, so an always-visible badge needs a docked `mod.json` placement or a floating block (Redline hit this: a kept overlay window blocks clicks).

**How a terminal becomes visible in the app:** any core terminal carrying the labels `herdr.space=<id>` and `herdr.tab=<id>` shows up there, on its machine, even one started from a script: `hc run --label herdr.space=… --label herdr.tab=… -- <cmd>`. An unknown id becomes a new space or tab. Machines added with `--temp` are hidden from the app's spaces.

**Speaker today:** the owner side is HTML forms behind a cookie session with same-origin checks (`speaker/admin.ts`); there is **no owner JSON API**. Pending cards and the locked state already go out as ntfy pushes. bottle's control API (`/api/state`, `/api/tasks`) has no login and listens on a private address.

## The shape I recommend

```
 Mac / PC                         always-on box            bottle host (mi60, NUC, WSL, or the Mac)
┌──────────────────────────┐     ┌──────────────────┐     ┌───────────────────────────────────────┐
│ Herdr app                │     │ speaker          │     │ herdr-core (hc), pushed over ssh      │
│  mod "speaker"           │────▶│  /admin (as now) │     │  terminal: `bottle attach <task>`  ───┼─▶ VM: dtach ─ Pi
│   inbox · active · badge │HTTPS│  /admin/api  NEW │◀────│ bottle serve (WebSocket, as now)      │
│  agents list, panes      │     └──────────────────┘     └───────────────────────────────────────┘
│  herdr-core (hc) ────────┼───────────── ssh (hc machine) ───────────▲
└──────────────────────────┘
```

- The mod talks to **speaker directly over HTTP(S)** for approvals, and to **bottle through `exec(..., {on})`**, so bottle's control API stays private and nothing new listens anywhere.
- Remote setup stays small: speaker gets new routes only; the bottle host needs `bottle` on `PATH` and `hc`, which the Mac installs over ssh with `hc machine add <host> --install`.

| Your model | Speaker | bottle host as a Herdr machine | Notes |
| --- | --- | --- | --- |
| 1: all on the MacBook | `localhost` | this machine, no `hc machine` needed | Blocked on bottle running on macOS at all (README: not yet verified). |
| 2: always-on box + mi60 / NUC | LAN or tailnet URL | `hc machine add mi60` | The always-on box needs no hc. |
| 2 with bottle in WSL on the desktop | same | from Windows Herdr: `hc machine add --via 'wsl.exe -d Ubuntu -e sh -c' --name wsl`; from the Mac: ssh to WSL | |

## Part A: approvals in Herdr

### Options

| | What you get | Speaker changes | Cost | Weakness |
| --- | --- | --- | --- | --- |
| **A0. Notify, decide in browser** | A toast (and sound) in Herdr when a card arrives; click opens `/admin` in the browser. A tiny mod subscribes to the ntfy topic speaker already posts to. | none | an evening | Not "inside Herdr"; needs ntfy configured. |
| **A1. Native panel (mod)** | Inbox and Active as a Herdr dialog, a pending badge, toasts that open the card, and a card pane beside the agent that is asking. | owner JSON API | the main work | Native UI must be rebuilt per page; Setup is a lot of forms. |
| **A2. Terminal UI** | `speaker tui` in any pane: Herdr app, Herdr TUI (as a plugin pane), plain ssh, a phone ssh client. It can report `blocked` over OSC 7501 while cards wait, so Herdr's own attention sound and toast fire with no mod at all. | owner JSON API | medium; one TUI library to choose (Ink fits the TypeScript repo; ask first) | Any agent with `hc send`/`hc keys` on that machine can type into a terminal, so a local agent could press Approve. Fine on a box with only sandboxed agents, poor on a Mac full of direct agents. |
| **A3. Setup in Herdr** | Services, secrets, targets, shares and groups edited from the panel. | owner API grows setup routes | large | Mostly forms; low daily value compared to Inbox. |

**Recommendation:** build the **owner JSON API once**, since A1, A2 and A3 all stand on it. Then A1 as the main UI. Keep A0's toast as the notification layer of A1 (fed by the API instead of ntfy once signed in). Treat A2 as optional, worth it mainly if you want the TUI Herdr or ssh-only access. Do Setup last and partially: lists you edit often (groups, services, shares) natively; a "Open Setup in browser" button for the rest.

### The owner JSON API (speaker)

A sibling of the form handlers in `admin.ts`, calling the same core functions, so behaviour cannot drift:

- `POST /admin/api/signin {password}` → a bearer session token. Same rate limit and same in-memory `sessions` map as the cookie; it also unlocks speaker after a restart, exactly as signing in to `/admin` does. Bearer only, never the cookie, so no CSRF surface is added.
- `GET /admin/api/view?h=<hash>` → the same data `view()` gives the Inbox and Active panels (requests with per-item rows, pending hosts, agents, grants, sessions, locked state). Held until it changes, like `Speaker-Wait`, so the mod needs no fast polling.
- `POST /admin/api/requests/<id>/decide {approve: [items], duration}`; `POST …/grants/<id>/extend|revoke`; `POST …/agents/<id>/revoke`; `POST …/hosts/<id>/approve|remove`; `POST …/sessions/<id>/end`.
- Errors in the existing `errorBody` shape. Everything audited as today.

This changes one sentence in `DESIGN.md` ("Approval happens only in `/admin`… HTML forms only"): approval stays behind the owner's password, but a second client exists.

### The mod (`speaker`)

One mod folder, kept in this repo (for example `herdr/mods/speaker/` with a `RECIPE.md`), copied into `~/.config/herdr-app/mods/` by a mise task. Roles picked from its props, as Redline does:

- **Panel** (a key, say `cmd-shift-a`): Inbox and Active tabs. Cards match `/admin`: label, agent claim, source address, reason, duration picker, a checkbox per group and item, write-tinted rows for `.full`, `:rw`, `ssh:` and secrets, **Approve** grants what is ticked. Active: grants with time left, Extend, Revoke, End session, Revoke agent. A **Go to agent** button focuses the agent's terminal when it is a bottle task Herdr can see.
- **Badge**: a small docked or floating block with the pending count; click opens the panel. Renders nothing at zero.
- **Agent card pane**: `pane.split {mod: "speaker", props: {task}}` beside a sandboxed agent shows only that agent's pending cards and grants, so you approve next to the conversation.
- **Toasts**: a new card posts `notify` with an action that opens the panel on that card.
- **Session states**, as one explicit table in the mod: `unreachable`, `unset`, `locked`, `signed-out`, `signed-in`. The password field shows in `locked` and `signed-out`; the token lives in a variable, never in `shared`, `localStorage` or a file. Over plain HTTP from another machine the mod repeats `/admin`'s warning that the password crosses the network in clear.
- Speaker's URL is typed once and kept in `shared` (not a secret). UI follows `~/code/workshop/mostly-impeccable/design-craft-lite.md` and Herdr's theme colours.

### Security notes

- Sandboxed agents cannot touch any of this: they have no route to the Mac, the mod or the owner API's token.
- **Direct agents running as you on the same Mac can.** They can edit the mod's files (hot reload), and could read anything stored on disk. `DESIGN.md` already says a single machine "protects against accidents… not against a hostile agent running as the owner"; the mod keeps that level and does not lower it, provided the token stays in memory and Approve is never exposed as a mod key-command (`herdr-app do speaker.approve` must not exist).
- Next steps for stronger sign-in, in rising effort:
  1. An **approvals-only device token** (cannot open Setup or read keys), bound to the source address, with idle expiry.
  2. That token in the **OS keystore**. Caveat: stored through the `security` CLI, any process running as you can read it back without a prompt; it only helps if a small signed helper owns the item with a user-presence rule (Touch ID per unlock).
  3. **Risk tiers**: read-only items approvable in Herdr; write-tinted items (`ssh:`, `.full`, `:rw`, secrets) need the phone or browser.
  4. Passkey (WebAuthn) sign-in for `/admin` itself, which removes the password from the network.

## Part B: sandboxed agents in Herdr

Chosen path: **the attach terminal runs on the bottle host under herdr-core.** The VM stays network-less with the same doors.

1. **A terminal per task.** When a task launches, bottle (the service, if `herdr` is enabled in `config.json` and `hc` is on `PATH`) runs
   `hc run --bg --name pi-<id> --label herdr.space=bottle --label herdr.tab=<id> --label bottle.task=<id> -- bottle attach <id>`.
   The labels make Herdr show a **bottle** space on that machine with one tab per task, however the task was started (CLI, cron, later the mod). When the task archives, `attach` exits and the pane closes.
   Alternative: the mod creates the tab (`tab.new {argv}`) when it sees a new task in `bottle ls --json`. That needs no bottle change but only works while the app is open; I prefer bottle doing it.
2. **Status over OSC 7501.** A small always-on guest extension (next to `reply.ts`) writes the report to Pi's terminal; it passes through dtach and `msb exec -t` to the hc terminal:
   - `working` / `idle` from Pi's own events, `done` when `/output/DONE` exists;
   - `blocked`, kind `permission`, while `/work/.speaker/pending.json` holds a request, with the items in `msg`. Herdr then plays its sound, marks the space, and its toast jumps to the agent, where the card pane is one click away.
   Alternative: `bottle attach` emits the reports on the host from the task state it already polls. That is agent-agnostic, but it must write into a raw terminal stream it does not own (today the child has `stdio: inherit`), so it needs a pty proxy and a new dependency.
3. **Talking to it.** Type in the pane; `hc send pi-<id> "…"` works for scripts and other agents. Unattended tasks are attachable the same way.
4. **Starting one from Herdr.** Add `bottle run --attach` (launch, then attach in the foreground). A `programs.json` entry `{"pi-sandbox": {"name": "Pi (sandbox)", "run": ["bottle", "run", "--attach"]}}` then puts it in Herdr's + menu on any machine that has bottle, with the first message as `--prompt`. Later the mod can offer a template picker.
5. **Linking speaker and Herdr.** Speaker's view already carries sandbox host and task id per agent; the terminal carries `bottle.task=<id>`. That is the join for "Go to agent" and for the agent card pane. Direct agents (Claude Code in a Herdr pane) could optionally send `$HC_TERMINAL_ID` at enrollment, shown as a claim; not needed for v1.
6. **bottle additions:** `bottle ls --json`, `bottle run --attach`, the hc launch hook, the guest status extension. The TUI-Herdr code in `cli.ts` stays as it is.

**Parked alternative: herdr-core inside each VM** (`hc machine add --via 'msb exec … sh -c' --temp`). It would give Herdr file and exec access inside the sandbox and sub-agents there, but the app hides temporary machines' spaces today, and it adds a binary plus a control channel into an otherwise sealed guest. Revisit only if you want to browse `/work` from Herdr's Files panel.

**Other agents in the sandbox** (Claude Code, Codex): this path only needs "runs under dtach and reports 7501", so Herdr is not the obstacle; bottle's Pi-specific launch and restart logic (`pi.ts`) is. Out of scope here.

**Herdr TUI:** keeps today's integration. If you want approvals there too, A2 is the answer (a plugin pane running `speaker tui`). I have not read the TUI plugin manifest format yet.

## Order of work

| Step | What | Size | Proves |
| --- | --- | --- | --- |
| 0 | **Spikes**: (a) the exact OSC 7501 text, and whether Pi already emits it through dtach and `msb exec -t`; (b) a labelled `hc run` on a remote machine appears as a tab in the app and closes cleanly; (c) a mod's `fetch` can POST JSON with an `Authorization` header and hold a long poll; (d) terminal resize through dtach | half a day | every assumption marked below |
| 1 | **Agents visible**: `bottle run --attach`, `bottle ls --json`, hc launch hook, guest status extension, `programs.json` entry | small | Part B end to end |
| 2 | **Owner JSON API** in speaker, with tests beside `proxy.test.ts` | medium | A1, A2, A3 unblocked |
| 3 | **Mod v1**: sign-in, Inbox, toasts, badge | medium | approve without the browser |
| 4 | **Mod v2**: Active tab, agent card pane, Go to agent | medium | the two halves joined |
| 5 | Pick from: Setup in the mod (A3), `speaker tui` (A2), approvals-only token and keystore, template picker | each separate | |

Step 1 is independent of 2 to 4, and A0 can ship any time as a stopgap.

## Not yet verified

- The OSC 7501 wire format. The core binary shows a capability query (`ESC ] 7501 ; ? : states=… : kinds=…`) and the fields `state`, `kind`, `msg`, `title`, `app`, `progress`; I have not seen a full example. Herdr lists `pi` as an agent that reports, but not whether that is Pi itself or an extension.
- A mod's `fetch`: methods, headers and how long a request may hang. If it is limited, `exec("curl", …)` with the 30 s cap is the fallback (short polls instead of a held call).
- How a labelled terminal behaves when its program exits on a remote machine, and whether "adoption enables keep" leaves a shell behind on the bottle host.
- bottle on macOS (model 1) and nested reach from the Mac to WSL.

## Questions for you

1. **Blocked or not?** A pending speaker request does not actually stop Pi (`request_capability` returns at once). Should it still show as `blocked` in Herdr (loud: sound, toast, top of the list), or as `working` with only the speaker badge counting it?
2. **Who makes the tab**: bottle at launch (always there, needs `hc` on the bottle host) or the mod (no bottle change, only while the app is open)?
3. **One "bottle" space per machine with a tab per task**, or a space per task?
4. Do you want **A0 first** as a stopgap, or go straight to the API and mod?
5. Is **Herdr TUI** worth real effort, or is keeping today's integration enough? That decides whether A2 is built.
6. Where should the mod live: in this repo (`herdr/mods/speaker/`), or its own repo so it can be listed at herdr.dev/mods?
7. `bottle` vs `bottle-school`: the folder `bottle-school/` exists but holds only `node_modules`. Is a rename under way that this plan should follow?
