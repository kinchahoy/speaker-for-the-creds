<!-- author: ai -->

# bottle-school

<sub>AI-written</sub>

bottle-school runs Pi inside disposable micro-VMs (Gondolin by default, or microsandbox: see "The microsandbox backend"). Speaker approves capabilities; bottle-school applies their leases.
{.ai}

<!-- author: ai -->

## Host setup

<sub>AI-written</sub>

The Linux host needs hardware virtualization, KVM access, Docker for image builds, `qemu-system-x86`, `qemu-img`, and `setsid`. On a Debian-family host, install `qemu-system-x86` and `qemu-utils`, and add the service account to the `kvm` group; start a new login session afterward. Run the service as the owner account that holds its configuration and archives.
{.ai}

Run these commands from the repository root:
{.ai}

```sh
mise run install
cp bottle-school/.env.example bottle-school/.env   # set LLM_UPSTREAM, LLM_MODEL, SPEAKER_URL
mise run setup
mise run doctor
```

Host-specific values (model endpoint, speaker URL, VM backend) live only in the gitignored `bottle-school/.env` and `bottle-school/config.json`. mise loads `.env` for every task. `mise run setup` writes `config.json` and its directories under `BOTTLE_HOME` (default `~/.local/share/bottle-school`).
{.ai}

To configure by hand instead, copy `config.example.json` to `config.json`. Choose existing absolute directories for `configRoot`, `stateRoot`, and `outputRoot`; make them writable by the service account. Copy `bottle-school/templates.json` and `bottle-school/catalog.json` into `configRoot`. bottle-school holds no secrets: see "Secrets and speaker's proxy". The owner must migrate older `templates/` and `catalog/` configurations to these files before starting this version.
{.ai}

- `backend` selects the sandbox runtime: `gondolin` (default) or `microsandbox`. The rest of this file describes Gondolin except the section on the microsandbox backend.
- `bindHost` must be an assigned loopback, RFC1918, or Tailscale IPv4 address. The control API trusts peers that can reach it; keep that listener private.
- `speaker.url` points to the approval service. Speaker and approved guest destinations need IPv4 reachability. The VM reaches speaker at this address, so on one machine use the machine's LAN address, not `127.0.0.1` (a VM's loopback is itself).
- `speaker.proxyPort` is speaker's `PROXY_PORT`, on the same host as `speaker.url`. Set it to use `secret:` items; without it a task that is granted a secret cannot reach the secret's hosts (the request is refused with that message).
- `localModel.upstream` names one loopback, RFC1918, or Tailscale IPv4 `host:port`. Use the literal address, such as the inference server's LAN or `100.x` Tailscale IP. The validator requires a literal IPv4 address (or `localhost`), so MagicDNS names are rejected.
- `localModel.models` lists served model IDs. Local inference is baseline access, independent of speaker leases.
- `shareRoots` defines the host folders a grant may expose. Begin with no sensitive shares and one task.
- `PI_V2_CONFIG` selects the service configuration; `BOTTLE_CONFIG` selects the CLI configuration. Both default to `bottle-school/config.json`.

<!-- author: ai -->

## Build and run

<sub>AI-written</sub>

```sh
mise run guest-build pi-v5-guest
mise run bottle-cli register
# Approve the sandbox host in speaker /admin before starting the service.
mise run bottle
```

The guest build imports an Ubuntu rootfs through Gondolin. Its tool selections live in `guest/apt-packages.txt`, `guest/mise-config.toml`, and `guest/python/requirements.in`. The build installs current tool releases except explicitly pinned packages; it refreshes Docker layers daily. Set `PI_GUEST_BROWSER=1` when running the build to add Python Playwright and headless Chromium. Builds need internet access and several GiB of disk space.
{.ai}

<!-- author: ai -->

## VM backends: QEMU and Krun

<sub>AI-written</sub>

`PI_V2_VMM` selects Gondolin's VMM for the service (and `mise run doctor`). It defaults to `qemu`. One guest image boots under both backends, so switching needs no rebuild: set `PI_V2_VMM=krun` in `bottle-school/.env` and restart `mise run bottle`.
{.ai}

