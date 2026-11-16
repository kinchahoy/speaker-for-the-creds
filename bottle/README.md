<!-- author: ai -->

# bottle

<sub>AI-written</sub>

bottle runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs (see The VM). Speaker approves capabilities. bottle applies their grants.
{.ai}

<!-- author: ai -->

## Host setup

<sub>AI-written</sub>

The host needs hardware virtualization, Docker for image builds, and `setsid`. On Linux, add the service account to the `kvm` group, then start a new login session. bottle also runs on macOS (Hypervisor.framework) once `setsid` is installed with `brew install util-linux`; `start.sh` finds Homebrew's keg-only copy. Run the service as the owner account that holds its configuration and archives.
{.ai}

From the repository root, run `mise trust && mise install` once, then:
{.ai}

```sh
mise run init bottle
```

The setup checks the host, asks its questions, writes `~/.bottle/config.json`, builds the guest image, registers this host with speaker, and offers to start bottle and run a smoke-test agent. It asks, in order: the control port, the guest port, speaker's URL, the model server (`host:port`), the model (a filterable list when the server has several), the guest image tag (default `bottle-guest`), whether to build the image, and whether to run the smoke test. It needs 20 GiB free for the guest image and VMs. Running it again on a set-up machine asks whether to update the install, with your current answers as the defaults; under `--yes` that needs `--force`. If speaker is locked when it registers, it asks for the owner password to unlock it. With the password (typed, piped in, or passed on from `init speaker`), `init` also approves this sandbox host itself. If you press Enter instead, it prints the `/admin` link; approve the host there, then press Enter to check again (or choose Quit). Under `--yes` it polls instead. The model server question has no default the first time: give the host:port of your OpenAI-compatible server. Every question has a flag, so it also runs unattended. `init` needs a real terminal for its prompts; scripts use `--yes` and flags, and `mise run init bottle -- --help` lists them.

Everything bottle keeps lives in one private folder (mode 700), `~/.bottle`, or `$BOTTLE_HOME` if set (at most 60 characters, because microsandbox keeps unix sockets under it):

| Path | Holds |
|---|---|
| `config.json` | the settings `init` writes |
| `config/` | `templates.json` and `catalog.json` |
| `state/` | `speaker.token` (this host's login to speaker) and each running agent's work folder |
| `output/` | one archive folder per finished agent |
| `microsandbox/` | the guest image, VM disks, and microsandbox's database (`MSB_HOME` overrides it) |
| `bottle.log` | output of a bottle that `init` started |

The repository holds only code. Each running VM also gets a few short-lived sockets in a private folder under `$XDG_RUNTIME_DIR`, removed when it stops.
{.ai}

```sh
mise run init bottle --yes --speaker-url http://192.168.1.10:3000 --model-endpoint 192.168.1.20:8080 --model my-model
```

The other flags are `--control-port`, `--guest-port`, `--image`, `--force`, `--skip-build`, `--skip-register`, and `--skip-smoke`. `--skip-build` leaves the image to build later, `--skip-register` skips registering with speaker (and so the smoke test), and `--skip-smoke` skips only the smoke-test agent. With `--password-stdin`, `init bottle` reads the owner password from standard input to unlock speaker, as `init speaker` does. If speaker runs on another machine, run `mise run init speaker` there first (see [speaker](../speaker/README.md)).
{.ai}

To configure by hand, copy `config.example.json` to `~/.bottle/config.json`. Set `configRoot`, `stateRoot`, and `outputRoot` to existing absolute directories that the service account can write. Copy `bottle/templates.json` and `bottle/catalog.json` into `configRoot`.
{.ai}

- `bindHost`: an assigned loopback, RFC1918, or Tailscale IPv4 address. The control API trusts any peer that can reach it, so keep this listener private.
- `speaker.url`: the approval service. Speaker and approved guest destinations need IPv4 reachability. The VM reaches speaker at this address, so on one machine use the machine's LAN address, not `127.0.0.1` (a VM's loopback is itself).
- `speaker.proxyPort` and `speaker.sshPort`: speaker's `PROXY_PORT` and `SSH_PORT`, on the same host as `speaker.url`. `mise run bottle register` learns them from speaker's reply and writes them here. Both are required: until you register, `init bottle` writes placeholders from `config.example.json`, so set them by hand if you skip registering.
- `localModel.upstream`: optional; leave it and `localModel.models` out (init: answer `none`) to use hosted models only. One loopback, RFC1918, or Tailscale IPv4 `host:port`, such as the inference server's LAN or `100.x` Tailscale address. The validator requires a literal IPv4 address (or `localhost`) and rejects MagicDNS names.
- `localModel.models`: the served model IDs. Name one with `--model local/<id>`, or give it an `alias`. Local inference is baseline access, independent of speaker grants.
- Any model entry may carry an `alias` (lowercase letters, digits, dashes; unique across all models). `-m` and a template's `model` accept the full id or the alias. `bottle templates` lists both. A local model is checked at launch: if the local server does not answer `/v1/models` within 2 seconds the launch fails and names the server.
- A model entry may also carry `contextWindow` (tokens). Pi assumes 128k for a model it does not know, and bottle's entries replace Pi's catalog data for hosted models too, so set it wherever the real window differs (a llama.cpp preset started with `--ctx-size 32768`, a 1M-token hosted model). Pi's `enabledModels` setting is the configured list, so Pi's startup choice and Ctrl+P cycle only through these models; `/model` still lists every model Pi knows for a configured provider.
- `hostedProviders`: each `{ "id", "service", "models", "api" }` names the speaker service that holds a hosted provider's key (see Hosted model providers). `api` is `openai-completions` (the default) or `anthropic-messages`. Name a model with `--model <id>/<model>`. Init writes the starters: `openrouter`, `anthropic` (Claude) and `openai`.
- `BOTTLE_CONFIG` selects the configuration file for the service, the CLI, and `build`. It defaults to `~/.bottle/config.json`.

