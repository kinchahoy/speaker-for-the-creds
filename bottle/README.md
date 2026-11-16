<!-- author: ai -->

# bottle

<sub>AI-written</sub>

bottle runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs. Speaker approves capabilities; bottle applies their grants inside the VM. This is the reference for setting up and running it. For what the project is for, see the [top-level README](../README.md); for the grant model, [speaker's design](../speaker/DESIGN.md).
{.ai}

<!-- author: ai -->

## Host setup

<sub>AI-written</sub>

Needs hardware virtualization, Docker (image builds), `setsid` and 20 GiB free. Linux: add the service account to the `kvm` group and start a new login session. macOS works once `brew install util-linux` provides `setsid`. Run it as the account that holds its config and archives.
{.ai}

```sh
mise trust && mise install   # once, from the repository root
mise run init bottle
```

`init` checks the host, asks its questions, writes `~/.bottle/config.json`, builds the image, registers the host with speaker, and offers to start bottle and run a smoke-test agent. It asks for ports, speaker's URL, the model server (`host:port`) and model, the image tag and whether to link, build and smoke-test. Re-running updates with current answers as defaults (`--force` under `--yes`). If speaker is locked it asks for the owner password, and with it `init` approves this host itself; otherwise it prints the `/admin` link and waits (polls under `--yes`). It needs a real terminal; scripts use flags:

```sh
mise run init bottle --yes --speaker-url http://192.168.1.10:3000 --model-endpoint 192.168.1.20:8080 --model my-model
```

Other flags: `--control-port`, `--guest-port`, `--image`, `--force`, `--skip-link`, `--skip-build`, `--skip-register` (also skips the smoke test), `--skip-smoke`, `--password-stdin`. `mise run init bottle -- --help` lists them. If speaker is on another machine, run `mise run init speaker` there first.

Everything bottle keeps is in `~/.bottle` (mode 700), or `$BOTTLE_HOME` (at most 60 characters, because microsandbox keeps unix sockets under it). The repository holds only code.

| Path | Holds |
| --- | --- |
| `config.json` | settings `init` writes |
| `config/` | `templates.json`, `catalog.json` |
| `state/` | `speaker.token` (this host's login) and running agents' work folders |
| `output/` | one archive folder per finished agent |
| `microsandbox/` | guest image, VM disks, microsandbox's database (`MSB_HOME` overrides) |
| `bottle.log` | output of a bottle that `init` started |

Each VM's short-lived sockets live in a private folder under `$XDG_RUNTIME_DIR`, removed at stop.
{.ai}

### config.json

By hand: copy `config.example.json`, set `configRoot`, `stateRoot` and `outputRoot` to existing writable absolute directories, and copy `bottle/templates.json` and `bottle/catalog.json` into `configRoot`. `BOTTLE_CONFIG` selects another file for the service, CLI and `build`.

| Key | Meaning |
| --- | --- |
| `bindHost` | Loopback, RFC1918 or Tailscale IPv4 for the control API. It trusts any peer that reaches it: keep it private. |
| `speaker.url` | Speaker's address. The VM reaches it here, so on one machine use the LAN address, not `127.0.0.1`. |
| `speaker.proxyPort`, `speaker.sshPort` | Speaker's `PROXY_PORT` and `SSH_PORT`, same host. `bottle register` learns and writes them; if registering is skipped, set them by hand (init writes placeholders). |
| `localModel.upstream` | Optional (answer `none` for hosted only). One loopback, RFC1918 or Tailscale literal IPv4 `host:port` (or `localhost`); MagicDNS names are rejected. |
| `localModel.models` | Served model ids; use `--model local/<id>` or an `alias`. Local inference is baseline access, independent of grants. |
| `localModel.wake` | Optional `{ "command": "<shell>", "waitSeconds": 180 }` for a server that sleeps. When a local call or launch finds it down, bottle runs the command once (for example a Home Assistant webhook) and waits. |
| model `alias` | Lowercase letters, digits, dashes; unique across models. `-m` and a template's `model` take id or alias. |
| model `contextWindow` | Tokens. Pi assumes 128k for unknown models and bottle's entries override its data, so set it when the real window differs. |
| `hostedProviders` | `[{ id, service, models, api }]`; `api` is `openai-completions` (default) or `anthropic-messages`. See Hosted model providers. Init writes `openrouter`, `anthropic`, `openai`. An OpenRouter model may carry `openRouterRouting` (provider preferences such as `{ "only": ["deepinfra/fp8"] }`); Pi sends it from the VM, so it is a preference, not enforced. |
| `herdr` | `false` disables Herdr tabs; `true` makes a missing `hc` an error. |

A local model is checked at launch: if `/v1/models` does not answer in 2 seconds the launch fails naming the server.
{.ai}

<!-- author: ai -->

## Build and run

<sub>AI-written</sub>

`init` does these for you. By hand:

```sh
mise run bottle build bottle-guest
mise run bottle register   # prints the approve link; approve the host in speaker /admin
mise run bottle serve      # foreground, never stops itself; `bottle run` starts it detached on demand,
                           # and that one stops 10 minutes after its last agent (`bottle down` stops either now)
```

`register` names the host after the machine (`--name` overrides); registering again from the same machine and name leaves the old entry until the new one is approved. Approval is learned from `GET /_speaker/hosts/self` with the host token: 200 approved, 401 pending or unknown (a rejected token is fatal, an outage is retried).

**`bottle` on PATH.** `init` offers to link `~/.local/bin/bottle`; by hand: `ln -s "$PWD/bottle/src/cli.ts" ~/.local/bin/bottle` from the repository root. Outside the repo it uses mise's global Node (`mise use -g node@latest`). On macOS add `~/.local/bin` to `PATH`. The Herdr mod and + menu need it.

```sh
bottle run "Write a greeting to /output/greeting.txt"   # attaches to Pi; template defaults to builder
bottle run -d "…"                 # detached: prints the attach command, returns
bottle run -t sealed -m deepseek  # no prompt: Pi opens and waits
bottle ls                         # live agents, then recent finished ones with archive folders
bottle attach [<id>]              # id, prefix or name; restarts Pi if it was quit
bottle stop [<id>]
bottle help run                   # per-command usage
```

Errors exit 1 (runtime) or 2 (usage). Ctrl-\ detaches and leaves Pi running; Ctrl-] leaves the VM terminal. `/quit` ends only Pi: VM, files and grants stay, `attach` restarts it on the same session, `stop` archives. A one-shot agent writes `/output/DONE` when complete.

**Service across reboots** (systemd user unit; set `<repo>` and the `mise` path):

```ini
# ~/.config/systemd/user/bottle.service
[Unit]
Description=bottle
After=network-online.target

[Service]
ExecStart=/usr/bin/mise -C <repo> run bottle serve
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now bottle` and `loginctl enable-linger $USER`; logs via `journalctl --user -u bottle -f`.

**Agent states** (`ls` also shows mode, pending approvals with request id, age, model, name, Pi's latest message):

| State | Meaning |
| --- | --- |
| `starting` | VM up, Pi starting |
| `awaiting-grant` | Prompted agent on a hosted model: Pi waits for the owner to approve the model's service |
| `idle`, `busy` | As the guest reports |
| `reconfiguring` | Pi restarting with new MCP servers or extensions |
| `pi-down` | A restart failed or Pi exited right after; transcript kept, `stop` still exports |
| `start-failed` | Pi never started; `stop` archives without a transcript |
| `closing` | Being archived |
| `done` | Pi wrote `/output/DONE` |

Finished agents show `archived` or `failed-archive` (work folder kept).

**Attended or unattended.** Attached `run` is attended; `run -d` or no terminal is unattended (`--attended` / `--unattended` override). An attended agent loads `ask_user_question` whatever its template says; an unattended one is told nobody is watching, records assumptions in `/output/NOTES.md`, keeps going and still asks for access via `request_capability`. Mode does not change archival.

**API errors.** The control API (`/api/state`, `/api/agents`, `/api/agents/<id>/close`) and the VM doors answer in speaker's error shape and codes (409 `conflict` when state forbids it or past `maxAgents`). The model door answers the OpenAI shape Pi reads. There is no status page: use `bottle ls` or `GET /api/state`.

### In the Herdr app

With `hc` on the host's `PATH`, a detached agent (or one detached with Ctrl-\) opens as a tab in a **bottle** space, running `hc run --bg --no-parent --name pi-<id> --label herdr.space=bottle --label herdr.tab=<id> -- bottle attach <id>`; the tab closes with the agent. The speaker mod lists open agents too ([install](../speaker/README.md#owner-api-and-the-herdr-mod)). If Herdr runs on another machine (WSL seen from Windows), name it (`hc machine ls`) in the mod's Settings. Herdr names a new space after its first terminal's folder, so rename it "bottle" once. For the + menu, add to `~/.config/herdr-app/programs.json`:

```json
{ "programs": { "bottle": { "name": "Pi (sandbox)", "run": ["bottle", "run"] } } }
```
{.ai}

### Guest image

`guest/Dockerfile` builds a Debian slim image in five layers: apt packages, Node via mise, Playwright with Chromium, the other mise tools plus uv's CPython and default environment (`guest/mise.toml`, `guest/python/requirements.in`), and Pi with its extensions (one pnpm project, `guest/pi-package.json`; extensions pinned, the rest latest).

`bottle build` uses `docker buildx` for the host architecture (`PI_GUEST_PLATFORMS=linux/amd64,linux/arm64` for both, with emulation), then loads the image into `~/.bottle/microsandbox`. It needs `config.json`, internet and about 10 GiB.

Contents: compilers, ffmpeg, imagemagick, OCR, `socat`, `sshfs`, `dtach`; mise with Node, pnpm, uv, `gh`, ripgrep, pandoc, tmux; Python through uv only (default environment in `/opt/uv/venv`, writable cache in `/opt/uv/cache` so default packages install offline); Playwright with Chromium.

Any OCI image works if it holds Node, Pi, git, curl, `socat`, `sshfs`, `dtach`, `openssh-client` and `ca-certificates`. bottle never pulls; import it under the `guestImage` tag:

```sh
docker save <image> | msb load --tag <guestImage>   # or: msb load -i <archive.tar> (docker-save or OCI layout)
```
{.ai}

<!-- author: ai -->

## The VM

<sub>AI-written</sub>

Each agent runs in a microsandbox VM (libkrun, from the `microsandbox` npm package; Linux needs only `/dev/kvm`). Chosen over Gondolin, Firecracker and smolvm as the only one offering, from one Node library on Linux and macOS, a no-network guest, vsock-to-unix-socket routes, terminal exec and resource limits.

The guest has no network device. Its only doors are host unix sockets on vsock ports, which `socat` exposes as localhost ports: an HTTP proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`), the model endpoint (`http://model.internal`), speaker (`SPEAKER_URL`), and the control channel for Pi's status reports. A fifth, raw to speaker's SSH jump server, is reached by `ssh` through `ProxyCommand socat - VSOCK-CONNECT:2:<port>`. `TZ` follows the host.

Code: `src/sandbox.ts` (VM and doors), `src/agents.ts` (lifecycle table, archive writer), `src/speaker.ts` (speaker connection; silent 30 seconds means stale).

- **Egress:** one `proxy-chain` server per agent decides each request from the live grant view. A host on the allow list goes direct (public IPv4 only; IPv6 is rejected). A host bound to a granted `secret:` goes through speaker's proxy as the agent. Anything else is 403. bottle does not terminate TLS; a secret host's TLS ends at speaker's proxy, so at launch bottle fetches `/_speaker/proxy/ca.pem` (a locked speaker fails the launch), installs it in the guest trust store and sets `NODE_EXTRA_CA_CERTS`.
- **Model door:** a forwarder to `localModel.upstream`. It counts each request against `maxModelRequests` (over the cap: 429), streams the reply and appends a line per call to `model-calls.jsonl`. A hosted provider's `baseUrl` points at `http://model.internal/hosted/<id>`, which the forwarder maps to `<speaker.url>/<service>/<path>` with the agent's token, nowhere else.
- **Speaker door:** allows only speaker's agent-facing routes and adds the agent's token itself. It refuses the services behind `hostedProviders`, so every model call is counted and captured.
- **Folders:** a `folder:` grant is mounted by bottle (not Pi) over `sshfs` through speaker's jump server at `/input/<share>` (`:rw` at `/space/<share>`), with `-o ro` as a second guard for read-only, remounted when mode changes and unmounted when the grant ends. Each agent gets a throwaway ed25519 key (public half sent as `sshKey`; private half root-only at `/run/speaker/ssh_key`). A grant exposes the whole share, and `/space` shares outlive the agent. `sshfs` is slow for `grep -r`, `find` and `git status`. Launch folders (below) are bound directly instead.
- **Storage:** images, disks and sockets in `~/.bottle/microsandbox`; `MSB_HOME` moves the roughly 20 GiB elsewhere. microsandbox refuses a folder with a group- or world-writable ancestor (sticky ones such as `/tmp` are fine); `start.sh` names the directory to `chmod`.
{.ai}

<!-- author: ai -->

## Templates, catalogs, and grants

<sub>AI-written</sub>

`templates.json` is an array of templates: `id`, `label`, `limits`, `want`, `duration`, and optionally `model` (id or alias) and `folders`. `want` lists items (`site:pypi.org`, `ext:subagent`, `notes.read`, `group:<name>` from speaker's `config.json`). `label` and `duration` (`30m`, `1h`, `2h` default, `1d`, `30d`) with `want` become the agent's first request: one card, reason `launch template <id>: <label>` (label is `--name` if given). Empty `want` asks nothing. Duplicate ids fail validation.

Extensions in `want` whose catalog entry has no `sites` (`subagent`, `pi-cc-monitor`, `pi-cc-loop`) load at launch without a card, because the owner wrote the template and started it. They last the whole task and are not speaker grants (revoking the agent ends them); speaker logs and displays them, bottle shows them in policy events and `bottle ls`. Everything else, including sites-bearing extensions and a hosted model's service, goes to speaker.

| Template | Default model | Adds |
| --- | --- | --- |
| `sealed` | `qwen` | Agent space (`~/agent-space`, at `/space/agent-space`), `pi-cc-monitor`, `pi-cc-loop`. No network. |
| `builder` | `deepseek` | Package registries, public GitHub, `context7.read`, web search, Wikipedia, arXiv. Up to 72 hours, 1500 model requests. |
| `trusted` | `deepseek` | `secret:GITHUB_READ`, `obsidian.read`, `karakeep.read`. |
| `cron` | `deepseek` | Agent space, `pi-cc-loop`, `pi-cc-monitor`, web search, Wikipedia, arXiv, asked for 30 days. Up to 168 hours, 3000 model requests. |

The first three are tiers, each a superset of the one before; writes (GitHub write, `ssh:`, `.full`) are in no template, the agent asks mid-run. `bottle run` defaults to `builder`. Model: `-m`, then the template's `model`, then the first configured. `bottle templates [--json]` lists templates and models with aliases and whether the local server answers; it reads files directly, no running bottle needed.

A template's `limits` set VM size, deadline and request cap; its `want` (or the speaker group) sets starting access.

**Launch folders.** `bottle run -f <path>[:rw]` (repeatable) and a template's `folders` mount host folders straight into the VM with no grant or SSH: naming them is the owner's approval, recorded in `policy-events.jsonl`. Read-only at `/input/<name>`, `:rw` at `/space/<name>`. Paths are absolute or `~/`; the CLI resolves relative ones. A missing folder or duplicate name fails the launch. Other machines' folders, or ones asked for mid-run, stay speaker shares. The templates mount `~/agent-space` read-write, shared by every agent on the host: `mkdir -p ~/agent-space` once.

**Start order.** A local-model agent starts Pi at once; a prompted agent on a hosted model waits for its service card (else turn one fails). When an `mcp:` or `ext:` grant arrives, Pi restarts at its next idle point on the same session (the launch prompt is not replayed), so a one-shot unattended agent may run its first turn without the tools. Approve unattended launches promptly.

- **Grant changes reach the agent in one message.** On a restart caused by changed `mcp:`/`ext:` grants, bottle writes `change.json`; the guest extension then sends one message naming new tools, expected tools that did not load, and removals (which reach the agent only this way). `/work/.speaker/last-change-id` stops repeats.
- **Pi-alive check:** after each start bottle waits up to 60 seconds for Pi to load (cold disk), then 1 more to confirm it runs. If not, the agent goes to `pi-down` with the tail of `/run/pi.err` in its events and its `mcp:`/`ext:` grants are not reported in force; a failed first start is `start-failed`.
- **Limits:** VM limits cover CPU, memory and the disposable root disk; `maxRuntimeHours` ends the agent at its deadline; optional `maxModelRequests` caps request count. `workGiB` is only a launch-time free-space check; enforce quotas on the host filesystem.
- **Snapshots from speaker** replace the live grants. Sites, secrets and folders apply once installed; an MCP server or extension applies after Pi restarts at idle. Unsupported items are skipped. After 30 seconds without word from speaker, bottle drops all its agents' grants until reconnected, so grants end within 30 seconds of losing speaker.
- **Always-on extensions** (`/opt/pi-extensions`): pi-loop-police, pi-token-speed, proper-base, pi-subagents (same VM and policy, 2 children, no nesting, the agent's model). Every other package loads only through a grant, or attended mode for ask-user-question.

### catalog.json

`mcps` and `extensions`. bottle sends it to speaker on every connection; speaker lists it in `GET /_speaker/catalog` and `request_capability` shows it in its description.

- **`mcp:<id>`:** an in-VM server from an image-local command: `transport: "stdio"`, absolute `command`, `args`, `tools` (non-empty, no repeats, lowercase letters, digits, `_`, `-`) and `write`. Granting writes the server to Pi's `mcp.json` at the next restart; a revoke removes it. The shipped catalog has none.
  ```json
  { "mcps": { "files": { "label": "Project files", "transport": "stdio", "command": "/opt/mcp/files", "args": ["--root", "/work"], "tools": ["read-file", "list-dir"], "write": false } }, "extensions": {} }
  ```
- **Remote and hosted MCP servers** are speaker services, not catalog entries (a remote entry fails validation). Add one in speaker's Setup (`speaker/services.example.json` has Context7 and Parallel Search); the agent asks for `<service>.read` or `.full`.
- **`ext:<id>`:** an image-local `guestPath` (`/opt/pi-plugins/<name>`), the `tools` to declare (Pi's `--tools` is an allowlist), `sites` it contacts (added to the request), optional `note` and `files`. Shipped: pi-web-access, pi-cc-loop, pi-cc-monitor, Pi's subagent example. Unknown ids are skipped.
- At startup bottle checks every `guestPath` against the image manifest (`bottle build` copies `/opt/pi-plugins.manifest` to `<stateRoot>/guest-plugins.txt`); a wrong path stops startup naming the entry, a missing manifest means run `bottle build`.

### Asking for access without waiting

`request_capability` never holds the agent: it files the request and answers at once (the decision if there is one, else "Filed as request <id>. Not decided yet."). A guest loop long-polls each pending request by id (never filing twice) and, on a decision, sends one `[speaker]` message once apply-at-once items are in force. Repeat calls answer "already pending". Pending ids live in `/work/.speaker/pending.json`, so a Pi restart re-arms them.
{.ai}

<!-- author: ai -->

## Secrets and speaker's proxy

<sub>AI-written</sub>

bottle never holds a secret. Add it once in speaker's Setup with its allowed hosts and the variable the agent sees (for example `GH_TOKEN`); the agent asks for `secret:<NAME>`. The grant snapshot carries the hosts, not the value. bottle's egress proxy sends every request to those hosts through speaker's HTTPS proxy (`PROXY_PORT`) as a CONNECT tunnel authenticated as the agent; bottle holds that token, the guest has only a placeholder, and the guest trusts speaker's proxy certificate. Pi gets the placeholder from `GET /_speaker/catalog`. bottle drops the route when the grant goes, and if speaker's proxy is unreachable it refuses rather than sending directly. What speaker does next: [DESIGN](../speaker/DESIGN.md#secrets-speaker-inserts-them).

Other paths: remote MCP servers and hosted providers are speaker services; the local model takes the literal key `local`; stdio MCPs and plugins run in the VM with access to guest data, so never put raw secrets in their command, args or config. Tokens: `hostToken` (host login, `state/speaker.token`), `agentToken` (guest sees only placeholder `SPEAKER_TOKEN`), `guestToken` (`BOTTLE_TOKEN`, status reports). VMs are named `bottle-<id>`; startup removes crash leftovers.

### Hosted model providers

A hosted provider is a speaker service (starters `openrouter`, `anthropic`, `openai`); the key is entered once in Setup, and set `hostedProviders[].service` to its id. Launch with `-m <id>/<model>`. The agent adds `<service>.full` to its first request (a chat completion is a POST). Pi's key in `models.json` is a dummy: the model door swaps in the agent's token and sends the call to `$SPEAKER_URL/<service>/...`, where speaker checks the grant, adds the real key and audits. Until the owner grants the service, speaker refuses, which is why a prompted agent waits for this card before Pi starts. Approving a provider approves every model and operator behind that host.
{.ai}

<!-- author: ai -->

## Add an extension

<sub>AI-written</sub>

1. Pin the npm package in `guest/pi-package.json`. Any dependency declaring a `pi` extension is linked automatically into `/opt/pi-plugins/<name>` (the part after the scope), except the always-on ones (`ALWAYS_ON` in the Dockerfile), which go to `/opt/pi-extensions`.
2. `bottle build` rebuilds the image and copies the manifest to `<stateRoot>/guest-plugins.txt`.
3. Add an entry to the live `<configRoot>/catalog.json` (`bottle/catalog.json` has the shipped ones): `label`, `guestPath`, `description`, `tools` (exactly the names the package registers; unlisted tools stay hidden), `sites` (hosts it contacts; added as `site:` grants that end with the extension's), optional `note` and `files`.
4. `files`: `{ "<name>.json": {…} }` writes `~/.pi/agent/<name>.json` in the guest for agents that load it. No directory part; cannot replace `models.json`, `settings.json`, `mcp.json` or `APPEND_SYSTEM.md`. `pi-web-access` is the example.
5. Reload: `pkill -HUP -f "bottle/src/server.ts"`. The catalog is re-validated, swapped in and re-sent to speaker; a bad one is refused and the old stays. Running agents are not restarted for new entries; a grant for a removed one is skipped and that Pi restarts at idle without it.
{.ai}

<!-- author: ai -->

## Research and loop presets

<sub>AI-written</sub>

- **`research` group** (speaker's `groups.example.json`): `pi-web-access`, site `mcp.exa.ai`, Wikipedia, arXiv. Search is keyless Exa; pages are fetched over HTTP, each host needing a `site:` grant; hosted extraction, browser cookies and video paths are off. Parallel Search is left out (it duplicated search, and its hosted `web_fetch` reads any page without a site grant); ask for `parallel-search.read` explicitly. A keyed provider needs a speaker secret plus a small change in `writeGuestConfig`, since catalog `files` are static.
- **`loop` group** (pi-cc-loop, pi-cc-monitor): Pi wakes itself with `/loop`, cron jobs, `schedule_wakeup` or `Monitor`. bottle never archives for idleness; `/output/DONE` or the deadline ends it. Jobs in `/work/.pi/scheduled_agents.json` survive Pi restarts, not archival.
- **`cron` template:** `bottle run -d -t cron "Every weekday at 9:00, summarize new arXiv papers on X into /space/agent-space/digest.md"`. One approval covers the run; anything later wakes or agents need belongs in the agent space.
{.ai}

<!-- author: ai -->

## Agent archive

<sub>AI-written</sub>

Mounts: `/input` read-only shares, `/space` read-write shares, `/work` scratch and the Pi session, `/output` retained artifacts, `/etc/bottle` trusted config. Pi runs as guest root.

At close bottle stops Pi, exports the session and transcript, writes the trusted records, closes the VM, deletes its speaker agent and removes the work tree. An archive holds `artifacts/` and `_control/` (agent metadata, grant and policy events, hashed artifact manifest, Pi session and transcript, `model-calls.jsonl`).

`model-calls.jsonl`: one line per model call (`at`, `status`, `durationMs`, `request`, raw `reply`, `truncated`; bodies cut at 8 MiB and 32 MiB). Tool calls are in Pi's session file.

You delete archives manually. If archiving fails, bottle keeps the work tree and reports it. A completed write or a read note cannot be revoked after the fact. Treat prompts, replies and artifacts as private data.
{.ai}

<!-- author: ai -->

## Verification and troubleshooting

<sub>AI-written</sub>

`mise run check` and `mise run test` cover configuration, network policy, templates, the speaker channel and the secret route against a real speaker proxy; they do not boot a guest. The real-VM pass is in [speaker's DESIGN](../speaker/DESIGN.md#verifying-end-to-end); also worth checking there: certificate inheritance through dtach and terminal behavior.

bottle runs on macOS (confirmed 2026-11-15). Not verified: folder mounts (FUSE in the guest) on macOS, many concurrent VMs, terminal resize.

| Symptom | Cause |
| --- | --- |
| Startup stops on `setsid` | Not installed |
| Startup stops on microsandbox storage | The folder or a parent is group- or world-writable; `chmod` the named directory |
| `speaker.token is missing` | Register the host first |
| Guest request returns 403 | Not granted, expired or revoked; the agent requests the capability |
| Launch fails: "speaker's proxy certificate is unavailable" | Speaker is locked |

SIGINT or SIGTERM archives open agents; check the archive outcome before discarding recovery files.
{.ai}

<!-- author: ai -->

## Security boundary

<sub>AI-written</sub>

Trusted: the host, bottle, the sandbox runtime, the pinned image, and every peer that can reach the control listener (it has no application login, so restrict it by host networking). Not trusted: the guest, model decisions, downloaded code, files, remote tool output.

- The host enforces grant expiry, revocation, network access and shared-folder permissions independently of Pi. Validate them in a real guest before deployment.
- Every approved destination can receive anything the guest can read. Placeholder substitution protects secret values, not misuse of granted authority. If someone took over bottle, they could make requests through speaker only while a grant is active, only to the secret's hosts, all logged; they could not copy the secret.
- bottle's egress proxy is a high-value host process. Every guest client must honour the proxy settings and trust speaker's certificate; one that ignores them gets no network.
- Provide host storage quotas: request counts do not bound GPU concurrency, token use or a single generation's length.
- Review artifacts before running them; archives may hold private content.
{.ai}