**QEMU (default).** Install `qemu-system-x86` and `qemu-utils` (arm64: `qemu-system-arm`; macOS: `brew install qemu`). Nothing host-specific is needed beyond KVM access. `mise run doctor` checks all of it.
{.ai}

**Krun (libkrun, no QEMU process).** Needs a Krun runner that matches the host CPU:
{.ai}

- Linux x86_64: build it once per machine with `mise run krun-runner` (`krun-runner.sh`). Gondolin's published runner is compiled on an AVX-512 machine (Zig targets the build host's CPU) and crashes with an illegal instruction on CPUs without AVX-512, such as Intel Core Ultra. The script builds `host/krun-runner` from the pinned Gondolin tag `v0.13.0` (commit `fcbcef1`) with Zig 0.17 and `-Dcpu=x86_64_v3`, copies the published `libkrun.so.1.17.4` (no AVX-512; the version Gondolin pins) next to it, and fails unless both contain zero `zmm` instructions. It installs into the gitignored `.runtime/krun-runner/`; `start.sh` and `doctor.sh` use it automatically through `GONDOLIN_KRUN_RUNNER`. Rebuild it when you upgrade Gondolin (bump `REF` and `SHA` in the script).
- macOS and Linux arm64: Gondolin's published runner is used as is (no AVX-512 issue; macOS signs it with the Hypervisor entitlement). Not tested here.
{.ai}

How one image serves both backends (`guest/boot-assets.mjs`, x86_64): QEMU and libkrun both load the uncompressed ELF `vmlinux` extracted from Alpine's kernel, and both use the trimmed initramfs, which loads `virtio_blk` and `ext4` and then switches to the rootfs and our `rootfs-init.sh`. The manifest's `krunKernel` and `krunInitrd` slots point at those same two files, so the image is no larger. Gondolin's stock Krun slots (libkrunfw's raw kernel plus an empty initrd) are dropped on x86_64: libkrun rejects that raw kernel ("Kernel doesn't fit in RAM"), and Alpine's kernel has no built-in block driver, so an empty initrd cannot mount the root disk. On aarch64 and macOS the stock libkrunfw kernel and empty initrd are kept, since that kernel has the drivers built in. This is untested here.
{.ai}

Krun-specific differences: libkrun exposes virtio-mmio devices and a virtio-console multiport (`vport*`), which Gondolin's init and `rootfs-init.sh` already handle; sandboxfs runs over the same `virtio-fs` port as under QEMU, and DHCP, DNS and the HTTPS MITM behave identically. The kernel command line is `console=hvc0 root=/dev/vda rootfstype=ext4 rw init=/init quiet initcall_blacklist=i8042_init` (set in `src/gondolin.ts`); the blacklisted i8042 driver spends ~0.25s probing libkrun's emulated keyboard controller. The kernel prints a harmless `free_init_pages` warning for the initrd under libkrun. To debug a Krun boot, set `console: "stdio"` in the VM options and point `GONDOLIN_KRUN_RUNNER` at a wrapper script that redirects the runner's output to a file.
{.ai}

Measured on a Core Ultra 7 265K (no AVX-512), 2 vCPU, 2 GiB, the same image, `bootGuest` create to first exec, n=12 each, interleaved, host under a load of ~3:
{.ai}

| | QEMU | Krun |
| --- | --- | --- |
| median / min / max | 0.95 s / 0.73 s / 1.27 s | 1.05 s / 0.78 s / 1.20 s |
| 200 MB write / read on `/work` (sandboxfs) | 100-157 MB/s / 74-78 MB/s | 75-78 MB/s / 92-107 MB/s |
| 200 MB write / read on the rootfs disk | 0.9-1.4 GB/s / page cache | 1.1-1.4 GB/s / page cache |

Networking, `getent hosts model.internal`, HTTPS through the MITM (allowed host 200, blocked host 403) from curl, Python, requests and Node, and the sandboxfs mounts all gave identical results under both. `/work` throughput is bounded by the host-side sandboxfs RPC, not the VMM. QEMU stays the default: it is slightly faster to boot here and is the better-exercised path. Krun is a supported alternative; `mise run doctor` with `PI_V2_VMM=krun` checks the runner (present, no AVX-512) and the image's Krun assets.
{.ai}

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