<!-- author: ai -->

## Build and run

<sub>AI-written</sub>

`mise run init bottle` builds the guest image, registers the host, and can start the service. To do these steps by hand:

```sh
mise run bottle build bottle-guest
mise run bottle register   # prints the approve link; approve the sandbox host in speaker /admin
mise run bottle serve       # foreground, never stops on its own; `bottle run` instead starts it detached on demand,
                            # and that one stops 10 minutes after its last agent (`bottle down` stops either now)
```

bottle asks speaker `GET /_speaker/hosts/self` with the host token to learn whether the host is approved: 200 means approved, 401 means pending or unknown. `init` waits on it, and a lost connection to speaker uses it to tell a rejected token (fatal) from an outage (retried).

`bottle register` names the host after the machine (`--name` overrides). Registering again from the same machine and name leaves the old entry until you approve the new one, which then replaces it.

To type `bottle` instead of `mise run bottle`, link the CLI into a folder on your `PATH` once, from the repository root: `ln -s "$PWD/bottle/src/cli.ts" ~/.local/bin/bottle`. Outside this repository the link runs with mise's global `node`, so set one once with `mise use -g node@latest`. mise and uv have no command that puts a local Node script on `PATH` (mise's `[env] _.path` applies only inside the repository, and `uv tool install` is for Python), and pnpm's global link needs pnpm itself installed globally. On macOS, `~/.local/bin` is not on `PATH` by default; add it, or link into another folder that is. The Herdr mod and the Herdr + menu program below need `bottle` on `PATH`.

Launch and inspect an agent:
{.ai}

```sh
bottle run "Write a greeting to /output/greeting.txt"   # attaches to Pi's terminal; template defaults to builder
bottle run -d "Write a greeting to /output/greeting.txt"  # detached: prints the attach command and returns
bottle run -t sealed -m deepseek                               # no prompt: Pi opens and waits for you to type
bottle ls               # live agents, then the last few finished ones with their archive folders
bottle attach [<id>]    # id, unique id prefix, or name; no id attaches the only open agent; restarts Pi if it was quit
bottle stop [<id>]
bottle help run         # per-command usage
```


To keep the service running across logouts and reboots, run it as a systemd user service. Replace `<repo>` with this checkout's path, and `/usr/bin/mise` with what `command -v mise` prints:

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

Then run `systemctl --user enable --now bottle` and `loginctl enable-linger $USER`. Read its output with `journalctl --user -u bottle -f`. A stop sends TERM, which `serve` passes on so the service shuts down cleanly.

`ls` shows each agent's state, mode (attended or unattended), pending speaker approvals (with the request ID), age, model, name, and Pi's latest message. An agent's state is one of:

| State | Meaning |
| --- | --- |
| `starting` | The VM is up and Pi is starting |
| `awaiting-grant` | An agent with a prompt on a hosted model: Pi has not started and waits for you to approve the model's speaker service |
| `idle`, `busy` | Pi is waiting or working, as the guest reports |
| `reconfiguring` | Pi is restarting with new MCP servers or extensions |
| `pi-down` | A restart failed, or Pi exited right after one; the agent keeps its transcript and `stop` still exports it |
| `start-failed` | Pi never started; `stop` archives without a transcript |
| `closing` | The agent is being archived |
| `done` (shown for any live agent) | Pi wrote `/output/DONE` |

Finished agents are listed below with `archived` or `failed-archive` (the work folder is kept). `run` prints a copy-and-paste `attach` line. Errors print one line and exit with 1 (runtime) or 2 (usage).

The control API (`/api/state`, `/api/agents`, `/api/agents/<id>/close`) and the VM's doors answer every error in speaker's shape, `{"error": "<code>", "message": "...", "next": "..."}`, with the same codes: 400 `invalid` for bad input or malformed JSON, 401 or 403 `denied` (a wrong guest token, a request not from the CLI), 404 `not_found` for an unknown agent, 409 `conflict` when the agent's state forbids it (stopping an agent already closing, or launching past `maxAgents`), 429 `rate_limited`, 502 `upstream_unavailable` when speaker or an upstream fails, 500 `internal_error`. The one exception is the model door: it answers `{"error": {"message": "..."}}`, the OpenAI shape Pi's model client reads. Both packages build the shape with `errorBody` in `speaker/items.ts`. There is no status page: `bottle ls` (or `GET /api/state`) shows the agents.
{.ai}

