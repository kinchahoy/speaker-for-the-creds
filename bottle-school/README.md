<!-- author: ai -->

# bottle-school

<sub>AI-written</sub>

bottle-school runs the Pi coding agent in disposable [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs (see The VM). Speaker approves capabilities. bottle-school applies their leases.
{.ai}

<!-- author: ai -->

## Host setup

<sub>AI-written</sub>

The Linux host needs hardware virtualization, KVM access, Docker for image builds, and `setsid`. Add the service account to the `kvm` group, then start a new login session. Run the service as the owner account that holds its configuration and archives.
{.ai}

From the repository root, run `mise trust && mise install` once, then:
{.ai}

```sh
mise run init bottle-school
```

The setup needs 20 GiB free on the chosen home. The default home is `~/.local/share/bottle-school`, and everything in it is created private (mode 700). The control and guest ports default to 7001 and 7002. The setup checks the host, asks its questions, writes `bottle-school/config.json`, builds the guest image, registers this host with speaker, and offers to start bottle-school and run a smoke-test task. It asks for the guest image tag (default `bottle-school-guest`). If speaker is locked when it registers, it asks for the owner password to unlock it; press Enter to sign in at speaker's `/admin` yourself. Every question has a flag, so it also runs unattended:
{.ai}

```sh
mise run init bottle-school --yes --speaker-url http://192.168.1.10:3000 --model-endpoint 192.168.1.20:8080 --model my-model
```

The other flags are `--home`, `--control-port`, `--guest-port`, `--image`, `--config`, `--force`, `--skip-build`, `--skip-register`, and `--skip-smoke`. With `--password-stdin`, `init bottle-school` reads the owner password from standard input to unlock speaker, as `init speaker` does. If speaker runs on another machine, run `mise run init speaker` there first (see [speaker](../speaker/README.md)). `mise run doctor` rechecks the host later.
{.ai}

To configure by hand, copy `config.example.json` to `config.json`. Set `configRoot`, `stateRoot`, and `outputRoot` to existing absolute directories that the service account can write. Copy `bottle-school/templates.json` and `bottle-school/catalog.json` into `configRoot`.
{.ai}

- `bindHost`: an assigned loopback, RFC1918, or Tailscale IPv4 address. The control API trusts any peer that can reach it, so keep this listener private.
- `speaker.url`: the approval service. Speaker and approved guest destinations need IPv4 reachability. The VM reaches speaker at this address, so on one machine use the machine's LAN address, not `127.0.0.1` (a VM's loopback is itself).
- `speaker.proxyPort` and `speaker.sshPort`: speaker's `PROXY_PORT` and `SSH_PORT`, on the same host as `speaker.url`. `mise run bottle-cli register` learns them from speaker's reply and writes them here. Set them by hand only if you skip registering. `secret:` items need the proxy port; without it, a task granted a secret cannot reach the secret's hosts. `folder:` grants need the SSH port (see The VM).
- `localModel.upstream`: one loopback, RFC1918, or Tailscale IPv4 `host:port`, such as the inference server's LAN or `100.x` Tailscale address. The validator requires a literal IPv4 address (or `localhost`) and rejects MagicDNS names.
- `localModel.models`: the served model IDs. Name one with `--model local/<id>`. Local inference is baseline access, independent of speaker leases.
- `shareRoots`: bottle-school reports its names to speaker as not mountable. It checks the paths only at config load. It has no effect on folder delivery, because folders always arrive over SSH. It stays so older configs still load.
- `BOTTLE_SCHOOL_CONFIG` selects the configuration file for the service, the CLI, `doctor`, and `guest-build`. It defaults to `bottle-school/config.json`. The older names `PI_V2_CONFIG` and `BOTTLE_CONFIG` still work for one release and print a deprecation note.

<!-- author: ai -->

## Build and run

<sub>AI-written</sub>

`mise run init bottle-school` builds the guest image, registers the host, and can start the service. To do these steps by hand:

```sh
mise run guest-build bottle-school-guest
mise run bottle-cli register   # prints the approve link; approve the sandbox host in speaker /admin
mise run bottle
```

From another terminal, launch and inspect a task:
{.ai}

