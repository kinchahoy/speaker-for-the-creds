# bottle

_AI-drafted_

bottle runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs with no network card. Speaker approves access; bottle applies each grant inside the VM. What the project is for and where every setting lives are in the [top-level README](../README.md); the grant model is in [speaker's security model](../speaker/README.md#security-model-and-design).

## Host setup

_AI-drafted_

Needs hardware virtualization, Docker (image builds), `setsid` and 20 GiB free. Linux: add the account to the `kvm` group and log in again. macOS works once `brew install util-linux` provides `setsid`. Run bottle as the account that holds its config and archives.

```sh
mise trust && mise install   # once, from the repository root
mise run init bottle
```

`init` checks the host, asks for ports, speaker's URL, the model server (`host:port`) and model, writes `~/.bottle/config.json` from `config.example.json`, builds the image, registers the host with speaker and offers to start bottle and run a smoke-test agent. Re-running keeps current answers as defaults. If speaker is locked it asks for the owner password and approves the host itself; otherwise it prints the `/admin` link and waits. If speaker is on another machine, run `mise run init speaker` there first. For scripts:

```sh
mise run init bottle --yes --speaker-url http://192.168.1.10:3000 --model-endpoint 192.168.1.20:8080 --model my-model
```

Other flags: `--control-port`, `--guest-port`, `--image`, `--force`, `--skip-link`, `--skip-build`, `--skip-register` (also skips the smoke test), `--skip-smoke`, `--password-stdin`.

Everything bottle keeps is in `~/.bottle` (mode 700), or `$BOTTLE_HOME` (at most 60 characters: microsandbox keeps unix sockets under it): `config.json`; `state/` (`speaker.token`, this host's login, and running agents' work folders); `output/` (one archive per finished agent); `microsandbox/` (guest image, VM disks; `MSB_HOME` moves these roughly 20 GiB); `bottle.log`. `BOTTLE_CONFIG` selects another config file. The repository holds only code, `catalog.json` and the guest image recipe.

### config.json

| Key | Meaning |
| --- | --- |
| `bindHost` | Loopback, RFC1918 or Tailscale IPv4 for the control API. It trusts any peer that reaches it: keep it private. |
| `speaker.url` | Speaker's address as the VM reaches it; on one machine use the LAN address, not `127.0.0.1`. |
| `speaker.proxyPort`, `speaker.sshPort` | Speaker's `PROXY_PORT` and `SSH_PORT`. `bottle register` learns and writes them. |
| `stateRoot`, `outputRoot` | Existing writable absolute directories. |
| `localModel.upstream` | Optional. A literal loopback, RFC1918 or Tailscale IPv4 `host:port` (or `localhost`); MagicDNS names are rejected. Checked at launch: no `/v1/models` answer in 2 seconds fails the launch. |
| `localModel.models` | Served model ids (`-m local/<id>` or an alias). Local inference needs no grant. |
| `localModel.wake` | Optional `{ "command", "waitSeconds": 180 }` for a server that sleeps: bottle runs the command once (for example a Home Assistant webhook) and waits. |
| model `alias`, `contextWindow` | Alias: lowercase letters, digits, dashes, unique. Set `contextWindow` when the real window differs from Pi's 128k default. |
| `hostedProviders` | `[{ id, service, models, api }]`; `api` is `openai-completions` (default) or `anthropic-messages`. An OpenRouter model may carry `openRouterRouting` (a preference Pi sends; not enforced). |
| `templates` | Launch templates; see below. |
| `herdr` | `false` disables Herdr tabs; `true` makes a missing `hc` an error. |

### Docker

`bottle/compose.yaml` runs bottle in a read-only container with `/dev/kvm`, on speaker's Docker network (it reaches speaker by service name, `http://speaker:3000`). Its `.env` sets `BOTTLE_NAME` (the host name speaker shows), `AGENT_SPACE` and `BOTTLE_OUTPUT` (existing host folders for the shared agent space and the archives), `KVM_GID` (`getent group kvm`) and `SPEAKER_NETWORK`. The host token is bound to the container's address, so register from inside it: `docker compose exec bottle bottle register`; until then the container waits. Nothing is published; use `docker compose exec bottle bottle ls` and friends.

## Build and run

_AI-drafted_

`init` does these; by hand:

```sh
mise run bottle build bottle-guest
mise run bottle register   # prints the approve link
mise run bottle serve      # foreground; `bottle run` otherwise starts bottle on demand,
                           # stopping it 10 minutes after its last agent
```

`register` names the host after the machine (`--name` overrides). Registering again leaves the old entry until the new one is approved.

**`bottle` on PATH.** `init` offers to link `~/.local/bin/bottle`; by hand, `ln -s "$PWD/bottle/src/cli.ts" ~/.local/bin/bottle` from the repository root. Outside the repository it needs a global Node (`mise use -g node@latest`). The Herdr mod needs it.

```sh
bottle run "Write a greeting to /output/greeting.txt"   # attaches to Pi; template defaults to builder
bottle run -d "…"                 # detached: prints the attach command and returns
bottle run -t sealed -m qwen      # no prompt: Pi opens and waits
bottle ls                         # live agents, then recent finished ones with archive folders
bottle attach [<id>]              # id, prefix or name; restarts Pi if it was quit
bottle stop [<id>]
bottle help run
```

The control API (`/api/state`, `/api/agents`, `/api/agents/<id>/close`) answers in speaker's error shape; there is no status page. VMs are named `bottle-<id>`, and startup removes ones a crash left behind.

Ctrl-\ detaches and leaves Pi running; Ctrl-] leaves the VM terminal. `/quit` ends only Pi: `attach` restarts it on the same session, `stop` archives. A one-shot agent writes `/output/DONE` when complete. Errors exit 1 (runtime) or 2 (usage).