Ctrl-\ detaches and leaves Pi running; `run` then prints the attach command and opens a Herdr tab (see In the Herdr app). Ctrl-] leaves the VM terminal. Quitting Pi (`/quit`) ends only Pi: the agent's VM, files and grants are kept, `attach` restarts Pi on the same session, and `stop` archives the agent. A one-shot agent writes `/output/DONE` only when it is complete; an attached `run` ends when the agent archives and prints where.
{.ai}

An agent is attended (you are at its terminal) or unattended (nobody is). It follows how you launched it: `run` attached is attended, `run -d` (or a run without a terminal) is unattended. `--attended` or `--unattended` overrides that. If you detach from an attended agent and Pi then asks a question, it waits for you; `bottle ls` shows it idle.
{.ai}

An attended agent loads the ask-user-question extension (the `ask_user_question` tool) whatever its template says, because the extension adds presence, not access. An unattended agent does not load it, and its system prompt says nobody is watching. The agent records its assumptions in `/output/NOTES.md`, keeps working, and still asks for access through `request_capability`, which you answer in speaker. Mode does not change archival: an agent with a prompt archives when Pi writes `/output/DONE`, and every agent archives at its deadline.
{.ai}

### In the Herdr app

When `hc` (herdr-core) is on the bottle host's `PATH`, a detached agent opens as a tab in a **bottle** space in the Herdr app on that machine: at launch with `run -d`, or when you press Ctrl-\ during an attached `run`. An attached run opens no tab, so Pi does not show twice. The CLI runs `hc run --bg --no-parent --name pi-<id> --label herdr.space=bottle --label herdr.tab=<id> -- bottle attach <id>`. The tab closes when the agent ends. The speaker Herdr mod lists open agents too; clicking one focuses its tab, or opens one. When bottle runs on another machine than the Herdr app (WSL, seen from Windows), name that Herdr machine (from `hc machine ls`) in the mod's Settings: the mod's `bottle` commands and agent terminals then run there. `"herdr": false` in `config.json` turns this off; `"herdr": true` makes a missing `hc` an error message instead of silence. Herdr names an unnamed space after its first terminal's folder (`outputRoot`), so rename the space to "bottle" once. For another machine, add it from the Mac with `hc machine add <ssh target>`.

To start a sandboxed Pi from Herdr's + menu, add a program to `~/.config/herdr-app/programs.json` (it needs `bottle` on `PATH`, see Build and run):

```json
{ "programs": { "bottle": { "name": "Pi (sandbox)", "run": ["bottle", "run"] } } }
```

`herdr/mods/speaker` in this repository is a Herdr mod for speaker's approvals: a bar with the number of waiting requests, a toast per new one, and an inbox to approve as asked, deny, or revoke. It uses speaker's owner API; installing and signing in are in speaker's README (Owner API and the Herdr mod).
{.ai}

### Guest image

`guest/Dockerfile` builds a Debian slim image in five layers:
{.ai}

1. apt system packages
2. Node, through mise
3. Playwright with Chromium
4. the other mise tools in `guest/mise.toml`, plus uv's CPython and the default environment in `guest/python/requirements.in`
5. Pi and its extensions

Pi and the extensions are one pnpm project (`guest/pi-package.json`), so they share a single Pi. The extensions stay pinned, and everything else takes the latest release.
{.ai}

`bottle build` builds the image with `docker buildx` for the host architecture. Set `PI_GUEST_PLATFORMS=linux/amd64,linux/arm64` to build both where Docker has emulation. It then loads the image into `~/.bottle/microsandbox` (or `MSB_HOME`). It needs `config.json`, so run `mise run init bottle` first. Builds need internet access and about 10 GiB of disk space.
{.ai}

The image holds:
{.ai}

- apt packages: compilers, ffmpeg, imagemagick, OCR, `socat`, `sshfs`, `dtach`, and the usual command-line tools
- mise, with Node, pnpm, uv, `gh`, ripgrep, pandoc, and tmux. mise stays in the image so agents can install Go or Rust on demand.
- Pi and its extensions
- Python through uv only. Its managed CPython is `python` and `python3`, and the default environment is in `/opt/uv/venv`. A ready uv cache in `/opt/uv/cache` is writable per VM, so `uv venv`, `uv pip install`, and `uv run --with` work offline and instantly for the default packages.
- Playwright with Chromium

You can use any OCI image instead, however you build it. It must hold Node, Pi, git, curl, `socat`, `sshfs`, `dtach`, `openssh-client`, and `ca-certificates`. Import it into microsandbox's cache under the `guestImage` name, because bottle never pulls. Loading takes one command, so another builder can replace the Dockerfile without touching bottle:
{.ai}