`ls` shows each task's state, attended or unattended mode, pending speaker approvals (with the request id), age, model, name, and Pi's latest message. `run` prints a copy-pasteable `attach` line. Errors print one line and exit 1 (runtime) or 2 (usage).

Ctrl-\ detaches from dtach; Ctrl-] leaves the VM terminal. Inside herdr, the CLI opens a pane and reports working, idle, or blocked. A one-shot task writes `/output/DONE` only when complete. The owner must verify herdr and terminal behavior in a real guest.
{.ai}

A task is attended (the owner is at its terminal) or unattended (nobody is). Without `--prompt` a task defaults to attended; with one, to unattended. `--attended` or `--unattended` overrides that, and a template's `"attended"` fixes it; a flag that contradicts the template is refused. An attended task loads the ask-user-question extension (`ask_user_question` tool) regardless of its template, because it adds presence rather than access. An unattended task does not load it, and its system prompt says that nobody is watching: the agent records its assumptions in `/output/NOTES.md`, keeps working, and still asks for access through `request_capability`, which the owner answers in speaker. Mode does not change archival: a task with a prompt archives when Pi writes `/output/DONE`, and every task archives at its deadline.
{.ai}

<!-- author: ai -->

## The microsandbox backend

<sub>AI-written</sub>

`"backend": "microsandbox"` in `config.json` runs each task in a [microsandbox](https://github.com/superradcompany/microsandbox) VM (libkrun, from the `microsandbox` npm package) instead of a Gondolin VM; `"gondolin"` stays the default. The guest has **no network device**. Its only doors are four host unix sockets on guest vsock ports, which `socat` in the guest exposes as localhost ports: an HTTP proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`), the model endpoint (`http://model.internal`), speaker (`SPEAKER_URL`), and the control channel Pi's status reports use. `/work`, `/output` and `/etc/pi-v2` are bind mounts of the same host directories as on Gondolin.
{.ai}

- **Egress.** One `proxy-chain` server per task decides every request from the live lease view: a host on the task's allow list goes direct (to public IPv4 addresses only), a host bound to a granted `secret:` goes through speaker's proxy with the task agent's credentials, and anything else gets 403. bottle-school does not terminate TLS. A secret host's TLS ends at speaker's proxy, so the guest trusts speaker's proxy certificate (fetched from `/_speaker/proxy/ca.pem` at boot, installed in the guest's trust store, and set as `NODE_EXTRA_CA_CERTS`); without `speaker.proxyPort` secrets are unavailable, as on Gondolin.
- **Model endpoint.** A small forwarder to `localModel.upstream` that counts each request against the task's `maxModelRequests` (a request over the cap gets a 429 that says so), streams the reply, and records bodies for `trace.jsonl` with the same code as the Gondolin backend. A hosted provider's `baseUrl` in the guest's `models.json` points at `http://model.internal/hosted/<id>/...`; the forwarder sends those through speaker's proxy once the provider's secret is granted.
- **Speaker.** The speaker door allows the same paths as Gondolin and adds the task's token itself, so the guest never holds it (`SPEAKER_TOKEN` is only a placeholder).
- **Terminal.** `bottle-cli attach` runs `msb exec -t <vm> -- dtach -a /run/pi.dtach` with the service's microsandbox home.
- **Folders are not available yet.** A `folder:` grant is refused with `folders are not available on the microsandbox backend yet` (recorded in the task's events) and is not reported in force. Folders over `sshfs` through speaker are the planned way; the image already contains `sshfs`.
- **Storage.** microsandbox keeps images and VM records in `<stateRoot>/microsandbox`, created with mode 700. It refuses a storage folder with a group- or world-writable ancestor (other than a sticky directory such as `/tmp`), so use a `stateRoot` whose parents are not group-writable.
{.ai}

Build the guest image into that storage before the first task (it needs Docker):
{.ai}

```sh
guest/build-microsandbox.sh <stateRoot> pi-v5-ms    # then set "guestImage": "pi-v5-ms" and "backend": "microsandbox"
```

The backend takes any OCI image, however it was built, as long as it holds Node, Pi, git, curl, `socat`, `sshfs`, `openssh-client` and `ca-certificates` and has been imported into microsandbox's cache under the `guestImage` name (it never pulls). The loading step is only `docker save <image> | MSB_HOME=<stateRoot>/microsandbox msb load --tag <guestImage>` (`msb load -i <archive.tar>` takes a docker-save or OCI-layout archive from any builder), so another image builder can replace the Dockerfile without touching the backend. The shipped `guest/microsandbox.Dockerfile` is a standalone Debian slim image: apt packages (compilers, ffmpeg, imagemagick, pandoc, OCR, `socat`, `sshfs`, `dtach`, and the usual command-line tools), mise for Node, pnpm, uv, `gh`, ripgrep, Pi and its extensions (`guest/microsandbox-mise.toml`, latest releases except the pinned extensions), Python only through uv (its managed CPython is `python` and `python3`; no Debian Python packages), and Playwright with Chromium. mise stays in the image so agents can install Go or Rust on demand. Linux needs `/dev/kvm` access and nothing else; the `microsandbox` package carries its own runtime. `mise run doctor` and `guest/build.sh` are Gondolin's and do not apply. Not yet verified: macOS (entitlements and FUSE in the guest kernel), many concurrent VMs, terminal resize.
{.ai}

<!-- author: ai -->

## Templates, catalogs, and leases

<sub>AI-written</sub>

`templates.json` contains an array of named templates. Each entry has `id`, `label`, `limits`, an optional `attended` that fixes the launch mode, a `want` list and a `duration`. The `want` list holds items and groups (`group:developer`, `site:pypi.org`, `notes.read`); `label` and `duration` are the task's label and the length it asks for (`30m`, `1h`, `2h`, `1d` or `30d`; default `2h`). Together they become the task's first request to speaker: one card, labelled with the template's `label` (or the `--name` given at launch) and the reason `launch template <id>: <label>`. An empty or missing `want` asks for nothing (the `offline` preset). The file holds the developer, github-read, loop, offline, packages, and research presets. Duplicate IDs fail validation, and the old single `bundle` and `bundleDuration` keys fail it too: replace them with `want: ["group:<name>"]` and `duration`.
{.ai}

**Templates vs groups.** A template is the runtime profile bottle-school owns (VM size, deadline, model-request cap, attended mode) plus what the task starts with. A group is defined in speaker and names items the owner approves together. To change what tasks start with, edit a template's `want` or the group in speaker; to change how big or how long a task is, edit the template's limits.
{.ai}

The task starts at once; it does not wait for the first request. When an `mcp` or `extension` grant arrives, Pi restarts at its next idle boundary, resumes the same session, and gains the new tools; it does not replay the launch prompt. A one-shot unattended task may therefore run its first turn without the extensions, and if it settles before approval it waits idle until the owner attaches or the deadline passes. Approve the launch request promptly for unattended templates such as `loop`.
{.ai}

- VM limits cover CPU, memory, and the disposable root disk. `maxRuntimeHours` ends a task at its deadline; optional `maxModelRequests` caps model request count.
- `workGiB` is a launch-time free-space check. The owner must enforce work/output quotas through the host filesystem before unattended tasks share a disk with other services.
- `catalog.json` contains `mcps` and `extensions`. An `mcp:<id>` entry is an MCP server that runs inside the VM from an image-local command (`transport: "stdio"`, an absolute `command`, `args`, the advertised `tools` and whether it can write). **Remote and hosted MCP servers are not catalog entries:** they are speaker services. The owner adds one in speaker's Setup (tick "MCP server"; `speaker/services.example.json` has Context7 and Parallel Search), and a task asks for `<service>.read` (or `.full`) and calls `$SPEAKER_URL/<service>` with its speaker token. The shipped catalog therefore has no `mcps` entries; a remote entry fails validation with that explanation. Extension entries name a reviewed image-local path (`/opt/pi-plugins/<name>` for the pinned npm packages), the tools to declare to the model (Pi's `--tools` is an allowlist), and an optional system-prompt note. An `ext:<id>` grant loads one; unknown ids are skipped like other unsupported grants. The shipped entries are pi-web-access, pi-cc-loop, pi-cc-monitor, and Pi's subagent example (formerly the `subagent@1` plugin).
- The guest image loads only the always-on extensions pi-loop-police and pi-token-speed from `/opt/pi-extensions` in every task. Every other Pi package is pinned in `guest/mise-config.toml` and loads only through a grant or, for ask-user-question, attended mode.
- Pi's instructions name the catalog's `mcp:` and `ext:` entries, the secrets the owner set up in speaker (names, hosts and the variable each one uses; speaker sends this list with its grant snapshots), the `<service>.read` / `.full` form for homelab APIs and remote MCP servers, and how to use a secret.
- The guest calls speaker with its agent-token placeholder; Gondolin substitutes the token only for speaker's host. Credential-backed homelab APIs pass through speaker's service proxy.
- Each snapshot from speaker replaces the live grants. A grant counts as in force for the agent once bottle-school reports it: sites, secrets and folders apply the moment they are installed; an MCP server or extension only after Pi has restarted with it. If bottle-school hears nothing from speaker for 30 seconds (connection lost, or snapshots stopped) it drops all of its tasks' grants until the connection is back. A task's grants therefore end within 30 seconds of losing speaker; a brief blip changes nothing. It skips unsupported refs.
- Sites, secrets, and folders apply live. MCP and extension changes take effect after Pi restarts at idle. A folder grant exposes a whole configured share at `/input/<share>`, read-only unless the item ends in `:rw`.
- On every connection bottle-school tells speaker which shares it holds (`shareRoots`, plus `archive`) and whether the VM can mount each one (its directory is readable). Speaker records this so it can choose between a VM mount and delivery over SSH for `folder:` items.

<!-- author: ai -->

## Secrets and speaker's proxy

<sub>AI-written</sub>

bottle-school never holds a secret. `secrets.env` and the `BROKER_SECRET_*` variables are retired (startup stops with a message while either is present), and Gondolin's own placeholder substitution is used for one thing only: the task's speaker token. The owner adds each secret once in speaker's Setup with its allowed hosts and the variable the agent sees (for example `GH_TOKEN`); a task asks for `secret:<NAME>`, and the card shows the hosts.
{.ai}

**The route.** When speaker's grant snapshot names a secret grant it carries the secret's hosts, not its value. bottle-school opens those hosts for the VM and sends every request the VM makes to them through speaker's HTTPS proxy (`PROXY_PORT`; see speaker's README): the guest's TLS is still terminated by Gondolin's certificate authority, which the VM already trusts, and Gondolin's upstream connection for that request is an HTTP CONNECT tunnel to the proxy, authenticated as the task's agent (bottle-school holds that token; the guest has only a placeholder) and trusting speaker's proxy CA for the tunnel only. Speaker checks the grant on every request, swaps the agent's placeholder for the value in the `Authorization` header (also inside Basic credentials, as `git` sends them), and forwards to the real host. Revoke or expiry makes speaker answer 403 at once; bottle-school also drops the route when its grant goes. The guest needs no proxy settings and no extra certificate: Pi gets the placeholder from `GET /_speaker/me` and sets the variable on the command that needs it.
{.ai}

**Why this route.** Gondolin supports it with a small patch: a hook (`httpHooks.upstreamDispatcher`, about ten lines in `patches/`) that lets bottle-school choose the upstream dispatcher per request. The alternatives were worse: pointing `HTTPS_PROXY` in the guest at speaker needs a raw TCP route from the VM to speaker's proxy port (Gondolin's `tcp.hosts`), puts the real agent token inside the VM because the CONNECT line is not HTTP that Gondolin can rewrite, and needs speaker's CA in the guest; and Gondolin's `fetch` option replaces its IP-checked upstream dispatcher for all traffic, not only for secret hosts. The cost, as in speaker's design, is that all traffic to a secret's hosts (including large `git clone`s) passes through speaker. If speaker's proxy is unreachable the request is refused, never sent directly.
{.ai}

