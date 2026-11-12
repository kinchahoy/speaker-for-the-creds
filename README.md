<!-- author: ai -->

# speaker-for-the-creds

<sub>AI-written</sub>

This repository lets you approve each use of your API keys, SSH hosts and folders from a phone, for a time you choose.
{.ai}

- [speaker](speaker/README.md) ([design](speaker/DESIGN.md)) holds your keys, shows approval requests, proxies APIs, and issues grants.
- [bottle-school](bottle-school/README.md) runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs (virtual machines) and enforces speaker's grants.

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

`init` installs both packages, then asks the questions needed to set up speaker and then bottle-school. It offers to start each and to run a smoke-test task. Every question has a flag, and `--yes` takes the defaults, so it also runs unattended. Each package README lists the flags.
{.ai}

To use two machines, run `mise run init speaker` on the server and `mise run init bottle-school` on the sandbox machine. To set up only one, name it the same way.
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
4. To launch a sandboxed task, run `mise run bottle-cli run --template offline --prompt "..."`. Add `--attended`, or omit `--prompt`, to work at its terminal. Each `site:`, `secret:`, or `folder:` item shows up as a card in `/admin`. Once you approve it, the VM can use it. Revoke stops it within seconds. If `init` did not leave bottle-school running, start it first with `mise run bottle`.
5. To stop, run `mise run bottle-cli stop <id>` for each task. The archive lands in the output directory, and the agent disappears from speaker. Then stop bottle-school and speaker with Ctrl-C, or with the `kill` commands `init` printed. Stop speaker last, because a speaker restart drops every grant.
{.ai}

If speaker's address changes later, run `mise run init bottle-school --force`.
{.ai}

Pi needs a model server. `init` asks for an OpenAI-compatible one. To use a hosted model instead, see [Hosted model providers](bottle-school/README.md#hosted-model-providers).
{.ai}

<!-- author: ai -->

## Status

<sub>AI-written</sub>

Speaker is a candidate for supervised pilots. Before you rely on it, check the real upstream URL, TLS, private routing, and the approval flow. bottle-school still needs an end-to-end guest run and host storage quotas before unattended use. To run speaker in Docker, see [its README](speaker/README.md#docker-and-home-server-deployment).
{.ai}

<!-- author: ai -->

## Commands

<sub>AI-written</sub>

| Command | Purpose |
| --- | --- |
| `mise run init [speaker \| bottle-school]` | Guided setup (both on this machine without a name) |
| `mise run install` | Install both packages with pnpm |
| `mise run check` | Typecheck both packages and lint speaker |
| `mise run test` | Run both packages' tests |
| `mise run format` | Format speaker |
| `mise run speaker` | Run speaker with live reload |
| `mise run bottle` | Run the bottle-school service |
| `mise run bottle-cli register` | Register the sandbox host again; approve it in speaker |
| `mise run bottle-cli run --template offline` | Launch a sandbox task |
| `mise run bottle-cli ls` | List tasks |
| `mise run bottle-cli attach <id>` | Join Pi in a running guest |
| `mise run bottle-cli stop <id>` | Stop and archive a task |
| `mise run guest-build pi-v5-guest` | Build the guest image and load it into microsandbox |

<!-- author: ai -->

## Local files

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle-school configuration. Keep these out of any GitHub upload. The repository ships source, dependency locks, build recipes, and examples.
{.ai}