```sh
mise run bottle-cli run --prompt "Write a greeting to /output/greeting.txt"   # template defaults to offline
mise run bottle-cli run --template research --attended   # you stay at the terminal; Pi may ask you questions
mise run bottle-cli ls
mise run bottle-cli attach <id>      # id, unique id prefix, or name
mise run bottle-cli stop <id>
mise run bottle-cli help run         # per-command usage (mise intercepts --help after the task name)
```

`ls` shows each task's state, mode (attended or unattended), pending speaker approvals (with the request ID), age, model, name, and Pi's latest message. `run` prints a copy-and-paste `attach` line. Errors print one line and exit with 1 (runtime) or 2 (usage).
{.ai}

Ctrl-\ detaches from dtach. Ctrl-] leaves the VM terminal. Inside herdr, the CLI opens a pane and reports working, idle, or blocked. A one-shot task writes `/output/DONE` only when it is complete.
{.ai}

A task is attended (you are at its terminal) or unattended (nobody is). Without `--prompt`, a task defaults to attended. With one, it defaults to unattended. `--attended` or `--unattended` overrides the default. A template's `"attended"` fixes the mode, and a flag that contradicts the template is refused.
{.ai}

An attended task loads the ask-user-question extension (the `ask_user_question` tool) whatever its template says, because the extension adds presence, not access. An unattended task does not load it, and its system prompt says nobody is watching. The agent records its assumptions in `/output/NOTES.md`, keeps working, and still asks for access through `request_capability`, which you answer in speaker. Mode does not change archival: a task with a prompt archives when Pi writes `/output/DONE`, and every task archives at its deadline.
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

`guest-build` builds the image with `docker buildx` for the host architecture. Set `PI_GUEST_PLATFORMS=linux/amd64,linux/arm64` to build both where Docker has emulation. It then loads the image into microsandbox's storage under `<stateRoot>/microsandbox` (`stateRoot` from `config.json`). It needs `config.json`, so run `mise run init bottle-school` first. Builds need internet access and about 10 GiB of disk space.
{.ai}

The image holds:
{.ai}

- apt packages: compilers, ffmpeg, imagemagick, OCR, `socat`, `sshfs`, `dtach`, and the usual command-line tools
- mise, with Node, pnpm, uv, `gh`, ripgrep, pandoc, and tmux. mise stays in the image so agents can install Go or Rust on demand.
- Pi and its extensions
- Python through uv only. Its managed CPython is `python` and `python3`, and the default environment is in `/opt/uv/venv`. A ready uv cache in `/opt/uv/cache` is writable per VM, so `uv venv`, `uv pip install`, and `uv run --with` work offline and instantly for the default packages.
- Playwright with Chromium

You can use any OCI image instead, however you build it. It must hold Node, Pi, git, curl, `socat`, `sshfs`, `dtach`, `openssh-client`, and `ca-certificates`. Import it into microsandbox's cache under the `guestImage` name, because bottle-school never pulls. Loading takes one command, so another builder can replace the Dockerfile without touching bottle-school:
{.ai}

```sh
docker save <image> | MSB_HOME=<stateRoot>/microsandbox msb load --tag <guestImage>
```

`msb load -i <archive.tar>` takes a docker-save or OCI-layout archive from any builder. Set `"guestImage"` to the tag.
{.ai}

<!-- author: ai -->

## The VM

<sub>AI-written</sub>

Each task runs in a microsandbox VM (libkrun, from the `microsandbox` npm package). On Linux it needs `/dev/kvm` access and nothing else, because the package carries its own runtime. `mise run doctor` checks that the guest image loads and boots.
{.ai}

The guest has no network device. Its only doors are host unix sockets on guest vsock ports. In the guest, `socat` exposes four of them as localhost ports:
{.ai}

- an HTTP proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`)
- the model endpoint (`http://model.internal`)
- speaker (`SPEAKER_URL`)
- the control channel that Pi's status reports use

When `speaker.sshPort` is set, a fifth door gives a raw connection to speaker's SSH jump server. The guest's `ssh` reaches it through `ProxyCommand socat - VSOCK-CONNECT:2:<port>` (see the Folders bullet below).
{.ai}

Code: `src/sandbox.ts` (the VM and its doors), `src/trace.ts` (HTTP capture, trace records, archive writing), `src/tasks.ts` (task lifecycle as a transition table: starting, idle, busy, reconfiguring, closing, archived, failed, failed-archive), `src/speaker.ts` (the speaker connection: connecting, open, down, stopped).
{.ai}

