<!-- author: ai -->

# bottle-school

<sub>AI-written</sub>

bottle-school runs Pi inside disposable Gondolin micro-VMs. Speaker approves capabilities; bottle-school applies their leases.
{.ai}

<!-- author: ai -->

## Host setup

<sub>AI-written</sub>

The Linux host needs hardware virtualization, KVM access, Docker for image builds, `qemu-img`, and `setsid`. On a Debian-family host, install `qemu-utils` and add the service account to the `kvm` group; start a new login session afterward. Run the service as the owner account that holds its configuration and archives.
{.ai}

Run these commands from the repository root:
{.ai}

```sh
mise run install
cp bottle-school/config.example.json bottle-school/config.json
```

Choose existing absolute directories for `configRoot`, `stateRoot`, and `outputRoot`; make them writable by the service account. Copy `bottle-school/templates.json`, `bottle-school/catalog.json`, and `bottle-school/secrets.env.example` into `configRoot` as `templates.json`, `catalog.json`, and `secrets.env`. Protect secrets with mode 600. The owner must migrate older `templates/` and `catalog/` configurations to these files before starting this version.
{.ai}

- `bindHost` must be an assigned loopback, RFC1918, or Tailscale IPv4 address. The control API trusts peers that can reach it; keep that listener private.
- `speaker.url` points to the approval service. Speaker and approved guest destinations need IPv4 reachability.
- `localModel.upstream` names one loopback or RFC1918 IPv4 `host:port`, such as the MI60 server's inference endpoint. The validator does not accept a Tailscale model address.
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

On x86_64, `guest/build.sh` requires a Krun ELF kernel at `.runtime/krun/vmlinux` or the path named by `KRUN_VMLINUX`. Some hosts also need a compatible runner at `.runtime/krun-runner/bin/gondolin-krun-runner`; `start.sh` selects it when present. These host-specific artifacts are local prerequisites, not bundled binaries. The owner must provision and verify them on a fresh host.
{.ai}

From another terminal, launch and inspect a task:
{.ai}

```sh
mise run bottle-cli run --template offline --prompt "Write a greeting to /output/greeting.txt"
mise run bottle-cli ls
mise run bottle-cli attach <id>
mise run bottle-cli stop <id>
```

Ctrl-\ detaches from dtach; Ctrl-] leaves the VM terminal. Inside herdr, the CLI opens a pane and reports working, idle, or blocked. A one-shot task writes `/output/DONE` only when complete. The owner must verify herdr and terminal behavior in a real guest.
{.ai}

<!-- author: ai -->

## Templates, catalogs, and leases

<sub>AI-written</sub>

`templates.json` contains an array of named templates. Each entry has `id`, `label`, `limits`, `plugins`, and an optional speaker `bundle`. The file retains the developer, github-read, offline, packages, and research presets. Duplicate IDs fail validation.
{.ai}

- VM limits cover CPU, memory, and the disposable root disk. `maxRuntimeHours` ends a task at its deadline; optional `maxModelRequests` caps model request count.
- `workGiB` is a launch-time free-space check. The owner must enforce work/output quotas through the host filesystem before unattended tasks share a disk with other services.
- `catalog.json` contains `mcps` and `plugins`. Remote MCP entries name an HTTPS endpoint, advertised tools, write authority, and optional credential. Plugins name reviewed image-local paths.
- The shipped MCP entries are Parallel Search (`web_search`, `web_fetch`) and Context7 (`resolve-library-id`, `query-docs`). The owner must review server authority and verify tool names before use. These are whole-server grants; the broker does not filter individual tool arguments.
- Secrets use `BROKER_SECRET_<NAME>` in `configRoot/secrets.env` or the environment. The guest receives placeholders; a secret lease binds substitution to approved hosts.
- The guest calls speaker with its subject-token placeholder. Credential-backed homelab APIs pass through speaker's proxy.
- Each snapshot replaces live leases. The broker checks expiry at use and clears leases when the channel closes or snapshots stop. It skips unsupported refs.
- Sites, secrets, and folders apply live. MCP configuration changes take effect after Pi restarts at idle. A folder lease exposes a whole configured share, read-only unless its ref ends in `:rw`.

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

The broker mounts `/input` for leased shares, `/work` for disposable scratch and the Pi session, `/output` for retained artifacts, and `/etc/pi-v2` for trusted read-only configuration. Pi runs as guest root; the image loads only its reviewed extensions and the host's configuration.
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
- A missing kernel or incompatible Krun runner prevents guest creation.
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