**Hosted model providers.** A hosted provider's key is a speaker secret like any other: set `hostedProviders[].credential` to the speaker secret's name. A task using a hosted model adds `secret:<credential>` to its first request; once granted, bottle-school asks speaker for the task's placeholder, writes it into `models.json` and restarts Pi at idle. The model host must be one of the secret's allowed hosts in speaker's Setup. Until then Pi's key reads `speaker-secret-<NAME>-not-granted-yet`, so a hosted model's first turn can fail before the owner approves.
{.ai}

<!-- author: ai -->

## Research and loop presets

<sub>AI-written</sub>

The `research` group (the `research` template asks for it) grants the `pi-web-access` extension, the site `mcp.exa.ai`, and the Wikipedia and arXiv sites. bottle-school writes the extension's `~/.pi/agent/web-search.json` (copied by `pi-launch` like `settings.json`): search uses only keyless Exa through its hosted MCP endpoint, pages are fetched directly over HTTP, and hosted extraction services, browser cookies, the curator browser UI, and the video and YouTube paths are off. A page fetch still needs a `site` grant for its host, so the agent requests hosts beyond Wikipedia and arXiv. The group does not include Parallel Search: it duplicated search for a small local model, and its hosted `web_fetch` would read any page without a site grant. It is a speaker service (`parallel-search.read`) the agent can request explicitly.
{.ai}

