<!-- author: ai -->

# speaker-for-the-creds

<sub>AI-written</sub>

The owner approves what agents may use from a phone, for a chosen duration.
{.ai}

- [speaker](speaker/README.md) ([design](speaker/DESIGN.md)) stores homelab keys, lets the owner approve what agents may use, proxies APIs, and issues grants.
- [bottle-school](bottle-school/README.md) runs Pi in microsandbox micro-VMs and enforces site, secret, folder, and MCP grants as a speaker sandbox host.

<!-- author: ai -->

## Setup

<sub>AI-written</sub>

Run commands from the repository root. mise pins Node and pnpm; Node runs TypeScript directly without a service build step.
{.ai}

```sh
mise trust
mise install
mise run install
mise run check
mise run test
```

To set up speaker and bottle-school together, run `mise run init` (see "Run everything on one machine"); `mise run init speaker` sets up speaker alone, and speaker's `.env` and owner password come from it. Start speaker later with `mise run speaker`.
{.ai}

Open `PUBLIC_URL/admin`, sign in, configure a service, and test approval and revocation with the demo before adding real credentials. Agents use [the access-and-creds skill](speaker/skill/SKILL.md) to enroll and ask for items. The owner approves each request, item by item, in the browser.
{.ai}

The owner can deploy speaker through [Docker](speaker/README.md#docker--home-server-deployment). The owner must verify the real upstream URL, TLS, private routing, and approval flow. Speaker is a supervised-pilot candidate. bottle-school still needs an end-to-end guest run and host storage quotas before unattended use.
{.ai}

<!-- author: ai -->

## Run everything on one machine

<sub>AI-written</sub>

One Linux machine can run speaker, bottle-school, and a direct agent together. Details live in [speaker/README.md](speaker/README.md) and [bottle-school/README.md](bottle-school/README.md).
{.ai}

1. **Prerequisites.** `mise` (then `mise trust && mise install`), Docker for the guest build, `/dev/kvm` access and `setsid` for the VMs. Optional: `sshd` (an SSH target to test) and `sshfs` (folders for direct agents; without it agents use `sftp` or `scp`).
2. **Run `mise run init`.** It installs both packages, then runs the speaker setup followed by the bottle-school setup, giving bottle-school the URL you chose for speaker. It asks, in order:
   - *speaker*: where its data lives (default `~/.local/share/speaker`), the web, secrets-proxy and SSH ports (3000, 3128, 2222; each must be free), the address agents and VMs use (it offers this machine's LAN address, never `127.0.0.1`, which inside a VM is the VM itself), whether it sits behind a reverse proxy (then open the proxy and SSH ports directly and raise the proxy timeout above 120 s), and the owner password twice. It then offers to start speaker.
   - *bottle-school*: it checks KVM, Docker and 20 GiB free, then asks where it lives (default `~/.local/share/bottle-school`, all private), its control ports (7001/7002), the model server (`host:port`, then pick a model from its list), whether to build the guest image (about 10 GiB, several minutes), and then registers the host and waits while you sign in to speaker's `/admin` (speaker is locked until you do) and approve the sandbox host at the printed link. It ends by offering a smoke-test task and printing what Pi wrote.

   Every question has a flag (`--yes` takes the defaults; see each package's README), so it also runs unattended. After a restart, sign in at `/admin` again; speaker is `locked` (agents get `503 locked`) until you do, and restarting also forgets all agents and grants.
3. **Add what agents can use** under Setup (the Services page): a service (the `demo` service works without a key), a secret (name, value, allowed hosts, variable name; the agent only ever sees a placeholder), an SSH target (put the line Setup shows into that account's `authorized_keys` first, then add it), and a share on that target (`VM mount`, `over SSH`, or both).
4. **Connect a direct agent.** Give it `SPEAKER_URL` and tell it to read `$SPEAKER_URL/skill.md`; its sh steps in `/_speaker/help` enroll it, and each request it makes appears as a card in `/admin`.
5. **Launch a task:** `mise run bottle-cli run --template offline --prompt "..."` (add `--attended` or omit `--prompt` to work at its terminal). A `site:`, `secret:` or `folder:` item shows up in `/admin` as a card; once you approve it the VM can use it, and Revoke stops it within seconds. Model ids carry their provider, as in `local/<id>`. Start bottle-school with `mise run bottle` if init did not leave it running. If you later change speaker's address, run `mise run init bottle-school --force` again.
6. **Stop everything.** `mise run bottle-cli stop <id>` for each task (the archive lands in the output directory and the agent disappears from speaker), then stop `mise run bottle` and speaker with Ctrl-C (or the `kill` commands init printed for the ones it started). Stop speaker last, since its restart drops every grant.

On two machines, run `mise run init speaker` on the server and `mise run init bottle-school` on the sandbox machine.

Pi needs a model endpoint to do any work. `init` asks for an OpenAI-compatible server (a loopback or LAN address and port) and the model to use. To use a hosted model instead, add the provider's key as a speaker secret (allowed host: the provider's API host), list the provider under `hostedProviders` in `config.json` with `credential` set to that secret's name, and launch with `--model <provider>/<model>`. The task then asks for that secret in its first card; the key stays in speaker, and the VM only holds a placeholder that speaker's proxy replaces. A task launched with `--prompt` starts Pi once you approve that card.

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

## Local files and generated artifacts

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle-school configuration. The owner must keep these outside any GitHub upload. The repository ships source, dependency locks, build recipes, and examples. mise installs dependencies and builds the guest.
{.ai}
