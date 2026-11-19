# speaker-for-the-creds

_AI-drafted_

A permission desk for AI agents. One hardened service (speaker) keeps every real API key, token, SSH login and private folder; agents ask it for what they need, the owner approves on a card for a chosen time, and speaker adds the real credential to the request itself, so the agent never holds it. A companion (bottle) runs agents in throwaway virtual machines with no network card, so speaker's grants are all they get.

Why: running many agents against real accounts (notes, home automation, GitHub, servers) normally means handing each one a pile of long-lived keys. Here every use is approved, logged, time-limited and revocable in one click.

**Try it in two minutes** with speaker's built-in `demo` service (no real key needed; reads are open, writes need approval). From the repository root, with [mise](https://mise.jdx.dev) installed:

```sh
mise trust && mise install
mise run init speaker      # choose a password; let it start speaker
```

Open the `PUBLIC_URL` it printed, add `/admin`, and sign in. Then, from the same machine, act as an agent:

```sh
export SPEAKER_URL=http://localhost:3000   # the address init printed
curl -s $SPEAKER_URL/_speaker/enroll.sh | sh -s -- "try the demo" "curl on this machine"
H=@"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header"
curl -s -H "$H" $SPEAKER_URL/demo/check            # open read: "credential":"accepted"
curl -s -H "$H" -H 'Speaker-Wait: 60' --max-time 70 -d '{}' $SPEAKER_URL/demo/note
```

The write waits; a card appears in `/admin`. Approve it and the call completes. Revoke the grant under Active and the same write answers `approval_required` again. A real agent does the same after reading `$SPEAKER_URL/_speaker/help`: tell Claude Code (or any agent with `curl`) to read it and write a note to the demo service.

_Owner's overview goes here._

## What works today

_AI-drafted_

