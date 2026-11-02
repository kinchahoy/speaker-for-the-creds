<!-- author: ai -->

# speaker-for-the-creds

<sub>AI-written</sub>

The owner approves what agents may use from a phone, for a chosen duration.
{.ai}

- [speaker](speaker/README.md) stores homelab keys, approves agent sessions, proxies APIs, and issues leases.
- [bottle-school](bottle-school/README.md) runs Pi in Gondolin micro-VMs and enforces site, secret, folder, and MCP leases.

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

For speaker, copy `speaker/.env.example` to `speaker/.env`, set a strong admin password and the browser-facing `PUBLIC_URL`, then start the service:
{.ai}

```sh
cp speaker/.env.example speaker/.env
chmod 600 speaker/.env
mise run speaker
```

Open `PUBLIC_URL/admin`, configure a provider, and test approval and revocation with the demo before adding real credentials. Agents use [the access-and-creds skill](speaker/skill/SKILL.md) to enroll sessions and request access. The owner approves each session and capability in the browser.
{.ai}

The owner can deploy speaker through [Docker](speaker/README.md#docker--home-server-deployment). The owner must verify the real upstream URL, TLS, private routing, and approval flow. Speaker is a supervised-pilot candidate. bottle-school still needs an end-to-end guest run and host storage quotas before unattended use.
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
| `mise run bottle-cli register` | Register the enforcer; approve it in speaker |
| `mise run bottle-cli run --template offline` | Launch a sandbox task |
| `mise run bottle-cli ls` | List tasks |
| `mise run bottle-cli attach <id>` | Join Pi in a running guest |
| `mise run bottle-cli stop <id>` | Stop and archive a task |
| `mise run guest-build pi-v5-guest` | Build and import the guest image |

<!-- author: ai -->

## Local files and generated artifacts

<sub>AI-written</sub>

Git ignores `/personal/`, environment files, runtime binaries, dependencies, speaker data, and local bottle-school configuration. The owner must keep these outside any GitHub upload. The repository ships source, dependency locks, build recipes, and examples. mise installs dependencies and builds the guest; the optional Krun backend needs a local kernel and runner that the owner provisions separately.
{.ai}
