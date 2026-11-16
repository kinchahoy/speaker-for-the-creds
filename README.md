<!-- author: ai -->

# speaker-for-the-creds

<sub>AI-written</sub>

A personal permission desk for AI agents. The owner keeps every real key, SSH login and private folder in one hardened service (speaker). Agents never hold them. They run in throwaway virtual machines with no network card (bottle), and ask for what they need: a website, an API, a folder, a host. The owner sees a card, picks how long to allow it, and can revoke or extend it at any time. Speaker adds the real credential to the request itself, so an agent can use a key without ever seeing it.
{.ai}

It is built for one technically fluent person who wants to run many agents against a real life (notes, to-dos, home automation, GitHub) without handing them a pile of keys. The goal it steers toward is a to-do list kept by an agent that wakes about every 3 hours, with back-and-forth from the owner's phone, updating the owner's iOS Reminders through Home Assistant. Everything else here is a step toward that.
{.ai}

<!-- author: ai -->

## What you get today

<sub>AI-written</sub>

Done, partial or not yet, from the point of view of the owner.
{.ai}

| Outcome | State | Notes |
| --- | --- | --- |
| Approve or deny an agent's request, for a time you choose, and revoke or extend it later | Done | The `/admin` page, with approval cards, a log and per-agent counts. |
| Approve from the phone | Interim | Herdr on the phone plus the responsive `/admin` page work today. A native app or push notification is later work, not missing work. |
| Approve from inside the terminal workflow | Done | The Herdr mod: a docked bar, an inbox, a list of agents and a "start an agent" action. |
| Start a sandboxed agent from a template, with a preset bundle of access | Done | `sealed`, `builder`, `trusted` and `cron` templates; groups of items approved as one. |
| Let an agent use a service (Anthropic, OpenAI, Karakeep, Obsidian, Home Assistant, MCP servers) without seeing its key | Done | Read and write are separate permissions. |
| Let an agent use a token (such as GitHub) without seeing it | Done | Speaker's proxy swaps a placeholder for the real value, only for the hosts the owner chose. |
| Give an agent SSH commands or a folder on a machine, scoped and revocable | Done | Through a jump server inside speaker. |
| Agents ask for more in the middle of a task | Done | The agent waits until the owner decides. |
| Cap what an agent can spend | Partial | Limits on model requests and runtime hours, but no money or token budget. |
| Look back at what an agent did with a key | Partial | A log page and per-agent counts. No search or export. |
| An agent that wakes every few hours and works a to-do list | Not yet | A `cron` template starts an agent that schedules its own wakes, for up to a week. Nothing yet ties it to Home Assistant or iOS Reminders. |
| One recorded end-to-end pass on real endpoints (ask, approve, call, revoke) | Not yet | The checks are written down in [the design doc](speaker/DESIGN.md#verifying-end-to-end); no run is recorded. |
{.ai}

Ready for supervised use on your own network. bottle runs on macOS once `setsid` is installed (confirmed 2026-11-15). Not yet tested for long unattended runs. Before relying on it, check the real upstream URL, TLS, private routing and the approval flow.
{.ai}

<!-- author: ai -->

## How it works

<sub>AI-written</sub>

What the design promises, in order of importance:
{.ai}

1. **Secrets never reach the agent.** The sandbox has no network card, only a few narrow channels to the host. Speaker keeps keys encrypted, unlocks them in memory after the owner signs in, and inserts them into the request itself.
2. **The owner grants everything.** No agent, rule or timer creates or lengthens access. Every grant has an end time, ends at once on revoke, and a speaker restart drops them all.
3. **Enforced in two places.** Speaker checks every call, and the sandbox host enforces the same grants inside the VM. Speaker shows a grant as "not yet confirmed in force" until the sandbox host reports it.
4. **Everything is logged.** Calls, SSH commands, file operations and decisions; never keys or request bodies.
5. **Nothing to install for agents.** Plain `curl`, `ssh`, `scp` and `sftp`.

Two programs and a Herdr mod make it up. [speaker](speaker/README.md) holds the keys, shows the approval cards, proxies APIs and issues grants. [bottle](bottle/README.md) runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs and enforces speaker's grants. A Herdr app mod in `herdr/mods/speaker` puts the approval inbox in the owner's terminal. The full design, with what is built and what is only planned, is in [speaker/DESIGN.md](speaker/DESIGN.md).
{.ai}

<!-- author: ai -->

## Getting started

<sub>AI-written</sub>

You need a Linux machine or a Mac with these installed:
{.ai}

- `mise`
- Docker, to build the guest image
- `setsid` (on macOS: `brew install util-linux`), and on Linux access to `/dev/kvm`, to run the VMs

Optional: `sshd`, so you have an SSH target to test, and `sshfs`, to give direct agents folders. Without `sshfs` they use `sftp` or `scp`.
{.ai}

From the repository root, run:
{.ai}

```sh
mise trust
mise install
mise run init
```

`init` installs both packages, then asks the questions needed to set up speaker and then bottle. It offers to start each and to run a smoke-test agent. The owner password is asked once: after speaker starts, `init` signs in with it, and bottle's step reuses it to unlock speaker and approve the new sandbox host. Each question says what it is for and what Enter keeps.
{.ai}

`init` needs a real terminal. For scripts, pass `--yes` and flags instead. `mise run init -- --help` lists them (the `--` stops mise from taking `--help` itself), and so do `mise run init speaker -- --help` and `mise run init bottle -- --help`. Each package README shows an example.
{.ai}

To use two machines, run `mise run init speaker` on the server and `mise run init bottle` on the sandbox machine. To set up only one, name it the same way.
{.ai}

Then:
{.ai}

1. Open `PUBLIC_URL/admin` and sign in. Speaker stays locked until you do, and again after every restart.
2. To add what agents can use, go to the Services page under Setup and add any of these:
   - a service (the `demo` service works without a key; start there to try approval and revocation)
   - a secret: a name, a value, the hosts it may reach, and a variable name (the agent only sees a placeholder)
   - an SSH target: first put the line Setup shows into that account's `authorized_keys`
   - a share on that target (it arrives over SSH)
3. To connect a direct agent, give it `SPEAKER_URL` and tell it to read `$SPEAKER_URL/_speaker/help`. Each request it makes appears as a card in `/admin`. Approve item by item.
4. To launch a sandboxed agent, run `mise run bottle run "<prompt>"` (or plain `bottle`; see [bottle's README](bottle/README.md#build-and-run)). It attaches to Pi's terminal; Ctrl-\ detaches and leaves it running, and `-d` starts it detached. Each `site:`, `secret:`, or `folder:` item shows up as a card in `/admin`, and the agent waits until the owner approves. Revoking stops access within seconds. Templates (`sealed`, `builder`, `trusted`, `cron`) and the `-f` folder flag are described in bottle's README.
5. To stop an agent, run `mise run bottle stop <id>`. The archive lands in the output directory and the agent disappears from speaker. bottle stops itself 10 minutes after its last agent closes, or at once with `mise run bottle down`. Stop speaker last, because a speaker restart drops every grant.
{.ai}

If speaker's address changes later, run `mise run init bottle` again; it keeps your other answers.
{.ai}

Pi needs a model server. `init` asks for an OpenAI-compatible one. To use a hosted model instead, see [Hosted model providers](bottle/README.md#hosted-model-providers).
{.ai}

<!-- author: ai -->

## Commands

<sub>AI-written</sub>

| Command | Purpose |
| --- | --- |
| `mise run init [speaker \| bottle]` | Guided setup (both on this machine without a name) |
| `mise run install` | Install both packages (one pnpm workspace) at the newest releases; the lockfile is left alone |
| `mise run install:locked` | Install exactly the tested set in `pnpm-lock.yaml` |
| `mise run lock` | Move `pnpm-lock.yaml` to the newest releases, after they pass the tests |
| `mise run check` | Typecheck, lint, and format-check both packages |
| `mise run test` | Run both packages' tests |
| `mise run format` | Format both packages |
| `mise run speaker` | Run speaker with live reload |
| `mise run bottle serve` | Run the bottle service in the foreground |
| `mise run bottle down` | Stop bottle now; its open agents are archived first |
| `mise run bottle:logs` | Follow bottle's log |
| `mise run bottle register` | Register the sandbox host again; approve it in speaker |
| `mise run bottle run ["<prompt>"] [-d] [-t template] [-m model] [-f path[:rw]]` | Launch a sandbox agent and attach (`-d`: detached); `-m` takes a model id or alias; `-f` mounts a host folder |
| `mise run bottle templates [--json]` | List the launch templates and models (aliases, local model up or down) |
| `mise run bottle ls` | List agents |
| `mise run bottle attach [<id>]` | Join Pi in a running guest |
| `mise run bottle stop [<id>]` | Stop and archive an agent |
| `mise run bottle build bottle-guest` | Build the guest image and load it into microsandbox |
| `mise run speaker:up` | Build and run speaker in its hardened container |

Every `mise run bottle <command>` also works as plain `bottle <command>` once the CLI is on `PATH`: `mise run init bottle` offers to link it into `~/.local/bin`, and it needs a global Node (`mise use -g node@latest`; see [bottle's README](bottle/README.md#build-and-run)). `mise run bottle help` lists the commands.

<!-- author: ai -->

## Side tracks and explorations

<sub>AI-written</sub>

These are kept on purpose and are not the current focus. None is started until the owner says go.

- **Save chosen agents to Atuin threads.** Most bottle runs are throwaway tests, so nothing is pushed automatically. A `bottle thread <id>` command pushes one archived agent's `_control/pi-session.jsonl` to Atuin threads, with `agent.json` (id, name, template, model, closed time) and the launch folder as metadata, and writes `_control/atuin.json` so a second push is caught. The Herdr inbox's Recently finished rows get a **Save to Atuin** button that runs the command on the bottle machine (as Stop does), and show "in Atuin" once saved; `finishedAgents()` reads the marker. Saved agents then appear in Atuin's own Herdr mod (herdr-atuin-threads) beside other agent sessions. About 30 lines. Limits: the inbox lists only the last five finished agents, and Atuin must be installed where bottle runs. Before building: check Atuin's push command and flags, and keep it local-only; uploading transcripts to Atuin's backend is a boundary question for the owner.
- **Model calls to Langfuse.** Every model call already passes the model door and lands in `model-calls.jsonl`, whatever the harness. An exporter run at archive could send them to Langfuse with the agent id as the session. Harness-native OpenTelemetry (Codex, Gemini CLI, Claude Code) adds tool spans but needs new egress from the VM, so it would go through a bottle door.
- **Pre-warmed VM snapshots** for faster launches. A launch takes a few seconds: the VM boots in about 2 s, then Pi loads from a cold disk. microsandbox can restore a full snapshot (memory included) with `Sandbox.restore()` and share unchanged pages with `cowMemory()` (an idle agent holds about 410 MiB). Snapshot once per guest image with a generic Pi already loaded; per agent, restore it, rebind `/work`, `/output`, `/etc/bottle`, launch folders and the door sockets, and write the agent's settings to a file that one always-loaded bottle extension applies (Pi's extension API can set the system prompt, model and tools at runtime). That extension is worth building first on its own, since it also removes most of today's Pi restarts on grants. Open: the agent's token variables would move from Pi's environment to a file. A few hundred lines on a young API; worth it if launches feel slow or memory limits how many agents run.
- **Pi packages to try when a real problem shows up.** Neither is installed, and nothing so far shows the problem it solves. `pi-tool-repair` repairs malformed tool calls from open models (DeepSeek, Qwen, Kimi) before Pi validates them, with no extra model call: worth a trial if agents start failing turns on bad tool arguments. `@sting8k/pi-vcc` compacts the conversation by extraction instead of a model call and adds a `vcc_recall` tool to search what was compacted away: worth a trial if compaction eats the request budget or stalls a local model. Both are young, and their benefit claims are the authors' own. A package that brings tools needs them added to the `--tools` allowlist in `bottle/src/pi.ts`.
- **Signal channels for agents (planned, not built).** This is one candidate for the phone back-and-forth the project is heading toward; the interim path is Herdr plus the responsive web admin. A bot with its own Signal account (the owner's Google Voice number, registered through `signal-cli`, with a registration lock PIN) and two predefined groups holding only the owner and the bot: Tasks (updates from, and replies or new todos for, one long-lived agent) and Routine (results from cron-style agents; post only at first). It runs as its own compose project beside speaker on a private Docker network: `signal-cli-rest-api` holds the bot's keys, and a small wrapper in front of it is the only thing speaker can reach. The wrapper fixes the groups in its config, so an agent never names a recipient; it accepts only the owner's messages, caps length and rate, and has no history operation. A reply is handed to a reader once and then dropped; when no agent has polled a group for a few minutes the message is not kept and the bot answers that nobody is listening, so a new agent never sees an earlier one's messages. Each group is one speaker service (`signal-tasks`, `signal-routine`) that the owner grants per agent; no template holds one. If the owner's Signal identity changes, the wrapper stops until the bot is registered again. Not in the first version: an Urgent group, disappearing messages, attachments, reactions, several readers on one group. Open: whether `signal-cli-rest-api` is maintained and what its group and receive endpoints look like now.

<!-- author: ai -->

## Local files

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle configuration. Keep these out of any GitHub upload. The repository ships source, dependency locks, build recipes, and examples.
{.ai}