| Outcome | State | Notes |
| --- | --- | --- |
| Approve or deny an agent's request for a chosen time; revoke or extend it later | Done | `/admin`, with approval cards, a log and per-agent counts. |
| Approve from a phone | Interim | The responsive `/admin` page, or Herdr on the phone. |
| Approve from the terminal | Done | The Herdr mod: a docked bar, an inbox, the list of agents and "start an agent". |
| Start a sandboxed agent from a template with a preset bundle of access | Done | `sealed`, `builder`, `trusted` and `cron` templates; groups approved as one card. |
| Use a service (Anthropic, OpenAI, Obsidian, Home Assistant, MCP servers) without seeing its key | Done | Read and write are separate permissions. |
| Use a token (such as GitHub's) without seeing it | Done | Speaker's proxy swaps a placeholder for the real value, only for the hosts the owner chose. |
| SSH commands or a folder on a machine, scoped and revocable | Done | Through a jump server inside speaker. |
| Use a website the owner logged in to by hand | Done | Browser sites: the agent drives a headless Chromium without seeing the login. |
| Ask for more in the middle of a task | Done | The agent waits until the owner decides. |
| Cap what an agent can spend | Partial | Model-request and runtime limits; no money or token budget. |
| Look back at what an agent did | Partial | A log page and per-agent counts; no search or export. |

Ready for supervised use on a private network. Not yet tested for long unattended runs. Before relying on it, check the real upstream URLs, TLS, private routing and the approval flow.

## How it works

_AI-drafted_

1. **Secrets never reach the agent.** Speaker keeps keys encrypted, unlocks them in memory after the owner signs in, and inserts them into each request.
2. **The owner grants everything.** No agent, rule or timer creates or lengthens access. Every grant ends at a set time or at once on revoke, and a speaker restart drops them all.
3. **Enforced in two places.** Speaker checks every call; bottle enforces the same grants inside the VM and reports when each is in force.
4. **Everything is logged.** Calls, SSH commands, file operations and decisions; never keys or request bodies.
5. **Nothing to install for agents.** Plain `curl`, `ssh`, `scp` and `sftp`.

The parts: [speaker](speaker/README.md) holds the keys, shows the cards, proxies APIs and issues grants; its security model is at the end of its README. [bottle](bottle/README.md) runs the Pi coding agent in [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs and enforces speaker's grants. An optional Herdr app mod (`herdr/mods/speaker`) puts the approval inbox in the owner's terminal.

## Getting started

_AI-drafted_

Needs a Linux machine or a Mac with `mise`, Docker (to build the guest image), `setsid` (macOS: `brew install util-linux`) and, on Linux, access to `/dev/kvm`. Optional: `sshd`, for an SSH target to test, and `sshfs`, to mount folders for direct agents (otherwise `sftp` or `scp`).

```sh
mise trust && mise install
mise run init              # both on this machine; or `init speaker` / `init bottle` on separate machines
```

`init` installs both packages and asks what it needs for speaker, then bottle; each question says what it is for and what Enter keeps. It offers to start each and to run a smoke-test agent. The owner password is asked once and reused to unlock speaker and approve the new sandbox host. It needs a real terminal; scripts pass `--yes` and flags (`mise run init speaker -- --help`, `mise run init bottle -- --help`). If speaker's address changes, run `mise run init bottle` again; it keeps the other answers.

Then:

1. Open `PUBLIC_URL/admin` and sign in. Speaker stays locked until the owner does, and again after every restart.
2. In Setup, add what agents may use: services (enter each key), secrets (value, allowed hosts, the variable the agent sees), SSH targets (first add the `authorized_keys` line Setup shows), shares on a target, browser sites.
3. **Direct agent:** give it `SPEAKER_URL` and tell it to read `$SPEAKER_URL/_speaker/help`. Each request appears as a card.
4. **Sandboxed agent:** `mise run bottle run "<prompt>"`. It attaches to Pi's terminal (Ctrl-\ detaches; `-d` starts detached). The template's items arrive as one card, and later `site:`, `secret:` or `folder:` requests as more cards; the agent waits for each. Pi needs a model: `init` asks for an OpenAI-compatible server, or see [hosted models](bottle/README.md#models).
5. **Stop:** `mise run bottle stop <id>` archives the agent. bottle stops itself 10 minutes after its last agent, or at once with `mise run bottle down`. Stop speaker last: a restart drops every grant.

## Where configuration lives

_AI-drafted_

| What | Where | Holds |
| --- | --- | --- |
| How speaker runs | `speaker/.env` (from `speaker/.env.example`) | Ports, `PUBLIC_URL`, `DATA_DIR`, `TRUSTED_PROXY`, browser broker |
| What speaker offers | `/admin` Setup, in the browser | Services, groups, secrets, SSH targets and shares, browser sites. Values go to the encrypted `DATA_DIR/store.json`, the rest to `DATA_DIR/config.json`. A fresh install starts from `speaker/config.example.json`. |
| bottle | `~/.bottle/config.json` (from `bottle/config.example.json`, written by `mise run init bottle`) | Host, ports, speaker's URL, models, launch templates |
| Extensions and in-VM MCP servers | `bottle/catalog.json` in the repository | Must match the guest image built from `bottle/guest/` |
| Guest tools | `bottle/guest/locally-available-tools.md` | One line per tool the image installs |
| Herdr mod (optional) | The mod's Settings, saved in Herdr | Speaker's URL, bottle's control URL, bottle's machine |

Everything else under `DATA_DIR` is speaker's own state: do not edit it by hand. The exception is `config.json`, which speaker reloads live. Git ignores `.env` files, speaker data, `bottle/config.json` and `/personal/`; keep them out of any upload.

## Commands

_AI-drafted_

| Command | Purpose |
| --- | --- |
| `mise run init [speaker \| bottle]` | Guided setup (both on this machine without a name) |
| `mise run install` | Install both packages at the newest releases; the lockfile is left alone |
| `mise run install:locked` | Install exactly the tested set in `pnpm-lock.yaml` |
| `mise run lock` | Move `pnpm-lock.yaml` to the newest releases |
| `mise run check` / `test` / `format` | Typecheck, lint and format-check; run tests; format |
| `mise run speaker` | Run speaker with live reload |
| `mise run speaker:up` | Build and run speaker in its hardened container |
| `mise run bottle run ["<prompt>"] [-d] [-t template] [-m model] [-f path[:rw]]` | Launch a sandboxed agent and attach |
| `mise run bottle ls` / `attach [<id>]` / `stop [<id>]` | List, join or stop and archive agents |
| `mise run bottle templates [--json]` | List launch templates and models |
| `mise run bottle serve` / `down` | Run bottle in the foreground; stop it now (open agents are archived) |
| `mise run bottle register` | Register the sandbox host again; approve it in `/admin` |
| `mise run bottle build bottle-guest` | Build the guest image and load it into microsandbox |
| `mise run bottle:logs` | Follow bottle's log |

Every `mise run bottle <command>` also works as `bottle <command>` once the CLI is on `PATH` (see [bottle's README](bottle/README.md#build-and-run)). `mise run bottle help` lists the commands.
