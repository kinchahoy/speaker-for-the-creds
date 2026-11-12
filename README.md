<!-- author: ai -->

# speaker-for-the-creds

<sub>AI-written</sub>

The owner approves what agents may use from a phone, for a chosen duration.
{.ai}

- [speaker](speaker/README.md) stores homelab keys, lets the owner approve what agents may use, proxies APIs, and issues grants.
- [bottle-school](bottle-school/README.md) runs Pi in Gondolin micro-VMs and enforces site, secret, folder, and MCP grants as a speaker sandbox host.

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

For speaker, copy `speaker/.env.example` to `speaker/.env`, set the browser-facing `PUBLIC_URL`, then start the service and set the owner password on your first visit to `/admin`:
{.ai}

```sh
cp speaker/.env.example speaker/.env
chmod 600 speaker/.env
mise run speaker
```

Open `PUBLIC_URL/admin`, configure a service, and test approval and revocation with the demo before adding real credentials. Agents use [the access-and-creds skill](speaker/skill/SKILL.md) to enroll and ask for items. The owner approves each request, item by item, in the browser.
{.ai}

The owner can deploy speaker through [Docker](speaker/README.md#docker--home-server-deployment). The owner must verify the real upstream URL, TLS, private routing, and approval flow. Speaker is a supervised-pilot candidate. bottle-school still needs an end-to-end guest run and host storage quotas before unattended use.
{.ai}

<!-- author: ai -->

## Run everything on one machine

<sub>AI-written</sub>

One Linux machine can run speaker, bottle-school, and a direct agent together. These steps were run end to end on Linux x86_64 with QEMU; details live in [speaker/README.md](speaker/README.md) and [bottle-school/README.md](bottle-school/README.md).
{.ai}

1. **Prerequisites.** `mise` (then `mise install && mise run install`), Docker for the guest build, `/dev/kvm` access, and `qemu-system-x86`, `qemu-utils` and `setsid` for the VMs (`mise run doctor` checks them). Optional: `sshd` (an SSH target to test) and `sshfs` (folders for direct agents; without it agents use `sftp` or `scp`).
2. **Configure speaker.** In `speaker/.env` set `DATA_DIR`, `PORT`, `PUBLIC_URL` (for example `http://127.0.0.1:3000`), `PROXY_PORT` (secrets proxy) and `SSH_PORT` (jump server). Start it with `mise run speaker`.
3. **Set the owner password.** Open `PUBLIC_URL/admin`; the first visit asks for a password. After every restart speaker is `locked` (agents get `503 locked`) until you sign in at `/admin`, and restarting also forgets all agents and grants.
4. **Add what agents can use** under Setup (the Services page): a service (the `demo` service works without a key), a secret (name, value, allowed hosts, variable name; the agent only ever sees a placeholder), an SSH target (put the line Setup shows into that account's `authorized_keys` first, then add it), and a share on that target (`VM mount`, `over SSH`, or both).
5. **Connect a direct agent.** Give it `SPEAKER_URL` and tell it to read `$SPEAKER_URL/skill.md`; its sh steps in `/_speaker/help` enroll it, and each request it makes appears as a card in `/admin`.
6. **Configure bottle-school.** Copy `bottle-school/.env.example` to `bottle-school/.env` and set `SPEAKER_URL`, `SPEAKER_PROXY_PORT` (speaker's `PROXY_PORT`) and the model (`LLM_UPSTREAM`, `LLM_MODEL`), then `mise run setup`. `SPEAKER_URL` must be an address the VM can reach: use the machine's LAN address (for example `http://192.168.1.10:3000`), not `127.0.0.1`, which inside a VM is the VM itself. To use a different guest image tag or ports, edit `bottle-school/config.json`.
7. **Build the guest image:** `mise run guest-build pi-v5-guest` (about 10 GiB and several minutes; the tag must match `guestImage` in `config.json`). One build serves both backends: it imports the image into Gondolin and loads it into microsandbox.
8. **Register and approve the sandbox host.** `mise run bottle-cli register`, then approve the pending sandbox host in speaker's `/admin`. If you later change `SPEAKER_URL`, remove the old host in `/admin`, delete `speaker.token` from the state directory (under `BOTTLE_HOME`, default `~/.local/share/bottle-school/state`) and register again.
9. **Start bottle-school:** `mise run bottle`. It prints `speaker connected`.
10. **Launch a task:** `mise run bottle-cli run --template offline --prompt "..."` (add `--attended` or omit `--prompt` to work at its terminal). A `site:`, `secret:` or `folder:` item shows up in `/admin` as a card; once you approve it the VM can use it, and Revoke stops it within seconds. Model ids carry their provider, as in `local/<id>`.
11. **Stop everything.** `mise run bottle-cli stop <id>` for each task (the archive lands in the output directory and the agent disappears from speaker), then stop `mise run bottle` and speaker with Ctrl-C. Stop speaker last, since its restart drops every grant.

Pi needs a model endpoint to do any work. Point `LLM_UPSTREAM` at an OpenAI-compatible server (a loopback or LAN address and port) and `LLM_MODEL` at one of its model ids. To use a hosted model instead, add the provider's key as a speaker secret (allowed host: the provider's API host), list the provider under `hostedProviders` in `config.json` with `credential` set to that secret's name, and launch with `--model <provider>/<model>`. The task then asks for that secret in its first card; the key stays in speaker, and the VM only holds a placeholder that speaker's proxy replaces. A task launched with `--prompt` starts Pi once you approve that card.

{.ai}

<!-- author: ai -->

## Commands

<sub>AI-written</sub>

| Command | Purpose |
| --- | --- |
| `mise run install` | Install both packages with pnpm |
| `mise run check` | Typecheck both packages and lint speaker |
| `mise run test` | Run both packages' tests |
| `mise run format` | Format speaker |
| `mise run speaker` | Run speaker with live reload |
| `mise run bottle` | Run the bottle-school service |
| `mise run bottle-cli register` | Register the sandbox host; approve it in speaker |
| `mise run bottle-cli run --template offline` | Launch a sandbox task |
| `mise run bottle-cli ls` | List tasks |
| `mise run bottle-cli attach <id>` | Join Pi in a running guest |
| `mise run bottle-cli stop <id>` | Stop and archive a task |
| `mise run guest-build pi-v5-guest` | Build the guest image and import it into Gondolin and microsandbox |

<!-- author: ai -->

## Local files and generated artifacts

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle-school configuration. The owner must keep these outside any GitHub upload. The repository ships source, dependency locks, build recipes, and examples. mise installs dependencies and builds the guest; the optional Krun backend needs a local kernel and runner that the owner provisions separately.
{.ai}