**Attended or unattended.** Attached `run` is attended; `run -d` or no terminal is unattended (`--attended` / `--unattended` override). An attended agent gets `ask_user_question`; an unattended one is told nobody is watching, records assumptions in `/output/NOTES.md` and keeps going, still asking for access when it needs it.

**Agent states** in `bottle ls`: `starting`, `awaiting-grant` (a prompted agent on a hosted model waits for the model's service card), `idle`, `busy`, `reconfiguring` (Pi restarting with new MCP servers or extensions), `pi-down` (a restart failed; `stop` still exports), `start-failed` (Pi never started), `closing`, `done` (Pi wrote `/output/DONE`); finished agents show `archived` or `failed-archive` (work folder kept).

**Across reboots**, a systemd user unit:

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

Then `systemctl --user enable --now bottle` and `loginctl enable-linger $USER`; logs with `journalctl --user -u bottle -f`.

**In the Herdr app.** With `hc` on `PATH`, a detached agent opens as a tab in a **bottle** space (`hc run --bg --no-parent --name pi-<id> … -- bottle attach <id>`) that closes with the agent. Herdr names a new space after its first terminal's folder, so rename it "bottle" once. If Herdr runs on another machine (such as WSL seen from Windows), name it (`hc machine ls`) in the speaker mod's Settings. For the + menu, add to `~/.config/herdr-app/programs.json`:

```json
{ "programs": { "bottle": { "name": "Pi (sandbox)", "run": ["bottle", "run"] } } }
```

## Templates and grants

_AI-drafted_

`templates` in `config.json` is an array: `id`, `label`, `limits`, `want`, `duration`, optional `model` (id or alias) and `folders`. `want` lists items (`site:pypi.org`, `ext:pi-cc-loop`, `notes.read`, `group:<name>` from speaker's config); with `label` and `duration` it becomes the agent's first request, one card. `limits` sets CPU, memory, disk, `maxRuntimeHours` (the deadline) and optional `maxModelRequests` (429 past it). `workGiB` is only a launch-time free-space check; enforce quotas on the host filesystem.

| Shipped template | Adds |
| --- | --- |
| `sealed` | The agent space, `pi-cc-monitor`, `pi-cc-loop`. No network. |
| `builder` | Plus groups `developer` (package registries, GitHub downloads, Context7) and `research`. Up to 72 hours, 1500 model requests. |
| `trusted` | Plus `parallel-search.read`. |
| `cron` | The agent space, loop extensions and `research`, asked for 30 days. Up to 168 hours, 3000 model requests. |

Each of the first three is a superset of the one before. Writes (`.full`, `ssh:`, write tokens) are in no template; the agent asks mid-run. `bottle run` defaults to `builder`. Model: `-m`, then the template's `model`, then the first configured. `bottle templates [--json]` lists templates and models and whether the local server answers, without a running bottle.

**Launch folders.** `bottle run -f <path>[:rw]` (repeatable) and a template's `folders` bind host folders straight into the VM, with no grant or SSH: naming them is the owner's approval, recorded in `policy-events.jsonl`. Read-only at `/input/<name>`, `:rw` at `/space/<name>`. The shipped templates mount `~/agent-space` read-write, shared by every agent on the host: `mkdir -p ~/agent-space` once. Folders on other machines, or asked for mid-run, are speaker shares.

**Extensions without sites** in `want` (such as `pi-cc-monitor`, `pi-cc-loop`) load at launch without a card, since the owner wrote the template and started it; they last the whole run and are not revocable grants. Everything else, including a hosted model's service, goes to speaker. Always loaded (`/opt/pi-extensions`): pi-loop-police, pi-token-speed, proper-base, pi-subagents (2 children, same VM and policy).

**How grants arrive.** Snapshots from speaker replace the live grants. Sites, secrets and folders apply at once; an `mcp:` or `ext:` grant applies when Pi restarts at its next idle point on the same session (the launch prompt is not replayed), and one message then names new tools, expected tools that did not load, and removals. So a one-shot unattended agent may run its first turn without them: approve unattended launches promptly. After a restart bottle waits up to 60 seconds for Pi to load; if Pi does not stay up the agent goes to `pi-down` with the tail of `/run/pi.err`. Silent from speaker for 30 seconds, bottle drops all its agents' grants until reconnected.

**Asking without waiting.** `request_capability` files a request and answers at once ("Filed as request <id>. Not decided yet." or the decision). A guest loop watches each pending request and sends one `[speaker]` message when it is decided and in force. Pending ids survive Pi restarts.

**Loops.** With `pi-cc-loop` and `pi-cc-monitor`, Pi wakes itself (`/loop`, cron jobs, `schedule_wakeup`, `Monitor`). bottle never archives for idleness; `/output/DONE` or the deadline ends the run. Example: `bottle run -d -t cron "Every weekday at 9:00, summarize new arXiv papers on X into /space/agent-space/digest.md"`. Keep anything later runs need in the agent space.

### catalog.json

`bottle/catalog.json` lists `mcps` and `extensions` the guest image provides, so it must match the image built from `guest/`. bottle sends it to speaker on every connection, and agents see it in `GET /_speaker/catalog`.

- **`mcp:<id>`:** an in-VM stdio server: `transport: "stdio"`, absolute `command`, `args`, `tools` and `write`. Granting adds it to Pi's `mcp.json` at the next restart. The shipped catalog has none. Remote MCP servers are speaker services, not catalog entries.
- **`ext:<id>`:** `guestPath` (`/opt/pi-plugins/<name>`), the `tools` to declare (Pi's `--tools` is an allowlist, so unlisted tools stay hidden), `sites` it contacts (added to the same card and ended with the extension), optional `note` and `files` (`{ "<name>.json": {…} }` written to `~/.pi/agent/` in the guest; it cannot replace Pi's own files).
- At startup bottle checks every `guestPath` against the image's manifest (`<stateRoot>/guest-plugins.txt`, copied by `bottle build`) and stops naming a wrong one.

**Adding an extension:** pin the npm package in `guest/pi-package.json` (packages declaring a `pi` extension are linked into `/opt/pi-plugins/<name>`, except `ALWAYS_ON` ones in the Dockerfile), run `bottle build`, add the entry to `catalog.json`, then reload with `pkill -HUP -f "bottle/src/server.ts"`. A bad catalog is refused and the old one stays; running agents keep theirs.

### Guest image

`guest/Dockerfile` builds a Debian slim image in five layers: apt packages; mise with Node and uv; Playwright's Chromium (also used by agent-browser); the other tools plus uv's CPython; Pi with its extensions (`guest/pi-package.json`). Every tool except Pi's comes from [`guest/locally-available-tools.md`](guest/locally-available-tools.md), one line per command with its source and purpose; the build fails if a named command is missing, and the file ships in the image for Pi to read. To add a tool, add a line there. Python is uv only; agent-browser runs Chromium with `--no-sandbox` (the VM is the sandbox) and the system certificate bundle.

`bottle build` uses `docker buildx` for the host architecture (`PI_GUEST_PLATFORMS=linux/amd64,linux/arm64` for both), then loads the image into microsandbox; it needs internet and about 10 GiB, and the first build takes over 10 minutes. Any OCI image with Node, Pi, git, curl, `socat`, `sshfs`, `dtach`, `openssh-client` and `ca-certificates` works: `docker save <image> | msb load --tag <guestImage>`. bottle never pulls.

## Models

_AI-drafted_

The VM reaches models only at `http://model.internal`. Local models are forwarded to `localModel.upstream`. A hosted provider is a speaker service (starters `openrouter`, `anthropic`, `openai`): enter its key once in speaker's Setup, set `hostedProviders[].service` to its id and launch with `-m <id>/<model>`. The agent's first request then includes `<service>.full` (a chat completion is a POST), and a prompted agent waits for that card before Pi starts. Pi's key in `models.json` is a dummy; the model door sends the call to `$SPEAKER_URL/<service>/…` with the agent's token, and speaker adds the real key and audits. Approving a provider approves every model behind it.

## The VM and its doors

_AI-drafted_

Each agent runs in a microsandbox VM (libkrun; Linux needs only `/dev/kvm`). microsandbox was chosen over Gondolin, Firecracker and smolvm as the only option offering, from one Node library on Linux and macOS, a guest with no network device, vsock-to-unix-socket routes, terminal exec and resource limits.

The guest's only doors are host unix sockets on vsock ports, exposed by `socat` as localhost ports, each in a private folder under `$XDG_RUNTIME_DIR`:

- **Egress proxy** (`HTTP_PROXY`, `HTTPS_PROXY`): one per agent, deciding each request from the live grants. An allowed `site:` goes direct (public IPv4 only). A host bound to a granted `secret:` goes through speaker's proxy as the agent: bottle holds the token, the guest only a placeholder, and the guest trusts speaker's certificate (fetched at launch; a locked speaker fails the launch). bottle never terminates TLS and never sees a secret; if speaker's proxy is unreachable it refuses rather than sending directly. Anything else is 403.
- **Model door**: counts requests against `maxModelRequests` and logs each call to `model-calls.jsonl`.
- **Speaker door** (`SPEAKER_URL`): only speaker's agent-facing routes, with the agent's token added by bottle. It refuses the hosted providers' services, so every model call goes through the model door and is counted.
- **Control channel** for Pi's status reports, and a raw door to speaker's SSH jump server (`ProxyCommand socat - VSOCK-CONNECT:2:<port>`).
- **Folders:** bottle (not Pi) mounts a `folder:` grant over `sshfs` through speaker's jump server at `/input/<share>` (`:rw` at `/space/<share>`, `-o ro` as a second guard for read-only) and unmounts it when the grant ends. Each agent gets a throwaway ed25519 key, root-only in the guest. A grant exposes the whole share.

## Archive

_AI-drafted_

Mounts: `/input` read-only shares, `/space` read-write shares, `/work` scratch and the Pi session, `/output` kept artifacts, `/etc/bottle` trusted config. Pi runs as guest root. At close bottle stops Pi, exports the session and transcript, closes the VM, deletes the agent in speaker and removes the work tree. An archive holds `artifacts/` and `_control/` (`agent.json`, grant and policy events, a hashed `manifest.json`, `pi-session.jsonl`, `transcript.html`, `model-calls.jsonl`: one line per model call with status, timing, request and raw reply, cut at 8 and 32 MiB). The owner deletes archives by hand. If archiving fails, bottle keeps the work tree. SIGINT or SIGTERM archives open agents first.

## Security boundary

_AI-drafted_

Trusted: the host, bottle, the sandbox runtime, the image, and every peer that can reach the control API (it has no login; restrict it by host networking). Not trusted: the guest, model decisions, downloaded code, files, remote tool output.

- bottle enforces expiry, revocation, network access and folder permissions independently of Pi. The egress proxy is a high-value host process; a guest client that ignores the proxy settings gets no network.
- Every approved destination can receive anything the guest can read. Placeholders protect secret values, not misuse of granted authority. If bottle were taken over, it could use a secret through speaker only while the grant is active, only to its hosts, all logged; it could not copy it.
- Stdio MCP servers and extensions run in the VM with access to guest data: never put raw secrets in their command, args or config files.
- Request caps do not bound GPU load, token use or one generation's length. Review artifacts before running them; archives may hold private content.

## Troubleshooting

_AI-drafted_

`mise run check` and `mise run test` cover configuration, network policy, templates, the speaker channel and the secret route against a real speaker proxy; they do not boot a guest. bottle runs on macOS (confirmed 2026-11-15); not yet verified there: folder mounts (FUSE in the guest). Not verified anywhere: many concurrent VMs, terminal resize.

| Symptom | Cause |
| --- | --- |
| Startup stops on `setsid` | Not installed |
| Startup stops on microsandbox storage | The folder or a parent is group- or world-writable (sticky ones like `/tmp` are fine); `chmod` the named directory |
| `speaker.token is missing` | Register the host first |
| Guest request returns 403 | Not granted, expired or revoked; the agent asks for the capability |
| Launch fails: "speaker's proxy certificate is unavailable" | Speaker is locked |
| bottle stops after a speaker restart | Speaker asks the owner to approve every host again; approve within 5 minutes |
