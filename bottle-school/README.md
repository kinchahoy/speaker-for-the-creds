<!-- author: ai -->

# bottle-school

<sub>AI-written</sub>

bottle-school runs Pi inside disposable Gondolin micro-VMs. Speaker approves capabilities; bottle-school applies their leases.
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

To configure by hand instead, copy `config.example.json` to `config.json`. Choose existing absolute directories for `configRoot`, `stateRoot`, and `outputRoot`; make them writable by the service account. Copy `bottle-school/templates.json`, `bottle-school/catalog.json`, and `bottle-school/secrets.env.example` into `configRoot` as `templates.json`, `catalog.json`, and `secrets.env`. Protect secrets with mode 600. The owner must migrate older `templates/` and `catalog/` configurations to these files before starting this version.
{.ai}

- `bindHost` must be an assigned loopback, RFC1918, or Tailscale IPv4 address. The control API trusts peers that can reach it; keep that listener private.
- `speaker.url` points to the approval service. Speaker and approved guest destinations need IPv4 reachability.
- `localModel.upstream` names one loopback, RFC1918, or Tailscale IPv4 `host:port`. Use the literal address, such as the inference server's LAN or `100.x` Tailscale IP. The validator requires a literal IPv4 address (or `localhost`), so MagicDNS names are rejected.
- `localModel.models` lists served model IDs. Local inference is baseline access, independent of speaker leases.
- `shareRoots` defines the host folders a lease may expose. Begin with no sensitive shares and one task.
- `PI_V2_CONFIG` selects the service configuration; `BOTTLE_CONFIG` selects the CLI configuration. Both default to `bottle-school/config.json`.

<!-- author: ai -->

## Build and run

<sub>AI-written</sub>