- Egress: one `proxy-chain` server per task decides every request from the live lease view. A host on the task's allow list goes direct (to public IPv4 addresses only). A host bound to a granted `secret:` goes through speaker's proxy with the task agent's credentials. Anything else gets 403. bottle-school does not terminate TLS. A secret host's TLS ends at speaker's proxy, so the guest trusts speaker's proxy certificate: it fetches the certificate from `/_speaker/proxy/ca.pem` at boot, installs it in the guest's trust store, and sets `NODE_EXTRA_CA_CERTS`. Without `speaker.proxyPort`, secrets are unavailable.
- Model endpoint: a small forwarder to `localModel.upstream`. It counts each request against the task's `maxModelRequests` (a request over the cap gets a 429 that says so), streams the reply, and records bodies for `trace.jsonl`. A hosted provider's `baseUrl` in the guest's `models.json` points at `http://model.internal/hosted/<id>/...`. Once the provider's secret is granted, the forwarder sends those requests through speaker's proxy.
- Speaker: the speaker door allows only speaker's subject-facing routes and adds the task's token itself, so the guest never holds it. `SPEAKER_TOKEN` is only a placeholder.
- Terminal: `bottle-cli attach` runs `msb exec -t <vm> -- dtach -a /run/pi.dtach` with the service's microsandbox home.
- Folders: they go over `sshfs` through speaker's jump server. Speaker enforces the share, read-only grants, and revocation, and logs every file operation. Folders always come over SSH, so bottle-school reports every share as not mountable, and speaker delivers each `folder:` grant through its jump server.
  - Each task gets a throwaway ed25519 key. The public half goes to speaker as the agent's `sshKey`: bottle-school adds it to the task's launch request and to every request the guest sends through the speaker door. The private half is a root-only file in the guest (`/run/speaker/ssh_key`).
  - While a folder grant is active, bottle-school (not Pi) mounts `/input/<share>` in the guest with the `sshfs` command from `GET /_speaker/me`. For a read-only grant it adds `-o ro` as a second guard. It remounts when the mode changes. When the grant ends or is revoked, speaker ends the relay session and bottle-school unmounts the share.
  - A folder grant exposes the whole configured share at `/input/<share>`, read-only unless the item ends in `:rw`.
  - Set `speaker.sshPort`. Without it, the guest has no route to speaker's SSH port, and the folder grant fails to mount (the task's events note this).
  - A share needs no entry in `shareRoots`. `sshfs` is much slower than a VM mount for `grep -r`, `find`, and `git status` over many files.
- Storage: microsandbox keeps images and VM records in `<stateRoot>/microsandbox`, created with mode 700. It refuses a storage folder with a group- or world-writable ancestor (other than a sticky directory such as `/tmp`), so use a `stateRoot` whose parents are not group-writable. `start.sh` checks this and stops with the directory to `chmod 700`.

<!-- author: ai -->

## Templates, catalogs, and leases

<sub>AI-written</sub>

`templates.json` holds an array of named templates. Each has `id`, `label`, `limits`, `want`, and `duration`, and optionally `attended`, which fixes the launch mode. `want` lists items and groups (`group:developer`, `site:pypi.org`, `notes.read`). `label` and `duration` are the task's label and how long it asks for (`30m`, `1h`, `2h`, `1d`, or `30d`; default `2h`). Together they become the task's first request to speaker: one card, labeled with the template's `label` (or the `--name` given at launch), with the reason `launch template <id>: <label>`. An empty or missing `want` asks for nothing (the `offline` preset). The file ships the developer, github-read, loop, offline, packages, and research presets. Duplicate IDs fail validation.
{.ai}

A template is the runtime profile bottle-school owns (VM size, deadline, model-request cap, attended mode) plus what the task starts with. A group is defined in speaker and names items you approve together. To change what tasks start with, edit a template's `want` or the group in speaker. To change how big or how long a task is, edit the template's limits.
{.ai}

A task with a local model starts Pi at once and does not wait for its first request. A task launched with `--prompt` that uses a hosted model starts Pi only after you approve the card with the model key, because otherwise its first turn would fail. When an `mcp` or `extension` grant arrives, Pi restarts at its next idle point, resumes the same session, and gains the new tools. It does not replay the launch prompt. A one-shot unattended task may therefore run its first turn without the extensions. If it settles before approval, it waits idle until you attach or the deadline passes. Approve the launch request promptly for unattended templates such as `loop`.
{.ai}