No search API keys are configured. A keyed provider would use a speaker secret: add it in speaker's Setup with the provider's host, have `writeGuestConfig` set the provider's key field (for example `exaApiKey`) to the task's placeholder for that secret (see `GET /_speaker/me`), and approve `secret:<NAME>`. The guest only ever sees the placeholder; speaker's proxy substitutes the real key for requests to the provider's host.
{.ai}

The `loop` template is unattended, runs at most 24 hours and 300 model requests, and asks for `group:loop` (pi-cc-loop and pi-cc-monitor) for one day. Pi then wakes itself with `/loop`, cron jobs, `schedule_wakeup`, or `Monitor`. bottle-school never archives a task for being idle, so a self-waking Pi keeps running between wakes; `/output/DONE` or the deadline still ends it. Durable jobs live in `/work/.pi/scheduled_tasks.json`: they survive Pi restarts within the task and disappear with the work directory at archival. Persisting jobs across tasks through a folder grant is future work.
{.ai}

<!-- author: ai -->

## Upgrading an existing install

<sub>AI-written</sub>

- **Secrets move to speaker.** Add each `BROKER_SECRET_<NAME>` from `secrets.env` in speaker's Setup (name, value, allowed hosts, the variable the agent sees), delete `secrets.env` and the `BROKER_SECRET_*` variables (startup refuses to run while they exist), set `speaker.proxyPort` in `config.json` to speaker's `PROXY_PORT`, and publish that port. A grant for `secret:<NAME>@host` in old groups becomes `secret:<NAME>`: the hosts come from the secret's Setup entry. Hosted model providers keep their `credential` name, which must now be a speaker secret.
- **Templates.** `bundle` becomes `want: ["group:<name>"]` and `bundleDuration` becomes `duration`; copy the new `templates.json` into `configRoot` or edit yours (the old keys fail validation).
- **Catalog.** Remove remote MCP entries from `catalog.json` (`mcps` keeps only servers that run inside the VM) and add them in speaker's Setup as services (tick "MCP server"); replace `mcp:<id>` in groups and templates with `<service>.read`. See `speaker/services.example.json` and `speaker/groups.example.json`.
- **Gondolin patch.** `pnpm install` applies the updated `patches/@earendil-works__gondolin@0.14.0.patch` (it adds `httpHooks.upstreamDispatcher`). The sandbox host's registered item kinds are unchanged.

