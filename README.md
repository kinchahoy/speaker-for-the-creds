<!-- author: ai -->

# speaker-for-the-creds

<sub>AI-written</sub>

This repository lets you approve each use of your API keys, SSH hosts and folders from a phone, for a time you choose.
{.ai}

- [speaker](speaker/README.md) ([design](speaker/DESIGN.md)) holds your keys, shows approval requests, proxies APIs, and issues grants.
- [bottle](bottle/README.md) runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs (virtual machines) and enforces speaker's grants.

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
4. To launch a sandboxed agent, run `mise run bottle run "<prompt>"` (or plain `bottle`, see bottle's README). It attaches you to Pi's terminal; Ctrl-\ detaches and leaves it running, and `-d` starts it detached. Omit the prompt to work with Pi yourself. Each `site:`, `secret:`, or `folder:` item shows up as a card in `/admin`. Add host folders with `-f <path>[:rw]` (read-only at `/input/<name>`, read-write at `/space/<name>`); every template also mounts `~/agent-space` read-write. The `sealed` template asks only for a few extensions and has no network, `builder` (the default) adds packages, public GitHub and web search, and `trusted` adds private GitHub and notes reads. An agent can still request more mid-run, and each request appears as a card. The agent waits silently until you approve; `run` and `ls` print the `/admin` link when something is pending. Once you approve it, the VM can use it. Revoke stops it within seconds. `run` starts bottle in the background when it is not already running, and bottle stops itself 10 minutes after its last agent closes (`idleStopMinutes` in its config).
5. To stop an agent, run `mise run bottle stop <id>` (no id when only one is open). `run` prints the archive folder, and `ls` lists the last finished agents with theirs. The archive lands in the output directory, and the agent disappears from speaker. `mise run bottle down` stops bottle at once; otherwise it stops itself when idle. Stop speaker last, because a speaker restart drops every grant.
{.ai}

If speaker's address changes later, run `mise run init bottle` again; it keeps your other answers.
{.ai}

Pi needs a model server. `init` asks for an OpenAI-compatible one. To use a hosted model instead, see [Hosted model providers](bottle/README.md#hosted-model-providers).
{.ai}

<!-- author: ai -->

## Status

<sub>AI-written</sub>

Ready for supervised use on your own network. bottle runs on macOS once `setsid` is installed (confirmed 2026-11-15). Not yet tested for long unattended runs. Before you rely on it, check the real upstream URL, TLS, private routing, and the approval flow. To run speaker in Docker, see [its README](speaker/README.md#docker-and-home-server-deployment).
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

## Future work

<sub>AI-written</sub>

Ideas, not decided. None is started until the owner says go.

- **Save chosen agents to Atuin threads.** Most bottle runs are throwaway tests, so nothing is pushed automatically. A `bottle thread <id>` command pushes one archived agent's `_control/pi-session.jsonl` to Atuin threads, with `agent.json` (id, name, template, model, closed time) and the launch folder as metadata, and writes `_control/atuin.json` so a second push is caught. The Herdr inbox's Recently finished rows get a **Save to Atuin** button that runs the command on the bottle machine (as Stop does), and show "in Atuin" once saved; `finishedAgents()` reads the marker. Saved agents then appear in Atuin's own Herdr mod (herdr-atuin-threads) beside other agent sessions. About 30 lines. Limits: the inbox lists only the last five finished agents, and Atuin must be installed where bottle runs. Before building: check Atuin's push command and flags, and keep it local-only; uploading transcripts to Atuin's backend is a boundary question for the owner.
- **Model calls to Langfuse.** Every model call already passes the model door and lands in `model-calls.jsonl`, whatever the harness. An exporter run at archive could send them to Langfuse with the agent id as the session. Harness-native OpenTelemetry (Codex, Gemini CLI, Claude Code) adds tool spans but needs new egress from the VM, so it would go through a bottle door.
- **Pre-warmed VM snapshots** for faster launches. A launch takes a few seconds: the VM boots in about 2 s, then Pi loads from a cold disk. microsandbox can restore a full snapshot (memory included) with `Sandbox.restore()` and share unchanged pages with `cowMemory()` (an idle agent holds about 410 MiB). Snapshot once per guest image with a generic Pi already loaded; per agent, restore it, rebind `/work`, `/output`, `/etc/bottle`, launch folders and the door sockets, and write the agent's settings to a file that one always-loaded bottle extension applies (Pi's extension API can set the system prompt, model and tools at runtime). That extension is worth building first on its own, since it also removes most of today's Pi restarts on grants. Open: the agent's token variables would move from Pi's environment to a file. A few hundred lines on a young API; worth it if launches feel slow or memory limits how many agents run.

<!-- author: ai -->

## Local files

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle configuration. Keep these out of any GitHub upload. The repository ships source, dependency locks, build recipes, and examples.
{.ai}