```sh
docker save <image> | msb load --tag <guestImage>   # into ~/.bottle/microsandbox, or MSB_HOME
```

`msb load -i <archive.tar>` takes a docker-save or OCI-layout archive from any builder. Set `"guestImage"` to the tag.
{.ai}

<!-- author: ai -->

## The VM

<sub>AI-written</sub>

Each agent runs in a microsandbox VM (libkrun, from the `microsandbox` npm package). On Linux it needs `/dev/kvm` access and nothing else, because the package carries its own runtime.
{.ai}

The guest has no network device. Its only doors are host unix sockets on guest vsock ports. In the guest, `socat` exposes four of them as localhost ports:
{.ai}

- an HTTP proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`)
- the model endpoint (`http://model.internal`)
- speaker (`SPEAKER_URL`)
- the control channel that Pi's status reports use

A fifth door gives a raw connection to speaker's SSH jump server. The guest's `ssh` reaches it through `ProxyCommand socat - VSOCK-CONNECT:2:<port>` (see the Folders bullet below).
{.ai}

Code: `src/sandbox.ts` (the VM and its doors), `src/agents.ts` (agent lifecycle as a transition table, see `ls` states above; also the archive writer), `src/speaker.ts` (the speaker connection: connecting, open, down, stopped; a link silent for 30 seconds is stale and its grants are dropped).
{.ai}

- Egress: one `proxy-chain` server per agent decides every request from the live grant view. A host on the agent's allow list goes direct (to public IPv4 addresses only). A host bound to a granted `secret:` goes through speaker's proxy with the agent's credentials. Anything else gets 403. bottle does not terminate TLS. A secret host's TLS ends at speaker's proxy, so the guest trusts speaker's proxy certificate: bottle fetches the certificate from `/_speaker/proxy/ca.pem` once when the agent launches (a locked speaker fails the launch), installs it in the guest's trust store, and sets `NODE_EXTRA_CA_CERTS`.
- Model endpoint: a small forwarder to `localModel.upstream`. It counts each request against the agent's `maxModelRequests` (a request over the cap gets a 429 that says so), streams the reply, and appends one line per call to `model-calls.jsonl`. A hosted provider's `baseUrl` in the guest's `models.json` points at `http://model.internal/hosted/<id>`. The forwarder sends `/hosted/<id>/<path>` to `<speaker.url>/<service>/<path>` with the agent's token, and nowhere else.
- Speaker: the speaker door allows only speaker's agent-facing routes and adds the agent's token itself, so the guest never holds it. `SPEAKER_TOKEN` is only a placeholder. It refuses the services behind `hostedProviders`: those are reached only through the model endpoint, so every model call counts against `maxModelRequests` and lands in `model-calls.jsonl`.
- Terminal: `bottle attach` runs `msb exec -t <vm> -- dtach -a /run/pi.dtach` with the service's microsandbox home.
- Folders: a `folder:` grant from speaker goes over `sshfs` through speaker's jump server. Speaker enforces the share, read-only grants, and revocation, and logs every file operation. Launch folders (see Templates, catalogs, and grants) are bound into the VM directly instead.
  - Each agent gets a throwaway ed25519 key. The public half goes to speaker as the agent's `sshKey`: bottle adds it to the agent's launch request and to every request the guest sends through the speaker door. The private half is a root-only file in the guest (`/run/speaker/ssh_key`).
  - While a folder grant is active, bottle (not Pi) mounts `/input/<share>` (read-write grants: `/space/<share>`) in the guest with the `sshfs` command from `GET /_speaker/catalog`. For a read-only grant it adds `-o ro` as a second guard. It remounts when the mode changes. When the grant ends or is revoked, speaker ends the relay session and bottle unmounts the share.
  - A folder grant exposes the whole configured share: read-only at `/input/<share>`, or at `/space/<share>` when the item ends in `:rw`. `/space` shares outlive the agent, so later agents may read them.
  - `sshfs` is much slower than a VM mount for `grep -r`, `find`, and `git status` over many files.
- Storage: microsandbox keeps images, VM disks, and its sockets in `~/.bottle/microsandbox`. Set `MSB_HOME` to put the guest image and VM disks (about 20 GiB) on another filesystem. It refuses a storage folder with a group- or world-writable ancestor (other than a sticky directory such as `/tmp`); `start.sh` checks this and stops with the directory to `chmod`. bottle's own door sockets go in a private folder under `$XDG_RUNTIME_DIR` (else the system temp folder).

<!-- author: ai -->

## Templates, catalogs, and grants

<sub>AI-written</sub>