<!-- author: ai -->

## Who receives credentials

<sub>AI-written</sub>

| Credential path | What the guest sees | Who holds the real value |
| --- | --- | --- |
| A speaker secret (`secret:<NAME>`, including a hosted model provider's key) | A per-agent placeholder from speaker's `/me` | Speaker only. Its proxy inserts it for the secret's hosts; bottle-school never has it |
| Remote MCP server | Nothing: it is a speaker service (`$SPEAKER_URL/<service>`) | Speaker, which adds any upstream key |
| Speaker agent token | A per-task placeholder (`SPEAKER_TOKEN`) | bottle-school, which created the agent; Gondolin substitutes it only for speaker's host. It is bound to this host's address |
| Local model endpoint | The literal API key `local` (not a secret) | The configured local inference server receives prompts; no real API key is substituted |
| stdio MCP | Its configured command and arguments inside the guest | No host secret is automatically injected into stdio MCPs |

The destination of a secret's requests receives the real credential and the request content; speaker's proxy logs agent, host, method, path and status, never the value or bodies. Stdio MCPs and guest plugins run inside the VM with access to guest data; do not put raw secrets in their command, arguments, or configuration. Placeholder substitution keeps the real value off the guest and off bottle-school, but it does not prevent an approved destination from using the granted access. If bottle-school were taken over it could make requests through speaker only while the grant is active, only to the secret's hosts, and every request is logged; it cannot copy the secret.
{.ai}

<!-- author: ai -->

## Task archive

<sub>AI-written</sub>

The broker mounts `/input` for leased shares, `/work` for disposable scratch and the Pi session, `/output` for retained artifacts, and `/etc/pi-v2` for trusted read-only configuration. Pi runs as guest root; the image loads only its always-on extensions, the extensions the task's mode and leases select, and the host's configuration.
{.ai}

At close, the broker stops Pi, exports the session and transcript, writes the trusted records, closes the VM, deletes its speaker subject, and removes the disposable work tree. Each archive contains `artifacts/` and `_control/`. The control directory holds task metadata, lease/policy events, a hashed artifact manifest, the Pi session/transcript, and `trace.jsonl`.
{.ai}

The trace retains project and harness records, matched tool calls/results, and captured model exchanges. It preserves unmatched native records and records failures and truncation. Capture limits are 8 MiB per model request, 32 MiB per model response, and 1 MiB per ordinary HTTP body. The broker stages bodies in `_control/blobs`, embeds them as text or base64 at close, then removes the staging blobs. It assembles streamed model replies into finished messages. LangSmith and Phoenix ingestion compatibility remain unverified.
{.ai}

The owner deletes archives manually. An archival failure preserves the work tree for recovery and reports failure. A completed write or a note the agent already read cannot be revoked retroactively. Treat captured prompts, replies, and artifacts as private data.
{.ai}

<!-- author: ai -->

## Verification and troubleshooting

<sub>AI-written</sub>

Run `mise run check` and `mise run test` from the repository root. The tests cover configuration, network/ref policy, templates and their first request, trace reconstruction, the speaker channel (grants, applied reports, shares, the 30-second drop) and the secret route against a real speaker proxy. They do not boot a guest. Before deployment, verify register, launch, request, approval, expiry, revocation, attach, and archive in a real VM. In particular check, with `PROXY_PORT` set in speaker and `speaker.proxyPort` here: `gh` and `git` with a granted secret through Gondolin's patched upstream hook (placeholder in, real value only at the real host, a `git clone` through speaker), a revoke ending it, the model-request capture for routed requests, and certificate inheritance through dtach.
{.ai}

- A missing `qemu-img` or `setsid` stops startup with a clear error.
- With `PI_V2_VMM=krun`, a missing kernel or incompatible Krun runner prevents guest creation.
- `speaker.token is missing` means the owner must register the sandbox host first.
- A blocked guest request returns 403; the agent requests the required capability. An expired or revoked grant also blocks subsequent use. A secret host blocked with "speaker.proxyPort is not set" or "speaker's proxy certificate is unavailable" in the policy events means speaker's proxy is not configured, not enabled (`PROXY_PORT`) or locked.
- The service archives open tasks on SIGINT or SIGTERM. The owner must inspect the archive outcome before discarding recovery files.

<!-- author: ai -->

## Security boundary

<sub>AI-written</sub>

The owner trusts the host, broker, sandbox runtime, pinned image, and peers that can reach the private control listener. The guest, model decisions, downloaded code, files, and remote tool output are untrusted. The owner must restrict control-listener access through host networking; the control API has no application login.
{.ai}

- The host enforces lease expiry, revocation, network access, and shared-folder permissions independently of Pi. The owner must validate those boundaries in a real guest before deployment.
- Every approved destination can receive anything the guest can read. Placeholder substitution in speaker's proxy protects secret values; it does not prevent misuse of granted authority.
- The speaker exception permits the configured origin and subject-facing routes. Guest HTTP egress rejects IPv6 until its complete address policy is implemented and tested.
- Speaker keeps temporary grants in memory; a restart ends them. Bottle-school drops its tasks' grants after 30 seconds without word from speaker.
- The owner must provide host storage quotas. Request counts do not bound GPU concurrency, token consumption, or individual generation duration.
- The owner must review artifacts before executing or promoting them onto the host. Archives may contain private task content.