- VM limits cover CPU, memory, and the disposable root disk. `maxRuntimeHours` ends a task at its deadline. The optional `maxModelRequests` caps the model request count.
- `workGiB` is a launch-time free-space check. Enforce work and output quotas through the host filesystem before unattended tasks share a disk with other services.
- `catalog.json` holds `mcps` and `extensions`.
  - An `mcp:<id>` entry is an MCP server that runs inside the VM from an image-local command: `transport: "stdio"`, an absolute `command`, `args`, the advertised `tools`, and whether it can write.
  - Remote and hosted MCP servers are not catalog entries; they are speaker services. Add one in speaker's Setup (tick "MCP server"; `speaker/services.example.json` has Context7 and Parallel Search). A task asks for `<service>.read` (or `.full`) and calls `$SPEAKER_URL/<service>` with its speaker token. So the shipped catalog has no `mcps` entries, and a remote entry fails validation with that explanation.
  - An extension entry names a reviewed image-local path (`/opt/pi-plugins/<name>` for the pinned npm packages), the tools to declare to the model (Pi's `--tools` is an allowlist), and an optional system-prompt note. An `ext:<id>` grant loads the extension. Like other unsupported grants, unknown IDs are skipped. The shipped entries are pi-web-access, pi-cc-loop, pi-cc-monitor, and Pi's subagent example (formerly the `subagent@1` plugin).
- Every task loads only the always-on extensions pi-loop-police and pi-token-speed from `/opt/pi-extensions`. Every other Pi package is pinned in `guest/pi-package.json` and loads only through a grant or, for ask-user-question, attended mode.
- Pi's instructions name the catalog's `mcp:` and `ext:` entries, the secrets you set up in speaker (names, hosts, and the variable each uses; speaker sends this list with its grant snapshots), the `<service>.read` and `.full` forms for homelab APIs and remote MCP servers, and how to use a secret.
- Each snapshot from speaker replaces the live grants. A grant takes effect once bottle-school reports it applied. Sites, secrets, and folders apply the moment they are installed. An MCP server or extension applies only after Pi restarts with it, at an idle point. bottle-school skips unsupported refs. If it hears nothing from speaker for 30 seconds (the connection is lost, or snapshots stopped), it drops all its tasks' grants until the connection returns. A task's grants therefore end within 30 seconds of losing speaker, and a brief blip changes nothing.
- On every connection, bottle-school reports the names in `shareRoots` to speaker, each as not mountable, because folders come over SSH. For `folder:` items, speaker uses this report, not the kinds the host registered with, to choose between a VM mount (reported mountable) and delivery over SSH (otherwise). It sends the over-SSH folder grants to the host, which mounts them with `sshfs`.

<!-- author: ai -->

## Secrets and speaker's proxy

<sub>AI-written</sub>

bottle-school never holds a secret. `secrets.env` and the `BROKER_SECRET_*` variables are retired, and startup stops with a message while either is present. You add each secret once in speaker's Setup, with its allowed hosts and the variable the agent sees (for example `GH_TOKEN`). A task asks for `secret:<NAME>`, and the card shows the hosts.
{.ai}

The grant snapshot for a secret carries the secret's hosts, not its value. bottle-school's egress proxy sends every request the VM makes to those hosts through speaker's HTTPS proxy (`PROXY_PORT`; see speaker's README) as a CONNECT tunnel authenticated as the task's agent. bottle-school holds that token; the guest has only a placeholder. The guest's TLS for those hosts ends at speaker's proxy, whose certificate the guest trusts (see the Egress bullet under The VM). [speaker's DESIGN.md](../speaker/DESIGN.md#secrets-speaker-inserts-them) covers what speaker does next. bottle-school drops the route when its grant goes. Pi gets the placeholder from `GET /_speaker/me` and sets the variable on the command that needs it. If speaker's proxy is unreachable, bottle-school refuses the request and never sends it directly.
{.ai}

### Hosted model providers

A hosted provider's key is a speaker secret like any other. In `config.json`, set `hostedProviders[].credential` to the secret's name, and add the provider's API host as one of the secret's allowed hosts in speaker's Setup. Launch with `--model <provider>/<model>`. The task adds `secret:<credential>` to its first request. Once you grant it, bottle-school asks speaker for the task's placeholder, writes it into `models.json`, and restarts Pi at idle. The VM holds only the placeholder; speaker's proxy replaces it with the key. Until then, Pi's key reads `speaker-secret-<NAME>-not-granted-yet`. That is why a `--prompt` task on a hosted model waits for this card before Pi starts (see Templates, catalogs, and leases).
{.ai}

<!-- author: ai -->

## Research and loop presets

<sub>AI-written</sub>

The `research` group (the `research` template asks for it) grants the `pi-web-access` extension, the site `mcp.exa.ai`, and the Wikipedia and arXiv sites. bottle-school writes the extension's `~/.pi/agent/web-search.json` (`pi-launch` copies it like `settings.json`). Search uses only keyless Exa through its hosted MCP endpoint, and pages are fetched directly over HTTP. Hosted extraction services, browser cookies, the curator browser UI, and the video and YouTube paths are off. A page fetch still needs a `site` grant for its host, so the agent requests hosts beyond Wikipedia and arXiv.
{.ai}

The group leaves out Parallel Search. It duplicated search for a small local model, and its hosted `web_fetch` would read any page without a site grant. Parallel Search is a speaker service (`parallel-search.read`) that the agent can request explicitly.
{.ai}

No search API keys are configured. To add a keyed provider, add its key as a speaker secret with the provider's host, make `writeGuestConfig` set the provider's key field (for example `exaApiKey`) to the task's placeholder for that secret (see `GET /_speaker/me`), and approve `secret:<NAME>`.
{.ai}

The `loop` template is unattended. It runs at most 24 hours and 300 model requests, and it asks for `group:loop` (pi-cc-loop and pi-cc-monitor) for one day. Pi then wakes itself with `/loop`, cron jobs, `schedule_wakeup`, or `Monitor`. bottle-school never archives a task for being idle, so a self-waking Pi keeps running between wakes. `/output/DONE` or the deadline still ends it. Durable jobs live in `/work/.pi/scheduled_tasks.json`. They survive Pi restarts within the task and disappear with the work directory at archival. Persisting jobs across tasks through a folder grant is future work.
{.ai}

<!-- author: ai -->

## Upgrading an existing install

<sub>AI-written</sub>

- Secrets move to speaker: add each `BROKER_SECRET_<NAME>` from `secrets.env` in speaker's Setup (name, value, allowed hosts, the variable the agent sees). Delete `secrets.env` and the `BROKER_SECRET_*` variables. Register again, which learns speaker's `PROXY_PORT`, and publish that port. In old groups, a grant for `secret:<NAME>@host` becomes `secret:<NAME>`: the hosts come from the secret's Setup entry. Hosted model providers keep their `credential` name, which must now name a speaker secret.
- Config files: the `templates/` and `catalog/` directories became `templates.json` and `catalog.json`. Copy the new files into `configRoot`.
- Templates: `bundle` becomes `want: ["group:<name>"]`, and `bundleDuration` becomes `duration`. The old keys fail validation. Edit your `templates.json` or copy the new one.
- Catalog: remove remote MCP entries from `catalog.json`; `mcps` keeps only servers that run inside the VM. Add the remote ones in speaker's Setup as services (tick "MCP server"), and replace `mcp:<id>` in groups and templates with `<service>.read`. See `speaker/services.example.json` and `speaker/groups.example.json`.

<!-- author: ai -->

## Who receives credentials

<sub>AI-written</sub>

| Credential path | What the guest sees | Who holds the real value |
| --- | --- | --- |
| A speaker secret (`secret:<NAME>`, including a hosted model provider's key) | A per-agent placeholder from speaker's `/me` | Speaker only. Its proxy inserts it for the secret's hosts; bottle-school never has it |
| Remote MCP server | Nothing: it is a speaker service (`$SPEAKER_URL/<service>`) | Speaker, which adds any upstream key |
| Speaker agent token | A per-task placeholder (`SPEAKER_TOKEN`) | bottle-school, which created the agent; the speaker door adds it only to requests to speaker. It is bound to this host's address |
| Local model endpoint | The literal API key `local` (not a secret) | The configured local inference server receives prompts; no real API key is substituted |
| stdio MCP | Its configured command and arguments inside the guest | No host secret is automatically injected into stdio MCPs |

The destination of a secret's requests receives the real credential and the request content. Speaker's proxy logs agent, host, method, path, and status, never the value or bodies. Stdio MCPs and guest plugins run inside the VM with access to guest data, so do not put raw secrets in their command, arguments, or configuration.
{.ai}

Placeholder substitution keeps the real value off the guest and off bottle-school. It does not stop an approved destination from using the granted access. If someone took over bottle-school, they could make requests through speaker only while the grant is active, only to the secret's hosts, and every request is logged. They could not copy the secret.
{.ai}

<!-- author: ai -->

## Task archive

<sub>AI-written</sub>

bottle-school mounts `/input` for leased shares, `/work` for disposable scratch and the Pi session, `/output` for retained artifacts, and `/etc/bottle-school` for trusted read-only configuration. Pi runs as guest root.
{.ai}

At close, bottle-school stops Pi, exports the session and transcript, writes the trusted records, closes the VM, deletes its speaker subject, and removes the disposable work tree. Each archive holds `artifacts/` and `_control/`. The control directory holds task metadata, lease and policy events, a hashed artifact manifest, the Pi session and transcript, and `trace.jsonl`.
{.ai}

The trace retains project and harness records, matched tool calls and results, and captured model exchanges. It keeps unmatched native records and records failures and truncation. Capture limits are 8 MiB per model request, 32 MiB per model response, and 1 MiB per ordinary HTTP body. bottle-school stages bodies in `_control/blobs`, embeds them as text or base64 at close, then removes the staging blobs. It assembles streamed model replies into finished messages. Whether LangSmith and Phoenix can ingest the trace is unverified.
{.ai}

You delete archives manually. If archiving fails, bottle-school keeps the work tree for recovery and reports the failure. You cannot retroactively revoke a completed write or a note the agent already read. Treat captured prompts, replies, and artifacts as private data.
{.ai}

<!-- author: ai -->

## Verification and troubleshooting

<sub>AI-written</sub>

Run `mise run check` and `mise run test` from the repository root. The tests cover configuration, network and ref policy, templates and their first request, trace reconstruction, the speaker channel (grants, applied reports, shares, the 30-second drop), and the secret route against a real speaker proxy. They do not boot a guest.
{.ai}

Before deployment, verify register, launch, request, approval, expiry, revocation, attach, and archive in a real VM. With `PROXY_PORT` set in speaker (registration records it as `speaker.proxyPort` here), also check:
{.ai}

- `gh` and `git` with a granted secret through the egress proxy: the placeholder goes in, the real value appears only at the real host, and a `git clone` works through speaker
- a revoke ends that access
- the model-request capture for routed requests
- certificate inheritance through dtach
- herdr and terminal behavior

Not yet verified: macOS (entitlements and FUSE in the guest kernel), many concurrent VMs, and terminal resize.
{.ai}

- A missing `setsid` stops startup with a clear error. So does a microsandbox storage folder or parent that is group- or world-writable.
- `speaker.token is missing` means you must register the sandbox host first.
- A blocked guest request returns 403. The agent requests the required capability. An expired or revoked grant also blocks later use. If the policy events show a secret host blocked with "speaker.proxyPort is not set" or "speaker's proxy certificate is unavailable", speaker's proxy is not configured, not enabled (`PROXY_PORT`), or locked.
- The service archives open tasks on SIGINT or SIGTERM. Inspect the archive outcome before you discard recovery files.

<!-- author: ai -->

## Security boundary

<sub>AI-written</sub>

You trust the host, bottle-school, the sandbox runtime, the pinned image, and every peer that can reach the private control listener. You do not trust the guest, model decisions, downloaded code, files, or remote tool output. The control API has no application login, so restrict access to the control listener through host networking.
{.ai}

- The host enforces lease expiry, revocation, network access, and shared-folder permissions independently of Pi. Validate those boundaries in a real guest before deployment.
- Every approved destination can receive anything the guest can read. Placeholder substitution in speaker's proxy protects secret values. It does not prevent misuse of granted authority.
- The speaker exception permits the configured origin and subject-facing routes. Guest HTTP egress rejects IPv6 until its complete address policy is implemented and tested.
- Provide host storage quotas. Request counts do not bound GPU concurrency, token consumption, or the duration of a single generation.
- Review artifacts before you run them or promote them onto the host. Archives may contain private task content.