`templates.json` holds an array of named templates. Each has `id`, `label`, `limits`, `want`, and `duration`, and optionally `model`, the template's default model (an id or alias), and `folders`, host folders bottle mounts into every agent from it (see Launch folders). `want` lists items (`site:pypi.org`, `ext:subagent`, `notes.read`) and may list `group:` items when speaker has a `groups.json`. `label` and `duration` are the agent's label and how long it asks for (`30m`, `1h`, `2h`, `1d`, or `30d`; default `2h`). Together they become the agent's first request to speaker: one card, labeled with the template's `label` (or the `--name` given at launch), with the reason `launch template <id>: <label>`. An empty or missing `want` asks for nothing. Duplicate IDs fail validation.

_AI-drafted_ The file ships three risk tiers, each a superset of the one before. Writes (GitHub write, `ssh:`, `.full` services) are in no template; the agent asks mid-run.

| Template | Default model | Adds |
| --- | --- | --- |
| `sealed` | `qwen` | The agent space `~/agent-space` (a launch folder, at `/space/agent-space`) and the `subagent`, `pi-cc-monitor`, `pi-cc-loop` extensions. No network. |
| `builder` | `deepseek` | Package registries, public GitHub, `context7.read`, web search, Wikipedia and arXiv. Up to 72 hours and 1500 model requests. |
| `trusted` | `deepseek` | `secret:GITHUB_READ` for private GitHub, plus `obsidian.read` and `karakeep.read`. |

`bottle run` defaults to `builder`. Model resolution is `-m`, then the template's `model`, then the first configured model. `bottle templates [--json]` prints the templates and the models with their aliases, and shows whether the local model server answers; it reads the files directly and does not need bottle running.
{.ai}

_AI-drafted_ **Launch folders.** `bottle run -f <path>[:rw]` (repeatable) and a template's `folders` mount folders of the bottle host straight into the VM, with no speaker grant or SSH: naming them at launch is the owner's approval, and the archive's `policy-events.jsonl` records each one. Read-only folders appear at `/input/<folder name>`, `:rw` ones at `/space/<folder name>`. Paths are absolute or start with `~/`; the CLI resolves relative ones against the current directory. A missing folder, or two folders with the same name, fails the launch. Folders on other machines, or ones an agent asks for mid-run, stay speaker shares (`folder:<share>`). The shipped templates mount `~/agent-space` read-write, a scratch space every agent on this host shares; create it once with `mkdir -p ~/agent-space`.
{.ai}

A template is the runtime profile bottle owns (VM size, deadline, model-request cap) plus what the agent starts with. A group is defined in speaker and names items you approve together. To change what agents start with, edit a template's `want` or the group in speaker. To change how big or how long an agent is, edit the template's limits.
{.ai}

An agent with a local model starts Pi at once and does not wait for its first request. An agent launched with a prompt that uses a hosted model starts Pi only after you approve the card with the model's service, because otherwise its first turn would fail. When an `mcp:` or `ext:` grant arrives, Pi restarts at its next idle point, resumes the same session, and gains the new tools. It does not replay the launch prompt. A one-shot unattended agent may therefore run its first turn without the extensions. If it settles before approval, it waits idle until you attach or the deadline passes. Approve the launch request promptly for unattended launches.
{.ai}