```sh
mise run guest-build pi-v5-guest
mise run bottle-cli register
# Approve the enforcer in speaker /admin before starting the service.
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

A task is attended (the owner is at its terminal) or unattended (nobody is). Without `--prompt` a task defaults to attended; with one, to unattended. `--attended` or `--unattended` overrides that, and a template's `"attended"` fixes it; a flag that contradicts the template is refused. An attended task loads the ask-user-question extension (`ask_user_question` tool) regardless of its bundle, because it adds presence rather than access. An unattended task does not load it, and its system prompt says that nobody is watching: the agent records its assumptions in `/output/NOTES.md`, keeps working, and still asks for access through `request_capability`, which the owner answers in speaker. Mode does not change archival: a task with a prompt archives when Pi writes `/output/DONE`, and every task archives at its deadline.
{.ai}

<!-- author: ai -->

## Templates, catalogs, and leases

<sub>AI-written</sub>

`templates.json` contains an array of named templates. Each entry has `id`, `label`, `limits`, an optional `attended` that fixes the launch mode, and an optional speaker `bundle` with an optional `bundleDuration` (`15m` to `30d`, default `1d`) for the launch request. The file holds the developer, github-read, loop, offline, packages, and research presets. Duplicate IDs fail validation.
{.ai}

**Templates vs bundles.** A template is the runtime profile bottle-school owns: VM size, deadline, model-request cap, attended mode, and which bundle to ask for at launch. A bundle is defined in speaker and is everything the agent may use: sites, secrets, folders, MCP servers, and Pi extensions, approved together by one owner decision. To give agents a new ability, add it to a bundle (or let the agent request it); to change how big or how long a task is, edit the template.
{.ai}

Pi starts before the owner decides on the launch bundle. When an `mcp` or `extension` lease arrives, Pi restarts at its next idle boundary, resumes the same session, and gains the new tools; it does not replay the launch prompt. A one-shot unattended task may therefore run its first turn without the bundle's extensions, and if it settles before approval it waits idle until the owner attaches or the deadline passes. Approve the launch bundle promptly for unattended templates such as `loop`.
{.ai}

- VM limits cover CPU, memory, and the disposable root disk. `maxRuntimeHours` ends a task at its deadline; optional `maxModelRequests` caps model request count.
- `workGiB` is a launch-time free-space check. The owner must enforce work/output quotas through the host filesystem before unattended tasks share a disk with other services.
- `catalog.json` contains `mcps` and `extensions`. Remote MCP entries name an HTTPS endpoint, advertised tools, write authority, and optional credential. Extension entries name a reviewed image-local path (`/opt/pi-plugins/<name>` for the pinned npm packages), the tools to declare to the model (Pi's `--tools` is an allowlist), and an optional system-prompt note. An `extension <id>` lease loads one; unknown ids are skipped like other unsupported leases. The shipped entries are pi-web-access, pi-cc-loop, pi-cc-monitor, and Pi's subagent example (formerly the `subagent@1` plugin).
- The guest image loads only the always-on extensions pi-loop-police and pi-token-speed from `/opt/pi-extensions` in every task. Every other Pi package is pinned in `guest/mise-config.toml` and loads only through a lease or, for ask-user-question, attended mode.
- The shipped MCP entries are Parallel Search (`web_search`, `web_fetch`) and Context7 (`resolve-library-id`, `query-docs`). The owner must review server authority and verify tool names before use. These are whole-server grants; the broker does not filter individual tool arguments.
- Secrets use `BROKER_SECRET_<NAME>` in `configRoot/secrets.env` or the environment. The guest receives placeholders; a secret lease binds substitution to approved hosts.
- The guest calls speaker with its subject-token placeholder. Credential-backed homelab APIs pass through speaker's proxy.
- Each snapshot replaces live leases. The broker checks expiry at use and clears leases when the channel closes or snapshots stop. It skips unsupported refs.
- Sites, secrets, and folders apply live. MCP and extension changes take effect after Pi restarts at idle. A folder lease exposes a whole configured share, read-only unless its ref ends in `:rw`.

<!-- author: ai -->

## Research and loop presets

<sub>AI-written</sub>

The `research` bundle grants the `pi-web-access` extension, the site `mcp.exa.ai`, and the Wikipedia and arXiv sites. bottle-school writes the extension's `~/.pi/agent/web-search.json` (copied by `pi-launch` like `settings.json`): search uses only keyless Exa through its hosted MCP endpoint, pages are fetched directly over HTTP, and hosted extraction services, browser cookies, the curator browser UI, and the video and YouTube paths are off. A page fetch still needs a `site` lease for its host, so the agent requests hosts beyond Wikipedia and arXiv. The bundle no longer includes `mcp parallel-search`: it duplicated search for a small local model, and its hosted `web_fetch` would read any page without a site lease. The catalog entry remains for explicit requests.
{.ai}

No search API keys are configured. A keyed provider would use a bottle-school sandbox secret: put `BROKER_SECRET_<NAME>` in `secrets.env`, have `writeGuestConfig` set the provider's key field (for example `exaApiKey`) to that secret's guest placeholder and allow the provider, and approve `secret <NAME>@<provider host>` in speaker. The guest only ever sees the placeholder; Gondolin substitutes the real key for requests to the approved host.
{.ai}

The `loop` template is unattended, runs at most 24 hours and 300 model requests, and requests the `loop` bundle (pi-cc-loop and pi-cc-monitor) for one day. Pi then wakes itself with `/loop`, cron jobs, `schedule_wakeup`, or `Monitor`. bottle-school never archives a task for being idle, so a self-waking Pi keeps running between wakes; `/output/DONE` or the deadline still ends it. Durable jobs live in `/work/.pi/scheduled_tasks.json`: they survive Pi restarts within the task and disappear with the work directory at archival. Persisting jobs across tasks through a folder lease is future work.
{.ai}

<!-- author: ai -->

## Upgrading an existing install

<sub>AI-written</sub>

- Templates no longer have `plugins`, and the catalog's `plugins` became `extensions`. Rerun `mise run setup`, or copy `templates.json` and `catalog.json` into `configRoot` again; the old files fail validation at startup.
- The enforcer must declare the `extension` kind. Speaker fixes an enforcer's kinds at registration, so run `mise run bottle-cli register`, approve the new enforcer in speaker `/admin`, restart bottle-school, and revoke the old enforcer.
- Rebuild the guest image so `/opt/pi-plugins` exists, and update speaker's `bundles.json` from `speaker/bundles.example.json`.

<!-- author: ai -->

## Who receives bottle-school credentials

<sub>AI-written</sub>

| Credential path | What the guest sees | Who receives the real value |
| --- | --- | --- |
| Hosted model provider | A per-task placeholder in Pi's model config | The configured model API, after Gondolin substitutes it for requests to the approved provider host |
| Remote HTTP MCP with `credential` | A per-task placeholder in the MCP request header | The configured MCP server, after Gondolin substitutes it for requests to the approved MCP host |
| Speaker enforcer token | A per-task placeholder used for Speaker API calls | Speaker, and only on the configured subject-facing routes |
| Local model endpoint | The literal API key `local` (not a secret) | The configured local inference server receives prompts; no real API key is substituted |
| stdio MCP | Its configured command and arguments inside the guest | No host secret is automatically injected into stdio MCPs |

For hosted models and credentialed HTTP MCPs, the host keeps the real values from `secrets.env` or its process
environment. Gondolin replaces placeholders only after the live lease policy permits the destination. The
remote model API or MCP server receives the real credential and request content. An MCP server also receives
the tool arguments and results sent to it. Stdio MCPs and guest plugins run inside the VM with access to guest
data; do not put raw secrets in their command, arguments, or configuration. Placeholder substitution keeps
the real value off the guest, but it does not prevent an approved destination from using the granted access.
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

Run `mise run check` and `mise run test` from the repository root. The tests cover configuration, network/ref policy, templates, trace reconstruction, and the speaker channel. They do not boot a guest. Before deployment, verify register, launch, request, approval, expiry, revocation, attach, and archive in a real VM. Check placeholder substitution and certificate inheritance through dtach.
{.ai}

- A missing `qemu-img` or `setsid` stops startup with a clear error.
- With `PI_V2_VMM=krun`, a missing kernel or incompatible Krun runner prevents guest creation.
- `speaker.token is missing` means the owner must register the enforcer first.
- A blocked guest request returns 403; the agent requests the required capability. An expired or revoked grant also blocks subsequent use.
- The service archives open tasks on SIGINT or SIGTERM. The owner must inspect the archive outcome before discarding recovery files.

<!-- author: ai -->

## Security boundary

<sub>AI-written</sub>

The owner trusts the host, broker, sandbox runtime, pinned image, and peers that can reach the private control listener. The guest, model decisions, downloaded code, files, and remote tool output are untrusted. The owner must restrict control-listener access through host networking; the control API has no application login.
{.ai}

- The host enforces lease expiry, revocation, network access, and shared-folder permissions independently of Pi. The owner must validate those boundaries in a real guest before deployment.
- Every approved destination can receive anything the guest can read. Placeholder substitution protects secret values; it does not prevent misuse of granted authority.
- The speaker exception permits the configured origin and subject-facing routes. Guest HTTP egress rejects IPv6 until its complete address policy is implemented and tested.
- Speaker keeps temporary leases in memory; a restart ends them. The enforcer clears leases when its channel closes or snapshots stop.
- The owner must provide host storage quotas. Request counts do not bound GPU concurrency, token consumption, or individual generation duration.
- The owner must review artifacts before executing or promoting them onto the host. Archives may contain private task content.
