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

You need a Linux machine with these installed:
{.ai}

- `mise`
- Docker, to build the guest image
- `setsid` and access to `/dev/kvm`, to run the VMs

Optional: `sshd`, so you have an SSH target to test, and `sshfs`, to give direct agents folders. Without `sshfs` they use `sftp` or `scp`.
{.ai}

From the repository root, run:
{.ai}

```sh
mise trust
mise install
mise run init
```

`init` installs both packages, then asks the questions needed to set up speaker and then bottle. It offers to start each and to run a smoke-test task. The owner password is asked once: after speaker starts, `init` signs in with it, and bottle's step reuses it to unlock speaker and approve the new sandbox host. Each question says what it is for and what Enter keeps.
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
   - a share on that target (`VM mount`, `over SSH`, or both)
3. To connect a direct agent, give it `SPEAKER_URL` and tell it to read `$SPEAKER_URL/skill.md`. Each request it makes appears as a card in `/admin`. Approve item by item.
4. To launch a sandboxed task, run `mise run bottle run --template offline --prompt "..."`. Add `--attended`, or omit `--prompt`, to work at its terminal. Each `site:`, `secret:`, or `folder:` item shows up as a card in `/admin`. The `offline` template grants nothing up front, but the agent can still request items mid-task, and each request appears as a card. The task waits silently until you approve; `run` and `ls` print the `/admin` link when something is pending. Once you approve it, the VM can use it. Revoke stops it within seconds. If `init` did not leave bottle running, start it first with `mise run bottle serve`.
5. To stop, run `mise run bottle stop <id>` for each task. `run` prints the archive folder, and `ls` lists the last finished tasks with theirs. The archive lands in the output directory, and the agent disappears from speaker. Then stop bottle and speaker with Ctrl-C, or with the `kill` commands `init` printed. Stop speaker last, because a speaker restart drops every grant.
{.ai}

If speaker's address changes later, run `mise run init bottle` again; it keeps your other answers.
{.ai}

Pi needs a model server. `init` asks for an OpenAI-compatible one. To use a hosted model instead, see [Hosted model providers](bottle/README.md#hosted-model-providers).
{.ai}

<!-- author: ai -->

## Status

<sub>AI-written</sub>

Ready for supervised use on your own network. Not yet tested on macOS or for long unattended runs. Before you rely on it, check the real upstream URL, TLS, private routing, and the approval flow. To run speaker in Docker, see [its README](speaker/README.md#docker-and-home-server-deployment).
{.ai}

<!-- author: ai -->

## Commands

<sub>AI-written</sub>

| Command | Purpose |
| --- | --- |
| `mise run init [speaker \| bottle]` | Guided setup (both on this machine without a name) |
| `mise run install` | Install both packages with pnpm |
| `mise run check` | Typecheck, lint, and format-check both packages |
| `mise run test` | Run both packages' tests |
| `mise run format` | Format both packages |
| `mise run speaker` | Run speaker with live reload |
| `mise run bottle serve` | Run the bottle service |
| `mise run bottle register` | Register the sandbox host again; approve it in speaker |
| `mise run bottle run --template offline` | Launch a sandbox task |
| `mise run bottle ls` | List tasks |
| `mise run bottle attach <id>` | Join Pi in a running guest |
| `mise run bottle stop <id>` | Stop and archive a task |
| `mise run bottle build bottle-guest` | Build the guest image and load it into microsandbox |
| `mise run bottle doctor` | Check this host for bottle's prerequisites |
| `mise run speaker:up` | Build and run speaker in its hardened container |

Every `mise run bottle <command>` also works as plain `bottle <command>` after `pnpm -C bottle link --global` (run `pnpm setup` once first if pnpm's global bin directory is not on your PATH). `mise run bottle help` lists the commands.

<!-- author: ai -->

## Local files

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle configuration. Keep these out of any GitHub upload. The repository ships source, dependency locks, build recipes, and examples.
{.ai}