- Grant changes reach the agent in one message. Whenever bottle restarts Pi because the `mcp:` or `ext:` grants changed (a new grant, a revoke, or an expiry), it writes `change.json` next to the other guest config: `{ id, added, removed, tools: { added, removed } }`, with items and the tool names Pi registers. After the restart, the guest extension sends the agent one message built from it: the new tools that are in Pi's active tool list, the expected tools that did not load, and the removed items and tools, then "Continue the agent." The guest records the last reported `id` in `/work/.speaker/last-change-id`, so a later restart with no loadout change (a hosted model's grant arriving) says nothing. Removals reach the agent this way too, since nothing else tells it.
- Pi-alive check: after every Pi start or restart, bottle waits for Pi to finish loading (up to 60 seconds, since a cold guest disk is slow), then checks for 1 more second that it is still running. If it exited (a bad extension path or a crashing extension), the agent goes to `pi-down` with the tail of Pi's stderr (`/run/pi.err` in the guest) in its events, and the `mcp:` and `ext:` grants are not reported to speaker as in force. A failed first start is `start-failed`. This needs the guest image rebuilt for the stderr capture; without it the note says no stderr was captured.
- VM limits cover CPU, memory, and the disposable root disk. `maxRuntimeHours` ends an agent at its deadline. The optional `maxModelRequests` caps the model request count.
- `workGiB` is a launch-time free-space check. Enforce work and output quotas through the host filesystem before unattended agents share a disk with other services.
- `catalog.json` holds `mcps` and `extensions`. On every connection bottle sends speaker this catalog (ids, labels, tools, sites) in a `catalog` message; speaker lists it to agents in `GET /_speaker/catalog`, and the `request_capability` tool shows that list in its description.
  - An `mcp:<id>` entry is an MCP server that runs inside the VM from an image-local command: `transport: "stdio"`, an absolute `command`, `args`, the advertised `tools`, and whether it can write.
    ```json
    {
      "mcps": {
        "files": { "label": "Project files", "transport": "stdio", "command": "/opt/mcp/files", "args": ["--root", "/work"], "tools": ["read-file", "list-dir"], "write": false }
      },
      "extensions": {}
    }
    ```

    Each tool name is lowercase letters, digits, `_` or `-`, and the list must be non-empty with no repeats. Pi registers them as `mcp__files__read_file` and so on. Granting `mcp:files` writes the server into Pi's `mcp.json` at the next restart, and a revoke or expiry removes it the same way.
  - Remote and hosted MCP servers are not catalog entries; they are speaker services. Add one in speaker's Setup (tick "MCP server"; `speaker/services.example.json` has Context7 and Parallel Search). An agent asks for `<service>.read` (or `.full`) and calls `$SPEAKER_URL/<service>` with its speaker token. So the shipped catalog has no `mcps` entries, and a remote entry fails validation with that explanation.
  - An extension entry names a reviewed image-local path (`/opt/pi-plugins/<name>` for the pinned npm packages), the tools to declare to the model (Pi's `--tools` is an allowlist), the `sites` it contacts (speaker adds them to a request for it), an optional system-prompt note, and optional `files` (config file name under `~/.pi/agent` to JSON or string content; see Add an extension). An `ext:<id>` grant loads the extension. Like other unsupported grants, unknown IDs are skipped. The shipped entries are pi-web-access, pi-cc-loop, pi-cc-monitor, and Pi's subagent example (formerly the `subagent@1` plugin).
- bottle reads `catalog.json` at startup and checks that every extension's `guestPath` is in the guest image. `bottle build` copies the image's `/opt/pi-plugins.manifest` to `<stateRoot>/guest-plugins.txt`, so the check needs no VM. A wrong path stops startup naming the entry. A missing manifest means the image was not built with this bottle: run `bottle build`.
- Every agent loads only the always-on extensions pi-loop-police and pi-token-speed from `/opt/pi-extensions`. Every other Pi package is pinned in `guest/pi-package.json` and loads only through a grant or, for ask-user-question, attended mode.
- Pi's instructions name the catalog's `mcp:` and `ext:` entries, the secrets you set up in speaker (names, hosts, and the variable each uses; speaker sends this list with its grant snapshots), the `<service>.read` and `.full` forms for homelab APIs and remote MCP servers, and how to use a secret.
- Each snapshot from speaker replaces the live grants. A grant takes effect once bottle reports it applied. Sites, secrets, and folders apply the moment they are installed. An MCP server or extension applies only after Pi restarts with it, at an idle point. bottle skips unsupported items. If it hears nothing from speaker for 30 seconds (the connection is lost, or snapshots stopped), it drops all its agents' grants until the connection returns. An agent's grants therefore end within 30 seconds of losing speaker, and a brief blip changes nothing.
- Folders come over SSH: speaker sends the over-SSH folder grants to the host, which mounts them with `sshfs`.

### Asking for access without waiting

`request_capability` never holds the agent. It files the request with speaker and answers at once: with the decision if there already is one (auto-denied, invalid, or granted and in force), otherwise "Filed as request <id>. Not decided yet." and the agent keeps working. A background loop in the guest extension watches each pending request by id (`GET /_speaker/requests/<id>` with `Speaker-Wait`), one long-poll at a time, so it never files a request twice; when the owner decides, it waits for items that apply at once to be in force and sends the agent one message starting `[speaker]` (steered into the current run, or a new turn if Pi is idle). Repeat calls for the same items answer "already pending". Pending requests live in `/work/.speaker/pending.json`, so a Pi restart re-arms them and a decision that landed meanwhile is delivered on start. `ext:` and `mcp:` grants no longer ask the agent to stop: bottle restarts Pi at its next idle, and the existing "now available / did not load / removed" message follows.

<!-- author: ai -->

## Secrets and speaker's proxy

<sub>AI-written</sub>

bottle never holds a secret. You add each secret once in speaker's Setup, with its allowed hosts and the variable the agent sees (for example `GH_TOKEN`). An agent asks for `secret:<NAME>`, and the card shows the hosts.
{.ai}

The grant snapshot for a secret carries the secret's hosts, not its value. bottle's egress proxy sends every request the VM makes to those hosts through speaker's HTTPS proxy (`PROXY_PORT`; see speaker's README) as a CONNECT tunnel authenticated as the agent. bottle holds that token; the guest has only a placeholder. The guest's TLS for those hosts ends at speaker's proxy, whose certificate the guest trusts (see the Egress bullet under The VM). [speaker's DESIGN.md](../speaker/DESIGN.md#secrets-speaker-inserts-them) covers what speaker does next. bottle drops the route when its grant goes. Pi gets the placeholder from `GET /_speaker/catalog` and sets the variable on the command that needs it. If speaker's proxy is unreachable, bottle refuses the request and never sends it directly.
{.ai}

### Hosted model providers

A hosted provider is a speaker service, such as the starter `openrouter`, `anthropic` and `openai` services; you enter its key once, in speaker's Setup. In `config.json`, set `hostedProviders[].service` to the service's id. Launch with `-m <id>/<model>`. The agent adds `<service>.full` to its first request (a chat completion is a POST). Pi's key in `models.json` is a dummy: the model endpoint replaces it with the agent's token and sends the call to `$SPEAKER_URL/<service>/...`, where speaker checks the grant, adds the real key, forwards, and audits. Neither bottle nor the VM ever has the key. Until you grant the service, speaker refuses the calls. That is why an agent with a prompt on a hosted model waits for this card before Pi starts (see Templates, catalogs, and grants).
{.ai}

<!-- author: ai -->

## Add an extension

<sub>AI-written</sub>

1. Pin the npm package in `guest/pi-package.json`. Any dependency that declares a `pi` extension is linked automatically into `/opt/pi-plugins/<name>` (the part after the scope), except the always-on ones (`ALWAYS_ON` in the Dockerfile), which go to `/opt/pi-extensions`. There is no link list to edit.
2. Run `bottle build`. The image is rebuilt and the plugin manifest is copied to `<stateRoot>/guest-plugins.txt`.
3. Add an entry to the live `<configRoot>/catalog.json` (`~/.bottle/config/catalog.json`; `bottle/catalog.json` has the shipped ones): `label`, `guestPath` (`/opt/pi-plugins/<name>`), `description`, `tools`, `sites`, and optionally `note` and `files`. `tools` must be the names the package registers, because Pi's `--tools` is an allowlist and an unlisted tool stays hidden. The `sites` are hosts the extension itself contacts; when the extension is requested they are added as separate `site:` grants and end with the extension's grant.
4. Optional `files`: `{ "<name>.json": { ... } }` writes `~/.pi/agent/<name>.json` in the guest, only for agents that load the extension (a string value is written as is, anything else as JSON). A name has no directory part and cannot replace bottle's own `models.json`, `settings.json`, `mcp.json`, or `APPEND_SYSTEM.md`. The shipped `pi-web-access` entry is the example, with browser cookies and hosted extraction off.
5. Reload without restarting: `pkill -HUP -f "bottle/src/server.ts"`. The catalog is re-validated against the image, swapped in, and re-sent to speaker. A bad catalog is refused (the SIGHUP logs it) and the old one stays. Running agents are not restarted for a new or changed entry. A grant for an entry you removed is skipped with an agent note, and that agent's Pi restarts at its next idle point without it.
{.ai}

<!-- author: ai -->

## Research and loop presets

<sub>AI-written</sub>

The `research` group (in speaker's `groups.example.json`; an agent or a template's `want` asks for `group:research`) grants the `pi-web-access` extension, the site `mcp.exa.ai`, and the Wikipedia and arXiv sites. The extension's `~/.pi/agent/web-search.json` is the `files` entry of `pi-web-access` in `catalog.json`, written only into agents that load it. Search uses only keyless Exa through its hosted MCP endpoint, and pages are fetched directly over HTTP. Hosted extraction services, browser cookies, the curator browser UI, and the video and YouTube paths are off. A page fetch still needs a `site:` grant for its host, so the agent requests hosts beyond Wikipedia and arXiv.
{.ai}

The group leaves out Parallel Search. It duplicated search for a small local model, and its hosted `web_fetch` would read any page without a site grant. Parallel Search is a speaker service (`parallel-search.read`) that the agent can request explicitly.
{.ai}

No search API keys are configured. To add a keyed provider, add its key as a speaker secret with the provider's host, set the provider's key field (for example `exaApiKey`) to the agent's placeholder for that secret (see `GET /_speaker/catalog`). The catalog's `files` are static, so this needs a small change in `writeGuestConfig`. Then approve `secret:<NAME>`.
{.ai}

The `loop` group holds pi-cc-loop and pi-cc-monitor; the `sealed` template asks for both extensions for one day. Pi then wakes itself with `/loop`, cron jobs, `schedule_wakeup`, or `Monitor`. bottle never archives an agent for being idle, so a self-waking Pi keeps running between wakes. `/output/DONE` or the deadline still ends it. Durable jobs live in `/work/.pi/scheduled_agents.json`. They survive Pi restarts within the agent and disappear with the work directory at archival. Persisting jobs across agents through a folder grant is future work.
{.ai}

<!-- author: ai -->

<!-- author: ai -->

## Names and tokens

bottle uses speaker's words: a **grant** is an approved item for an **agent** (`agentId`), and extensions are `ext:<id>` items. Each agent has three tokens, named the same in the code:

| Name in code | Guest sees | What it is |
| --- | --- | --- |
| `hostToken` | nothing | This sandbox host's login to speaker (`state/speaker.token`) |
| `agentToken` | `SPEAKER_TOKEN`, a placeholder | The agent's token at speaker; the speaker door adds it to the guest's requests |
| `guestToken` | `BOTTLE_TOKEN` | bottle's per-agent token for the guest's status reports to the control channel |

VMs are named `bottle-<id>`; at startup the service removes any left behind by a crash.

## Who receives credentials

<sub>AI-written</sub>

| Credential path | What the guest sees | Who holds the real value |
| --- | --- | --- |
| A speaker secret (`secret:<NAME>`) | A per-agent placeholder from speaker's `/me` | Speaker only. Its proxy inserts it for the secret's hosts; bottle never has it |
| Remote MCP server or hosted model provider | Nothing: it is a speaker service (`$SPEAKER_URL/<service>`) | Speaker, which adds any upstream key |
| Agent token | A per-agent placeholder (`SPEAKER_TOKEN`) | bottle, which created the agent; the speaker door adds it only to requests to speaker. It is bound to this host's address |
| Local model endpoint | The literal API key `local` (not a secret) | The configured local inference server receives prompts; no real API key is substituted |
| stdio MCP | Its configured command and arguments inside the guest | No host secret is automatically injected into stdio MCPs |

The destination of a secret's requests receives the real credential and the request content. Speaker's proxy logs agent, host, method, path, and status, never the value or bodies. Stdio MCPs and guest plugins run inside the VM with access to guest data, so do not put raw secrets in their command, arguments, or configuration.
{.ai}

Placeholder substitution keeps the real value off the guest and off bottle. It does not stop an approved destination from using the granted access. If someone took over bottle, they could make requests through speaker only while the grant is active, only to the secret's hosts, and every request is logged. They could not copy the secret.
{.ai}

<!-- author: ai -->

## Agent archive

<sub>AI-written</sub>

bottle mounts `/input` for read-only shares, `/space` for read-write shares, `/work` for disposable scratch and the Pi session, `/output` for retained artifacts, and `/etc/bottle` for trusted read-only configuration. Pi runs as guest root.
{.ai}

At close, bottle stops Pi, exports the session and transcript, writes the trusted records, closes the VM, deletes its speaker agent, and removes the disposable work tree. Each archive holds `artifacts/` and `_control/`. The control directory holds agent metadata, grant and policy events, a hashed artifact manifest, the Pi session and transcript, and `model-calls.jsonl`.
{.ai}

`model-calls.jsonl` has one JSON line per model call: `at`, `status`, `durationMs`, the `request` body and the raw `reply` body (a streamed reply stays as its event stream), and `truncated`. Bodies are cut at 8 MiB for a request and 32 MiB for a reply. Tool calls are in Pi's session file.
{.ai}

You delete archives manually. If archiving fails, bottle keeps the work tree for recovery and reports the failure. You cannot retroactively revoke a completed write or a note the agent already read. Treat captured prompts, replies, and artifacts as private data.
{.ai}

<!-- author: ai -->

## Verification and troubleshooting

<sub>AI-written</sub>

Run `mise run check` and `mise run test` from the repository root. The tests cover configuration, network and ref policy, templates and their first request, the speaker channel (grants, applied reports, the 30-second drop), and the secret route against a real speaker proxy. They do not boot a guest.
{.ai}

Before deployment, verify register, launch, request, approval, expiry, revocation, attach, and archive in a real VM. Also check (registration records speaker's `PROXY_PORT` as `speaker.proxyPort` here):
{.ai}

- `gh` and `git` with a granted secret through the egress proxy: the placeholder goes in, the real value appears only at the real host, and a `git clone` works through speaker
- a revoke ends that access
- the model-request capture for routed requests
- certificate inheritance through dtach
- terminal behavior

bottle runs on macOS (confirmed 2026-11-15). Not yet verified: folder mounts (FUSE in the guest) on macOS, many concurrent VMs, and terminal resize.
{.ai}

- A missing `setsid` stops startup with a clear error. So does a microsandbox storage folder or parent that is group- or world-writable.
- `speaker.token is missing` means you must register the sandbox host first.
- A blocked guest request returns 403. The agent requests the required capability. An expired or revoked grant also blocks later use. If an agent's launch fails with "speaker's proxy certificate is unavailable", speaker is locked.
- The service archives open agents on SIGINT or SIGTERM. Inspect the archive outcome before you discard recovery files.

<!-- author: ai -->

## Security boundary

<sub>AI-written</sub>

You trust the host, bottle, the sandbox runtime, the pinned image, and every peer that can reach the private control listener. You do not trust the guest, model decisions, downloaded code, files, or remote tool output. The control API has no application login, so restrict access to the control listener through host networking.
{.ai}

- The host enforces grant expiry, revocation, network access, and shared-folder permissions independently of Pi. Validate those boundaries in a real guest before deployment.
- Every approved destination can receive anything the guest can read. Placeholder substitution in speaker's proxy protects secret values. It does not prevent misuse of granted authority.
- The speaker exception permits the configured origin and agent-facing routes. Guest HTTP egress rejects IPv6 until its complete address policy is implemented and tested.
- Provide host storage quotas. Request counts do not bound GPU concurrency, token consumption, or the duration of a single generation.
- Review artifacts before you run them or promote them onto the host. Archives may contain private agent content.
