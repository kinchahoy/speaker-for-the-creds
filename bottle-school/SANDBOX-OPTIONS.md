<!-- author: ai -->

# Sandbox options for bottle-school: alternatives to Gondolin

<sub>AI-written</sub>

Written 2026-11-11 against bottle-school at commit 946f6f3. Research only: nothing was built or run, and every claim about an outside project comes from the pages linked at the end or, for microsandbox, smolvm, BoxLite and Matchlock, from their source trees read on 2026-11-11 (section 9). Where I could not confirm something I say so, and section 8 lists all of it in one place.

## 1. Summary and recommendation

**What the owner asked for.** No patches against a sandbox runtime. Something simpler and better. "Minimal fast microvms abound."

**What the research found.**

- The VM runtimes themselves (Firecracker, Cloud Hypervisor, libkrun) are small, well maintained and need no patching. What Gondolin adds on top is a programmable network stack, a virtual filesystem and an exec protocol. Those are the parts bottle-school patches (`patches/@earendil-works__gondolin@0.14.0.patch`) or works around (`guest/boot-assets.mjs`, `krun-runner.sh`, `ShareRouter` in `src/gondolin.ts`).
- Almost everything bottle-school needs from that layer can live outside the VM, in code bottle-school owns and that speaks only standard protocols: an HTTP proxy on the host, SSH, and a vsock socket.
- No project replaces the whole of bottle-school's sandbox layer, because none lets chosen hosts be sent to speaker's proxy without the project holding the secret (details in 3.3). But one of them, **microsandbox**, does fit Design B as the *launcher*: it can start a libkrun VM with no network device, bridge guest vsock ports to host unix sockets, run commands and interactive PTY sessions, and enforce CPU, memory and disk limits, on Linux and macOS, from a TypeScript library (3.3; read from its source, not run). bottle-school would keep its own gateway and use microsandbox only for the VM, which is the first of the two things it would otherwise have to write itself. smolvm also fits technically but is driven through its CLI for the features needed. BoxLite and Matchlock lack a way for a no-network guest to reach a host gateway.
- Boot time will not improve much. Today's 0.95 s median (README, QEMU) is mostly Ubuntu user space starting, not the hypervisor. Firecracker's headline 125 ms is for a minimal guest.

**Owner's answers (decided).** macOS is a requirement; a separate backend is acceptable if it is a few dozen lines. Folders over `sshfs` are acceptable. The primary path below therefore starts on **libkrun**, which runs the same guest on Linux (KVM) and macOS (Hypervisor.framework) and is already built by bottle-school today; Firecracker becomes an optional Linux-only backend behind the same VMM-neutral contract.

**Primary path.** A plain microVM with no network card. The guest's only doors are vsock sockets to a small host-side gateway owned by bottle-school: an allow-list egress proxy that chains secret hosts to speaker's proxy, a model gateway that records and counts model requests, and a status channel. Folders arrive over `sshfs` through speaker (speaker's DESIGN.md already describes this). **The VM is launched by microsandbox's TypeScript library** (libkrun underneath, Linux KVM and macOS Hypervisor.framework), with `disableNetwork()` and one `vsock(<per-VM host unix socket>, <port>)` route per gateway door. Exec and interactive attach use microsandbox's own agent channel (`exec`, `attachShell`, or `msb ssh`), so no `sshd` or per-VM SSH key is needed in the guest (the guest runs only the `sshfs` client, against speaker). bottle-school does not use microsandbox's network stack, TLS interception or secret injection, so the lack of a per-host upstream proxy there (3.3) does not matter. What this removes from "code to own": the launcher, kernel choice, guest init, exec protocol, PTY handling, and the image build step (OCI images are used directly). What it adds: a dependency on microsandbox's version-0.x API, which should be pinned. If a spike (section 6, items 1 and 8) shows the no-network plus vsock combination does not work on both platforms, fall back to a bottle-school launcher on libkrun directly (the previous primary path), keeping the same contract (kernel, disks, vsock) so Firecracker can still be added on Linux.

**Fallback.** Stay on Gondolin but get to zero local patches: send the `upstreamDispatcher` and body-capture hooks upstream, drop the Krun runner and the boot-asset reshaping, and use QEMU only. Least work, keeps macOS and live shares, but keeps depending on an "early project" whose internals the patch touches.

## 2. Step 1: what bottle-school uses from Gondolin today

Sources: README, `src/gondolin.ts`, `tasks.ts`, `leases.ts`, `pi.ts`, `server.ts`, `cli.ts`, `config.ts`, `guest/`, `patches/`, `doctor.sh`, `krun-runner.sh`, and speaker's DESIGN.md. Rating: **E** essential, **N** nice to have, **H** can move to the host side or to speaker.

| # | Capability | Where it is used | Rating | Notes |
|---|---|---|---|---|
| 1 | Boot a VM from a built image (Ubuntu 26.04 rootfs, Alpine `linux-virt` kernel, trimmed initramfs) | `bootGuest` -> `VM.create` in `src/gondolin.ts`; `guest/build.sh`, `build.json`, `Dockerfile`, `boot-assets.mjs`, `rootfs-init.sh` | E | The Gondolin-specific part is large: a 372-line init copied from Gondolin's built-in script, a script that rewrites Gondolin's boot assets and reseals its manifest, and an image import step. |
| 2 | Boot speed | README measurement: 0.95 s median create to first exec (QEMU), 1.05 s (Krun) | N | Matters for launch latency only; tasks run for hours. |
| 3 | Run a command in the guest and get exit code and output | `Guest.exec` in `gondolin.ts`; all of `pi.ts` (`start`, `abort`, `restart`, `quit`, `running`, `kill`, `export`) drives Pi under `dtach` | E | Needs only "run this, give me output". |
| 4 | Owner attaches to the running Pi | `src/cli.ts` runs `gondolin attach <sessionId> -- dtach -a /run/pi.dtach`; `server.ts` exposes `task.guest.sessionId`; `gcSessions()` at startup | E (attended tasks) | Needs an interactive terminal with a PTY. |
| 5 | Deny-by-default egress with a per-host allow list that changes while the VM runs | `isRequestAllowed` in `gondolin.ts` reads `live.hosts` on every request; `tasks.ts` `#apply`; wildcard rules in `leases.ts` `hostMatches`; expiry checked per use | E | Every request re-reads the live view, so a grant change needs no VM action. |
| 6 | Address guard: IPv4 only, private ranges blocked except the model host and speaker | `isIpAllowed` and `blockInternalRanges` in `gondolin.ts` | E, H | A host-side proxy resolves names itself, so this is easy there. |
| 7 | TLS termination with a CA the guest trusts | Gondolin's HTTPS interception; README "Secrets and speaker's proxy" | E today, H | Needed today for four things: URL-path rules for speaker's own routes (`speakerRequestAllowed`), placeholder swap, body capture, and the hop to speaker's proxy. See section 4 for how each can be met without terminating TLS. |
| 8 | Placeholder for the speaker token, swapped only for speaker's host | `createHttpHooks({ secrets: { SPEAKER_TOKEN } })` in `gondolin.ts` | E, H | Plain HTTP to a known host; trivial in any proxy. |
| 9 | **Per-request upstream route for secret hosts** (requests go through speaker's HTTPS proxy as an authenticated CONNECT tunnel; refuse rather than go direct) | `secretRoute` and `httpHooks.upstreamDispatcher` in `gondolin.ts`; **the patch** | E | This is the capability no stock runtime provides. |
| 10 | Capture request and response bodies of model calls (8 MiB / 32 MiB) and other text bodies (1 MiB) for `trace.jsonl` | `captureBodyLimit`, `onResponseComplete` in `gondolin.ts`; also **in the patch** (about 150 of its 220 lines); consumed by `trace-runs.ts` | N (documented feature, not a security control) | Can move to a host gateway for model calls. |
| 11 | Cap on model requests per task | `countModelRequest` in `gondolin.ts` (Gondolin's hook can only allow or refuse, so the guest sees a bare 403) | N, H | A gateway can return a proper 429 with a message. |
| 12 | Rewrite `http://model.internal` to the real local model host | `onRequest` hook in `gondolin.ts` | E, H | Reverse mapping, trivial in a gateway. |
| 13 | Synthetic DNS, so the guest never resolves real addresses | `dns: { mode: "synthetic" }` in `gondolin.ts` | internal detail | Disappears if the guest has no network card. |
| 14 | Guest-to-host control channel (status posts, capability requests) | `tcp.hosts["control.internal"]` in `gondolin.ts`; `guest/extensions/request-capability.ts`; `/guest/status` in `server.ts` | E | A mapped host port today. |
| 15 | Host folders into the guest: `/work` and `/output` read-write, `/etc/pi-v2` read-only | `vfs.mounts` in `gondolin.ts` (`RealFSProvider`); the host reads `/work` and `/output/artifacts` directly at archive time (`tasks.ts` `done`, archiver, `walk`) | E | The host reads these paths straight from its own disk today. See section 4. |
| 16 | `/input/<share>` folder grants, read-only or read-write, added and removed live | `ShareRouter` in `gondolin.ts` (a virtual-filesystem class that forwards the SDK's read-only provider methods by name); `tasks.ts` `#apply`; README "Templates, catalogs, and leases" | E (folders), N (via VM mount specifically) | Speaker's DESIGN.md says every folder could go over `sshfs` through speaker, with live revoke enforced by speaker. |
| 17 | Resource limits | `cpus`, `memory`, `rootfs: { mode: "cow", size }` in `gondolin.ts`; `Limits` in `leases.ts` | E | `workGiB` is only a launch-time free-space check today (README). |
| 18 | Deadline | `setTimeout` -> `close` in `tasks.ts` | E | Already host-side. |
| 19 | Two VM backends (QEMU default, Krun optional) | `PI_V2_VMM` in `gondolin.ts`; `krun-runner.sh`; `doctor.sh`; `boot-assets.mjs` | N | Costs: building a runner from Gondolin source with Zig 0.17 because the published one needs AVX-512; filling Krun kernel slots by hand. Krun was measured no faster than QEMU (README). |
| 20 | macOS | `doctor.sh` has a Darwin branch; README says Krun on macOS is "not tested here" | unknown | I could not tell from the repo whether the owner runs bottle-school on a Mac. Question in section 8. |
| 21 | Per-VM identity for network policy | Policy state is held per task in the `Live` object, closed over by that VM's hooks | E | A per-VM socket path gives the same identity. |

Two further observations from reading the code.

- The patch is not only the ten-line `upstreamDispatcher` hook the README describes. It also adds the capture hooks, so upstreaming only the dispatcher would not remove it. The comment in `gondolin.ts` also mentions a `patches/gondolin-0.13.0.patch` (RTC and qboot changes) that is no longer in `patches/`, so the boot-time tuning described there may be partly stale.
- The host reads `/work` and `/output` as ordinary directories (session archive, `DONE` file, artifact manifest). Any design that stops sharing those directories has to hand them back to the host another way.

## 3. Step 2: candidates

Maintenance figures are what the pages showed on 2026-11-11. "Stars" is a rough proxy for use, not quality.

### 3.1 The architecture first

Every candidate is easier to judge against one concrete design, because most of them are just different ways to supply its parts.

**Design B: plain microVM, no network card, host-side gateway.**

- **VM.** A kernel plus two or three virtio block devices (read-only root image, per-task read-write work disk, a small read-only config disk replacing `/etc/pi-v2`) and a vsock device. No virtio-net, no virtio-fs.
- **Network.** The guest has no route to anything. A small forwarder in the guest image listens on a local port and relays to a host vsock socket. Each VM has its own host socket path, so the gateway knows which task a connection belongs to without trusting source addresses. Because there is nothing to bypass, the in-guest proxy settings are a convenience, not a security boundary.
- **Host gateway (owned by bottle-school, one process):**
  - an HTTP CONNECT proxy checking the task's live host list, resolving names itself and refusing private ranges;
  - for hosts covered by a secret grant, chaining the CONNECT to speaker's proxy with the task's agent token. The guest does TLS end to end with speaker's proxy, so speaker's CA must be trusted in the guest (a public certificate, not a secret). bottle-school never terminates TLS or sees the placeholder swap;
  - a plain-HTTP "model gateway" at `http://model.internal/...` that records bodies for `trace.jsonl`, enforces the request cap, and forwards to the local model, or for hosted providers sends through speaker's proxy the same way as any secret host;
  - speaker's own API as plain HTTP through the gateway, which swaps the speaker token placeholder and applies the same path rules as `speakerRequestAllowed`; this assumes speaker's agent API can be reached over plain HTTP on the LAN, which I did not check;
  - the control channel (`control.internal`) and a raw TCP splice to speaker's SSH jump port, nothing else.
- **Folders.** `sshfs` in the guest against speaker's jump server (DESIGN.md "Using SSH and folders over SSH"). Speaker enforces read-only, path limits and live revoke. This deletes `ShareRouter` and the VM-mount path.
- **Exec and attach.** `sshd` in the guest reached over vsock with a per-VM key delivered on the config disk. `ssh host -- cmd` for `pi.ts`, `ssh -t ... dtach -a /run/pi.dtach` for the owner. These are stock tools.
- **Artifacts.** At close, and for `DONE` polling, read the work disk. Either `ssh ... tar` (simple, works while running) or `debugfs -R "rdump"` on the stopped ext4 image (rootless, no mount). I have not tested either.

What this costs: Node (Pi) must use the proxy, which needs `NODE_USE_ENV_PROXY=1` or a guest-side transparent redirect; and every metadata-heavy folder operation becomes a network round trip. Both are on the spike list.

### 3.2 Runtimes and wrappers

**Firecracker.**

- What: AWS's Rust microVM monitor, used by Lambda and Fly.io. Devices: network, block, vsock, entropy, pmem, memory hotplug; no shared-filesystem device ([README](https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/README.md)). Seccomp-filtered, plus a `jailer`. Fly's write-up quotes the network driver at about 700 lines and about 40 allowed system calls ([Fly.io](https://fly.io/blog/sandboxing-and-workload-isolation/)).
- Capabilities: block images and vsock native; vsock is a Unix socket on the host, so no host kernel module or root is needed for it (my knowledge of its design, not re-checked here). No folders, so sshfs is mandatory. No macOS.
- Boot and memory: about 125 ms to user space with a minimal guest per speaker's DESIGN.md; the README does not state boot or per-VM memory. Default guest memory is 128 MiB.
- Platforms: Linux with KVM only. The README validates Intel server parts, AMD Milan/Genoa and Graviton on Amazon Linux hosts; a consumer CPU such as the owner's Core Ultra is not on that list. That does not mean it fails, but it is unverified.
- Licence: Apache-2.0 (from memory; the page I fetched does not say). Latest release v1.18.0 on 2026-11-09, previous 1.17.0 on 2026-09-10 ([releases](https://api.github.com/repos/firecracker-microvm/firecracker/releases?per_page=2)).
- Glue owned: launcher, kernel choice, rootfs builder, guest init, the whole of Design B. The most code to own, all of it on stable interfaces.

**Cloud Hypervisor.**

- What: Rust VMM on KVM or Microsoft Hypervisor, x86-64 and AArch64; hot-pluggable `virtio-fs` and `virtio-vsock` devices ([README](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/README.md)). Apple's Containerization uses it for its Linux backend, and Arrakis uses it.
- Capabilities: like Firecracker, plus virtio-fs through `virtiofsd` (a separate process per share, not verified here), which would keep VM-mounted folders as an option. Bigger device model than Firecracker. No macOS.
- Release v54.1 on 2026-11-11 ([releases](https://api.github.com/repos/cloud-hypervisor/cloud-hypervisor/releases?per_page=2)). Licence not stated on the page (I believe Apache-2.0). No boot or memory figures published there.
- Glue: same as Firecracker. Choose it only if live VM-mounted folders are still wanted.

**libkrun, krunvm, muvm.**

- What: a library with a bundled VMM, Linux KVM and macOS Hypervisor.framework on ARM64. Devices: block, virtio-fs, net, vsock, console, balloon. Networking is either TSI (the guest's sockets are proxied by the host, no NIC) or virtio-net into a userspace proxy such as passt or gvproxy ([README](https://raw.githubusercontent.com/containers/libkrun/main/README.md)). The README warns that the VM boundary does not limit what host resources the devices expose.
- Release v1.19.8 on 2026-11-06 ([releases](https://api.github.com/repos/containers/libkrun/releases?per_page=2)). Used by Podman's crun, krunkit, muvm. Licence not stated in the page I read.
- Note for this repo: Gondolin's Krun backend is this. The problems recorded in `krun-runner.sh` (AVX-512 build, kernel not fitting RAM) are Gondolin packaging problems, not libkrun's.
- Glue: a thin C or Rust launcher is needed, or use a wrapper: microsandbox, smolvm or BoxLite (3.3). Of those, microsandbox is the one that provides no-network-device, vsock-to-host-socket routes, exec and PTY attach and limits from a Node library. Does Design B on both Linux and macOS with one VMM. TSI does not enforce egress, so use vsock-only.
- I did not look at `krunvm` or `muvm` individually beyond their being libkrun front ends.

**crosvm, QEMU microvm, Kata, gVisor.** I did not fetch pages for these this session; the notes are from general knowledge and should be re-checked.

- crosvm: Chrome OS's Rust VMM, Linux only, virtio-fs and vsock; no versioned releases that I know of, built from source. Firecracker or Cloud Hypervisor fit better.
- QEMU `microvm` machine (what Gondolin uses today): ubiquitous and runs on macOS, but a large C codebase; Fly's article calls C hypervisors a larger attack surface. Good as an emergency backend because it boots the same rootfs.
- Kata Containers: runs OCI containers in microVMs (Firecracker, Cloud Hypervisor, QEMU) and expects containerd or Kubernetes. Far heavier than needed for one host. Fly cites a roughly 75% boot-time reduction for Kata's lightweight VM work ([Fly.io](https://fly.io/blog/sandboxing-and-workload-isolation/)).
- gVisor: a user-space kernel in Go. Not a hardware boundary; Fly cites a "low double-digit" performance cost that worsens under I/O. Linux only, no VM. It would be a weaker-isolation fallback, not a microVM.

### 3.3 Sandbox products

The four libkrun and Firecracker based projects below were re-read from their source trees and docs on 2026-11-11 (cloned read-only, nothing built or run): [microsandbox](https://github.com/microsandbox/microsandbox) at `f9ae8e2`, [smolvm](https://github.com/smol-machines/smolvm) at `f9e93d8` (plus its SDK repo [smol](https://github.com/smol-machines/smol)), [BoxLite](https://github.com/boxlite-ai/boxlite) at `6435328`, [Matchlock](https://github.com/jingkaihe/matchlock) at `14ad97d`. Verdicts rest on what the code and docs say they can do. Project age is recorded under "Maintenance" as information only and is not part of any verdict. The question for each is the same: can it be the launcher in Design B, meaning a VM with no network device, a way for the guest to reach a host-side gateway, exec and attach, and limits.

**microsandbox** ([repo](https://github.com/microsandbox/microsandbox), [docs](https://docs.microsandbox.dev); also published under `superradcompany`). **Fits Design B as the launcher on Linux and macOS.**

- No network device: the TypeScript and Rust builders' `disableNetwork()` / `network(enabled=false)` "disable the network device"; Python, Go and the CLI (`--no-net`) keep the device and deny traffic by policy, so use TypeScript or Rust ([networking overview](https://github.com/microsandbox/microsandbox/blob/main/docs/networking/overview.mdx)).
- Host doors: "host sockets" connect a host unix socket to the guest over virtio-vsock; the guest connects to host CID 2 on the chosen port with `AF_VSOCK`. TypeScript: `.vsock("/run/host-api.sock", 5000)`. Stream (and, on Linux and macOS, datagram) routes; up to 256 connections per route; local backend only ([host sockets](https://github.com/microsandbox/microsandbox/blob/main/docs/networking/host-sockets.mdx)). This is the per-VM socket path Design B needs; the guest needs a small vsock-to-TCP forwarder in the image.
- Egress, if it were used: a user-space network stack in the host process with host and CIDR rules; **the policy is fixed at creation** (the live `modify` call changes CPU, memory, labels, existing secrets, not network rules: [live modify](https://github.com/microsandbox/microsandbox/blob/main/docs/sandboxes/tuning.mdx)). One outbound HTTP CONNECT, SOCKS4 or SOCKS5 proxy can be set per sandbox, but it applies to all outbound TCP (not chosen hosts) and the CONNECT carries the destination IP and port after microsandbox resolved the name itself ([proxies](https://github.com/microsandbox/microsandbox/blob/main/docs/networking/outbound-proxy.mdx)). Secrets are swapped inside the host process, which therefore holds the real value ([secrets](https://github.com/microsandbox/microsandbox/blob/main/docs/sandboxes/secrets.mdx), [TLS](https://github.com/microsandbox/microsandbox/blob/main/docs/networking/tls.mdx)). So its network features cannot do the speaker hop; Design B does not use them.
- Exec and attach: an agent (`agentd`, PID 1 in the guest) speaks over virtio-console. TypeScript `exec`, `execStream`, `attachShell()`, `attachWith(cmd, ...)` (PTY, custom detach keys); CLI `msb exec`, `msb attach` (detached TTY jobs reattachable by job ID, Ctrl-] detaches), `msb ssh`, and an SSH server mode for stock clients ([commands](https://github.com/microsandbox/microsandbox/blob/main/docs/sandboxes/commands.mdx), [ssh](https://github.com/microsandbox/microsandbox/blob/main/docs/sandboxes/ssh.mdx), [isolation](https://github.com/microsandbox/microsandbox/blob/main/docs/security/isolation.mdx)). `attachShell` bridges the calling process's terminal, which suits a CLI `attach` command; I did not check how it behaves when that terminal is itself a herdr pane.
- Limits and disks: `cpus`, `memory` per sandbox, live resize within boot-time `max_cpus`/`max_memory` ceilings; root disk modes managed (layered), flat ext4 with a set size (`root_disk` in [configuration](https://github.com/microsandbox/microsandbox/blob/main/docs/configuration.mdx)); "owned" disk volumes (raw ext4 images, `kind=disk, size`) mount over virtio-blk; bind mounts (virtio-fs, `readonly()` available) also exist ([volumes](https://github.com/microsandbox/microsandbox/blob/main/docs/sandboxes/volumes.mdx)).
- Images: OCI images from any registry used directly (Docker archives load with `msb load`), or a disk image file (QCOW2, raw, VMDK) booted as the root ([images](https://github.com/microsandbox/microsandbox/blob/main/docs/images/overview.mdx)). Per the owner's correction an Ubuntu rootfs is not required: an image with Node, Python/uv, git, gh and the other tools built from any base suffices. I did not check that a Dockerfile-built image runs unmodified with `agentd` injected; the docs say "existing images run as-is".
- Platforms: libkrun on KVM (Linux) and Hypervisor.framework (macOS, Apple silicon) ([README](https://github.com/microsandbox/microsandbox/blob/main/README.md)). Docs also list Windows. The macOS binary is signed with the hypervisor entitlement.
- Embedding: `microsandbox` npm package with a native module (napi), "no daemon to install and no server to connect to"; creating a sandbox spawns a VM as a child process ([SDK overview](https://github.com/microsandbox/microsandbox/blob/main/docs/sdk/overview.mdx), [package.json](https://github.com/microsandbox/microsandbox/blob/main/sdk/node-ts/package.json)). The `msb` runtime and `libkrunfw` kernel are installed once by a setup call. Rust, Python, Go and Ruby SDKs also exist.
- Security boundary: the per-sandbox host process embeds the VMM, network stack, filesystem broker and secret injection, and "runs as the same user that launched it", needing only `/dev/kvm` on Linux. Guests reach the host through a fixed device list (console, net, fs, blk, rng). **I found no seccomp, Landlock or sandbox-exec confinement of that process** (searched `crates/` for those terms; none), and smolvm's source notes that libkrun itself installs no seccomp filter ([smolvm `process.rs`](https://github.com/smol-machines/smolvm/blob/main/src/process.rs)). That is also true of a bottle-school-written libkrun launcher; the control channel from guest to host is host-driven and the docs state the host treats guest frames as untrusted ([isolation](https://github.com/microsandbox/microsandbox/blob/main/docs/security/isolation.mdx)).
- Licence Apache-2.0. Maintenance: 9.0k stars, 75 contributors listed by the API (two account for most commits), 76 releases, v0.7.14 on 2026-11-08, repository created 2024-10; version 0.x with a `COMPATIBILITY.md` describing its upgrade rules ([repo API](https://api.github.com/repos/microsandbox/microsandbox), [releases](https://api.github.com/repos/microsandbox/microsandbox/releases?per_page=100)).
- Verdict: use as the launcher, keep bottle-school's gateway. Technical reasons: a documented no-device option, a documented host-unix-socket to guest-vsock route, built-in exec and PTY, size limits, and an in-process library for Node, all on both platforms. Not verified (needs the spike): that a sandbox with the device disabled boots and passes vsock on both platforms; that exec and attach keep working with no network; that the vsock route can serve many concurrent connections under load; how `sshfs` (FUSE in the guest) behaves on microsandbox's kernel (the FUSE module must be present in the `libkrunfw` kernel; I did not check its config); and reading the work disk from the host (`debugfs` on an owned disk volume, or a bind mount).

**smolvm** ([repo](https://github.com/smol-machines/smolvm), SDK in [smol](https://github.com/smol-machines/smol)). **Technically capable of Design B, but the needed features are on its CLI and local HTTP API, not in its Node SDK. Second choice.**

- No network device: networking is off unless `--net` is given ([limitations](https://github.com/smol-machines/smolvm/blob/main/docs/limitations.md), [security model](https://github.com/smol-machines/smolvm/blob/main/docs/security-model.md)). The default network mode when on is TSI (no emulated NIC, egress allow lists unenforceable and refused, per `src/config.rs`); `virtio-net` is the enforcing mode ([egress code](https://github.com/smol-machines/smolvm/blob/main/src/config.rs)).
- Host doors: `--mount-socket HOST:GUEST` puts a host unix socket at a guest path (a guest process connects to an ordinary unix socket; libkrun bridges it over vsock via `krun_add_vsock_port2`), and `--expose-socket` goes the other way; up to 64 each; "CLI-only" ([security model](https://github.com/smol-machines/smolvm/blob/main/docs/security-model.md), [`vsock_service.rs`](https://github.com/smol-machines/smolvm/blob/main/src/agent/vsock_service.rs)). The Node SDK's `HostMountConfig` is directory mounts only; I found no socket option in its type definitions ([binding.d.ts](https://github.com/smol-machines/smol/blob/main/sdk/node/binding.d.ts)).
- Egress: with `virtio-net`, `--allow-host`, `--allow-host-pattern`, `--allow-cidr`, and `smolvm machine update` adds or removes them **on a running machine**, "a grant applies to the next connection or lookup" ([README](https://github.com/smol-machines/smolvm/blob/main/README.md)). The Node SDK can only replace the egress policy of a stopped machine (`EgressPolicyConfig`). **Mediated egress** lets a host process decide each guest TCP flow (allow, deny, or redirect, given the destination and the first 8 KiB, so TLS SNI and HTTP headers) and a redirect turns the accepted connection into the flow's byte stream, with no TLS termination by smolvm; this could send chosen hosts to speaker's proxy without smolvm holding the secret. It needs `virtio-net`, is rejected with built-in credential substitution, and has a custom decider protocol ([mediated egress](https://github.com/smol-machines/smolvm/blob/main/docs/mediated-egress.md)). Built-in `--credential` swaps placeholders in the host process, so the real value lives there ([credential substitution](https://github.com/smol-machines/smolvm/blob/main/docs/credential-substitution.md)). The varlock write-up cited earlier concerned smolvm 1.7.1; the current docs describe the enforcing mode and mediated egress above, and the version is now 1.34.1, so that finding is superseded rather than re-tested.
- Exec and attach: `smolvm machine exec` (`-i`, `-t` flags), and `smolvm serve` exposes `POST /api/v1/machines/<name>/exec` and `exec/stream`, with a PTY-capable session type and WebSocket readers in `src/api/exec_sessions.rs`. The Node SDK has `exec`, `execStream`, `execBackground` but no terminal option in `ExecOptions` ([binding.d.ts](https://github.com/smol-machines/smol/blob/main/sdk/node/binding.d.ts)). So bottle-school would spawn the CLI or call the local API for attach.
- Limits and disks: `--cpus`, `--mem`; storage disk (default 20 GiB, grow only) and overlay disk (default 10 GiB) per machine; memory elastic through a balloon. Images are OCI; with no image it boots a bare Alpine; Smolfiles pin everything ([smolfile](https://github.com/smol-machines/smolvm/blob/main/docs/smolfile.md), [binding.d.ts](https://github.com/smol-machines/smol/blob/main/sdk/node/binding.d.ts)).
- Platforms: libkrun on KVM (Linux x86_64 and aarch64) and Hypervisor.framework (Apple silicon only; no Intel macOS archive is published) and Windows ([install notes](https://github.com/smol-machines/smolvm/blob/main/docs/install/SKILL.md)). macOS needs the signed binary.
- Embedding: SDKs run in-process, no daemon (Node `smolmachines`, napi), plus `smolvm serve` (HTTP over a unix socket or TCP) and the CLI. Host process runs as the invoking user.
- Security boundary: the VM boot subprocess gets a Firecracker-style **seccomp allowlist** (set to enforce by default under `smolvm serve`, via `SMOLVM_SECCOMP` otherwise) and Landlock confinement of its storage; the source comment states that libkrun installs no filter of its own ([process.rs](https://github.com/smol-machines/smolvm/blob/main/src/process.rs), [storage.rs](https://github.com/smol-machines/smolvm/blob/main/src/storage.rs)). This is the one concrete host-process hardening among the four. The docs say the project is not "a hardened multi-user control plane" and release archives are unsigned.
- Licence Apache-2.0. Maintenance: 7.1k stars, 65 contributors (one account has most commits), 100+ releases, v1.34.1 on 2026-11-10, repository created 2025-12 ([repo API](https://api.github.com/repos/smol-machines/smolvm), [releases](https://api.github.com/repos/smol-machines/smolvm/releases?per_page=100)).
- Verdict: a valid alternative launcher with stronger host confinement, but with Design B it means driving the CLI (for socket mounts) and the local API or CLI (for attach) from Node, which is more glue than microsandbox's library. Choose it over microsandbox if the spike shows microsandbox cannot do no-network plus vsock, or if confinement of the VMM process matters more than API convenience. Not verified: that `--mount-socket` works on a machine with networking off on macOS; whether `smolvm serve` can set socket mounts (docs say CLI-only).

**BoxLite** ([repo](https://github.com/boxlite-ai/boxlite), [docs](https://docs.boxlite.ai)). **Does not fit Design B: a no-network box has no way to reach a host gateway.**

- No network device: yes, `NetworkSpec::Disabled` "has no NIC or gvproxy", and a running no-NIC box cannot be switched to enabled ([networking guide](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/networking.md)).
- Host doors: the libkrun engine adds vsock ports only for the guest agent (gRPC) and a ready signal ([`engine.rs`](https://github.com/boxlite-ai/boxlite/blob/main/src/boxlite/src/vmm/krun/engine.rs)). I found no option for user-defined vsock or host-socket routes. Mounts are volumes and bind directories (virtio-fs) only (`MountSpec`). Without a door, the guest cannot reach a gateway when the NIC is absent.
- Egress when a NIC exists: user-space gvproxy over vsock. `allow_net` (hostnames, `*.` wildcards, IPv4, CIDR; hostname rules match HTTP Host or TLS SNI) can be **replaced on a running box** (`update_outbound`); new flows use it, existing flows keep theirs. Secrets are injected into `Authorization` headers by a per-box MITM CA whose key stays on the host; the real value is held by the host runtime. No upstream proxy option was found in the Node reference or docs ([Node reference](https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/nodejs/README.md), [concepts](https://github.com/boxlite-ai/boxlite/blob/main/docs/concepts/networking.md)). A NIC with `allow_net` limited to a gateway address would be a weaker form of Design B; whether gvproxy lets the guest reach a host-LAN address that way is not checked.
- Exec and attach: Node `exec(cmd, args, env, tty)`, `attach(executionId)`, an `InteractiveBox` class, and optional guest SSH control ([Node reference](https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/nodejs/README.md), [ssh](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/ssh.md)).
- Limits and disks: `cpus` (fractional on Linux), `memory_mib`, `disk_size_gb` (sparse copy-on-write rootfs disk); rootfs from an OCI image or a prepared rootfs path (`RootfsSpec`) ([options.rs](https://github.com/boxlite-ai/boxlite/blob/main/src/boxlite/src/runtime/options.rs)).
- Platforms: libkrun on KVM and Hypervisor.framework (Apple silicon, macOS 12+) ([README](https://github.com/boxlite-ai/boxlite/blob/main/README.md)).
- Embedding: daemonless library ("no root, no background service"); Node package `@boxlite-ai/boxlite` (napi), also Python, Rust, Go, C; optional `boxlite serve` REST server.
- Security boundary: a jailer around the shim process (Linux: namespaces, chroot, seccomp, privilege drop, cgroups v2; macOS: sandbox-exec); `SecurityOptions::default()` has `jailer_enabled: true`, though the security doc says defaults "prioritize compatibility", so I did not settle which profile ships ([security](https://github.com/boxlite-ai/boxlite/blob/main/docs/concepts/security.md), [`advanced_options.rs`](https://github.com/boxlite-ai/boxlite/blob/main/src/boxlite/src/runtime/advanced_options.rs)).
- Licence Apache-2.0. Maintenance: 2.6k stars, 46 contributors (one has most commits), 51 releases, v0.13.0 on 2026-11-11, repository created 2025-12 ([repo API](https://api.github.com/repos/boxlite-ai/boxlite), [releases](https://api.github.com/repos/boxlite-ai/boxlite/releases?per_page=100)).
- Verdict: technically strong on confinement, live allow list and Node API, but it lacks the one primitive Design B needs from a launcher (a host door for a no-NIC guest) and has no per-host upstream proxy. Revisit if it gains user vsock or unix-socket routes.

**Matchlock** ([repo](https://github.com/jingkaihe/matchlock)). **Does not fit Design B: no host door for a no-network guest, no upstream proxy.**

- Backends (this resolves the earlier conflict): Linux uses **Firecracker** (`Name()` returns `"firecracker"`, [linux backend](https://github.com/jingkaihe/matchlock/blob/main/pkg/vm/linux/backend.go)); macOS uses Virtualization.framework with gVisor's user-space TCP/IP stack for traffic interception ([darwin backend](https://github.com/jingkaihe/matchlock/blob/main/pkg/vm/darwin/backend.go)). Different mechanisms per platform, one CLI.
- No network device: `--no-network` creates no interfaces (the Linux backend skips the TAP device), and cannot be combined with allow list or secrets ([README](https://github.com/jingkaihe/matchlock/blob/main/README.md), [network interception](https://github.com/jingkaihe/matchlock/blob/main/docs/network-interception.md)). The only host-guest channels are fixed: vsock 5000 (exec), 5002 (ready) and a host-to-guest port-forward. I found no way to expose a guest-to-host vsock port or a host unix socket.
- Egress: transparent proxy via nftables redirect (Linux) or the gVisor stack (macOS); allow list **can change on a running VM** (`matchlock allow-list add/delete`); hook rules (block, mutate, SDK callbacks) run on decrypted traffic. Secrets are swapped in the host MITM path, so the host process holds the value. Searching non-test code for upstream proxy, SOCKS and CONNECT support found none.
- Exec and attach: `matchlock exec <vm> -it`, `run -it`; the TypeScript, Python and Go SDKs have exec with terminal resize.
- Limits and disks: `--cpus` (fractional), `--memory` MB, `--disk-size` MB, per-VM writable rootfs copy, extra raw ext4 disks (`--disk`); OCI images flattened to ext4, `matchlock build` runs BuildKit. No host-directory mounts: files go in and out by `cp`.
- Embedding: Go CLI and SDK; the TypeScript SDK spawns `matchlock rpc` as a child process over stdio ([transport.ts](https://github.com/jingkaihe/matchlock/blob/main/sdk/typescript/src/client/transport.ts)). Linux host setup: the binary gets `cap_net_admin,cap_net_raw`, needs nftables, `e2fsprogs`, `erofs-utils`, and `sudo matchlock setup linux` ([linux packaging](https://github.com/jingkaihe/matchlock/blob/main/docs/linux-packaging.md)).
- Security boundary: Firecracker is the VMM; a `jailer` binary is packaged but I found no code that starts the VM through it; in-guest seccomp and capability dropping unless `--privileged`. MITM and secrets live in the host process.
- Licence MIT. Maintenance: 652 stars, 8 contributors (one account has about 530 of the commits), 41 releases from v0.1.0 (2026-02-07) to v0.3.1 (2026-10-31) ([repo API](https://api.github.com/repos/jingkaihe/matchlock), [releases](https://api.github.com/repos/jingkaihe/matchlock/releases?per_page=100)).
- Verdict: it is a good "network on, allow list on" sandbox, which is not Design B. Using it would put the gateway's job (including the speaker hop) into Matchlock's proxy, which cannot chain to speaker's proxy without patching. Not pursued.

**NVIDIA OpenShell** ([repo](https://github.com/NVIDIA/OpenShell), [docs](https://docs.nvidia.com/openshell/)). Apache-2.0, 21.5k stars, v0.1.8 on 2026-11-10 ([releases](https://api.github.com/repos/NVIDIA/OpenShell/releases?per_page=3)), moving to a CNCF-hosted org. It is a full agent platform, not a sandbox library: a gateway (control plane), a supervisor in each sandbox, policies for files, processes and network, hot-reloadable network policy, credential placeholders resolved only for approved endpoints, and a prover that flags risky policy changes for human review. Drivers: Docker, Podman, Kubernetes, and an opt-in microVM driver (libkrun on KVM and Hypervisor.framework; QEMU for GPU). That driver currently ignores `--cpu` and `--memory` and takes `vcpus` and `mem_mib` instead ([compute drivers](https://docs.nvidia.com/openshell/v0.0.116/reference/sandbox-compute-drivers.md), v0.0.116 docs). Requires Landlock ABI 3 or newer (Linux 6.2+) and seccomp user-notification inside the guest ([support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix.md)). Linux and macOS on Apple silicon.
Verdict: it duplicates speaker's job (owner approval, credential placeholders, policy review) with its own gateway and policy language. Adopting it means two policy planes. Worth borrowing ideas from (hot-reload network policy, a verifier for requested rules), not adopting as the sandbox. I could not find how its egress proxy handles TLS or how a CLI attaches; the docs I read do not say.

**e2b infrastructure** ([repo](https://github.com/e2b-dev/infra)). Firecracker with snapshot restore, Apache-2.0, about 1.8k stars. Single-host "embed" mode exists but needs PostgreSQL, Redis, ClickHouse and object storage. A cloud service stack, far larger than this need. Skip.

**Arrakis** ([repo](https://github.com/abshkbh/arrakis)). Cloud Hypervisor microVMs with a REST server, snapshots, a Python SDK. Linux only. Licence is **AGPL-3.0** (commercial licence on request), about 896 stars, no releases shown, a CLA for contributors. Licence and single-owner project make it a poor dependency.

**Docker Sandboxes (`sbx`).** Per-agent microVM, host-side proxy with allow and deny lists and credential injection, macOS and (per newer sources, which conflict with a January 2026 blog) Linux; requires `sbx login` with Docker OAuth ([docs](https://docs.docker.com/ai/sandboxes/get-started.md)). I could not establish whether it is open source and the sign-in requirement is a poor fit for a self-hosted service. Not pursued.

**Apple Containerization** ([repo](https://github.com/apple/containerization)). Swift package, one lightweight VM per container, "sub-second" start (no numbers), Apache-2.0. Needs Apple silicon, macOS 26 and Xcode 26. Version 0.1.0 was the first release; "source stability is guaranteed only within minor versions." Its Linux backend is Cloud Hypervisor with virtiofsd and is secondary. Useful only as a possible macOS leg of Design B; not a Linux answer.

**jai** ([site](https://jai.scs.stanford.edu/)). Stanford SCS tool that wraps a command in a Linux containment (working directory read-write, copy-on-write home, everything else read-only). No images. It says it is not a promise of perfect safety and not suitable against a determined adversary, and it does not mention network control, VM isolation, or licence. A convenience for the owner's own trusted sessions, not a disposable-VM sandbox. Not a fit.

**Luis Cardoso's essay** ([link](https://www.luiscardoso.dev/blog/sandboxes-for-ai)). The page returned HTTP 429 twice, so I could not read it. A search turned up only secondary summaries that make a boundary-strength argument (containers share the kernel, gVisor interposes on system calls, Firecracker and Kata give a hardware boundary); I do not cite that as his words.

### 3.4 Comparison table

| Option | Boundary | Linux / macOS | Licence | Maintenance (as seen) | Egress with live allow list | Secret hop via speaker | Folders | Glue bottle-school owns |
|---|---|---|---|---|---|---|---|---|
| Gondolin 0.14 as is | QEMU or libkrun VM | both (macOS untested here) | Apache-2.0 | v0.14.0 2026-10-22; 2.4k stars; pushed today | yes, hooks | **needs a local patch** | virtio-fs via custom provider | patch, ShareRouter, boot-assets, init, Krun runner build |
| Gondolin, patches upstreamed | same | same | same | depends on upstream accepting | yes | yes if accepted | same | reduced; still guest init and ShareRouter |
| **Design B on Firecracker** | KVM microVM | Linux only | Apache-2.0 (recalled) | v1.18.0 2026-11-09 | host gateway (owned) | yes, by CONNECT chain | sshfs via speaker | launcher, image build, tiny guest init, gateway, SSH wiring |
| Design B on Cloud Hypervisor | KVM microVM | Linux only | not stated (recalled Apache-2.0) | v54.1 2026-11-11 | owned | yes | sshfs, or virtiofsd shares | as above, plus virtiofsd if used |
| **Design B on microsandbox (launcher), bottle-school gateway** | libkrun VM, no network device | both (Apple silicon on macOS) | Apache-2.0 | v0.7.14 2026-11-08; 9.0k stars; 75 contributors; 0.x API | owned (microsandbox's own network engine unused) | yes, by CONNECT chain in the owned gateway | sshfs via speaker | gateway, image, thin wrapper around its TS SDK |
| Design B on libkrun directly | microVM | both | not stated | v1.19.8 2026-11-06 | owned | yes | sshfs | as above, plus a launcher, kernel, guest init and exec path |
| Matchlock | Firecracker (Linux), Virtualization.framework (macOS) | both | MIT | v0.3.1 2026-10-31; 652 stars; 8 contributors | yes, live CLI | no upstream proxy; holds real secret in host process | none (copy in and out) | not usable for Design B: no guest-to-host door when networking is off |
| microsandbox (as a full sandbox) | libkrun | both | Apache-2.0 | as above | allow list fixed at creation; one proxy for all traffic, CONNECT sends IP not name | no; holds real secret in host process | virtio-fs host dirs | its network features unused in Design B; see launcher row |
| smolvm | libkrun, seccomp on VM process | both (Apple silicon on macOS) | Apache-2.0 | v1.34.1 2026-11-10; 7.1k stars; 65 contributors | live `machine update`; per-flow host decider (mediated egress) needs virtio-net | built-in credentials hold the value; mediated egress could redirect without it | host dirs; socket mounts | viable launcher via CLI or local API; Node SDK lacks socket mounts and PTY |
| BoxLite | libkrun, jailer around VM process | both (Apple silicon on macOS) | Apache-2.0 | v0.13.0 2026-11-11; 2.6k stars; 46 contributors | live `update_outbound` (needs a NIC) | no upstream proxy found; holds value in host MITM | bind and volume mounts | not usable for Design B: no host door when NIC is absent |
| OpenShell | container or libkrun VM | both (macOS via Docker) | Apache-2.0 | v0.1.8 2026-11-10; 21.5k stars | yes | its own, overlaps speaker | policy-based | a second policy plane |
| e2b infra | Firecracker | Linux | Apache-2.0 | active | n/a | n/a | n/a | far too large |
| Arrakis | Cloud Hypervisor | Linux | AGPL-3.0 | no releases seen | none documented | none | none | licence blocker |
| Apple Containerization | VZ VM | macOS 26 only (Linux secondary) | Apache-2.0 | 0.1.x | none | none | virtiofs | macOS leg only |
| gVisor / Kata / jai | user-space kernel / VM via containerd / namespaces | Linux | not checked / not checked / not stated | not checked | via netns, owned | owned | bind mounts | weaker boundary or too heavy |

## 4. Step 1 revisited: what moves where

| Capability | Design B answer |
|---|---|
| VM boot from image | microsandbox boots OCI images directly (any base with the packages Pi needs: Node, Python/uv, git, gh, common CLI tools, optional Playwright), or a raw ext4 or qcow2 disk. The Docker build is kept; the export to ext4, `rootfs-init.sh`, `boot-assets.mjs` and kernel selection go. On a bottle-school-written libkrun launcher instead: export rootfs to ext4 (`mke2fs -d`), a kernel, and a short init. |
| Exec and attach | microsandbox's `exec` and `attachShell`/`attachWith` over its agent channel (no guest `sshd`). On a bottle-school-written launcher: SSH over vsock (key on config disk). |
| Live host allow list, address guard, wildcard rules | Gateway reads the same `Live` state; `hostMatches` and `unexpired` from `leases.ts` are reused unchanged. |
| TLS termination | Not needed. Secret hosts use end-to-end TLS to speaker's proxy; other hosts are plain CONNECT passthrough. Loses: path-level rules on third-party HTTPS hosts (not used today except for speaker) and generic HTTPS body capture. |
| Speaker token placeholder | Gateway swaps it on the plain-HTTP route to speaker. |
| Secret hosts | CONNECT chain to speaker's proxy with the agent token held by the gateway. This replaces the patch. |
| Model capture, request cap | Model gateway at `http://model.internal`. Loses bodies of non-model HTTPS traffic in `trace.jsonl`. |
| Control channel | A vsock port to the existing guest listener in `server.ts`. |
| `/work`, `/output` | Per-task ext4 disk. The disk gives a real size limit (a gain over today's free-space check). Archive reads it over SSH or with `debugfs`. `DONE` can be posted on the control channel rather than polled on disk. |
| `/etc/pi-v2` | Small read-only ext4 disk built with `mke2fs -d` per task. |
| `/input/<share>` | `sshfs` from speaker; `ShareRouter` deleted. |
| Limits and deadline | VMM CPU and memory settings and the existing host timer. |
| Krun, QEMU, macOS | microsandbox covers Linux and macOS with one library; the Krun runner build and QEMU backend go. |

## 5. Step 3: decision

### Primary: Design B with microsandbox as the launcher (Linux and macOS)

The owner requires macOS, so the first backend is libkrun, which microsandbox wraps for both platforms. The reasons below hold for any VMM behind the same contract; a bottle-school-written libkrun launcher (and optionally Firecracker on Linux) stays as the fallback if the spike rejects microsandbox.

Reasons:

- It deletes every patch and every dependency on another project's internal files. What remains talks to Firecracker's documented API, SSH, and an HTTP proxy.
- It matches speaker's own conclusion in DESIGN.md: "one folder mechanism for every agent, live revoke of folders, and a free choice of VM runtime".
- The no-network-card guest is a stronger and simpler boundary than a filtered NIC: there is no route to police, and each VM's socket identifies the task.
- The secret hop needs no TLS interception by bottle-school, so bottle-school never touches the secret exchange at all.
- Every part (proxy, ext4, vsock, the VM launcher) has a replacement: microsandbox, smolvm, or a bottle-school-written libkrun launcher all fit behind the same contract, so no single project can strand it. This is a technical statement about the contract, not about any project's age.
- microsandbox is the only project of the four that provides, in one in-process Node library on both platforms, a no-network-device mode, guest vsock to host unix socket routes, exec with PTY attach, and CPU, memory and disk limits. smolvm has the same capabilities but the socket mounts and attach are not in its Node SDK; BoxLite and Matchlock lack a host door for a no-NIC guest (section 3.3).

Honest cost: this is not less code than today. Rough count of what is replaced: about 1,200 lines (`gondolin.ts` 439, patch 220, `rootfs-init.sh` 372, `boot-assets.mjs` 127, `krun-runner.sh` 38) against a new launcher, gateway and short init that I would expect in the same range. The gain is the kind of code, not the amount: nothing that must be re-derived when a dependency changes.

If the spike confirms microsandbox, the code bottle-school owns shrinks to the gateway, the image definition and a thin wrapper (create with no network and the vsock routes, exec, attach, read the work disk); the launcher, kernel, guest init, exec protocol and PTY handling are not owned. If it does not, a libkrun launcher of a few hundred lines is the fallback.

### Fallback: stay on Gondolin, zero local patches

- Offer upstream the `upstreamDispatcher` hook and the capture hooks (together about 150 added lines).
- Drop Krun and the Krun runner build; use QEMU only. Remove the `boot-assets.mjs` reshaping if stock assets boot fast enough, or keep it if not (the saving, per the stale comment, is unproven).
- Optionally move folders to sshfs to retire `ShareRouter`.

This is the least work and keeps macOS and live VM-mounted shares. Its weakness is the one the owner named: it relies on Gondolin's internals and its description of itself as "an early project" ([docs](https://earendil-works.github.io/gondolin)).

### What bottle-school gains and loses against Gondolin

Gains:
- No patches, no Zig build, no Krun/QEMU split, no initramfs surgery.
- A real per-task disk quota.
- Folder grants enforced and revoked by speaker, not by a custom filesystem class.
- Model rate-limit answered with a proper message instead of a bare 403.
- Exec and attach over standard SSH.
- No guest network card to configure or attack.

Losses:
- macOS, until a second VMM leg is built (libkrun or Apple's framework).
- Fast folder metadata operations (`grep -r`, `find`, `git status` on a share) over `sshfs`; DESIGN.md already flags this.
- Body capture for traffic other than model calls, and TLS-level inspection of third-party HTTPS.
- Gondolin's integrated tooling (`gondolin exec`, image cache, `gcSessions`), replaced by owned scripts.
- Pi and other Node tools must honour a proxy setting or be redirected in the guest.

### Main risks

1. Node and Pi do not use `HTTPS_PROXY` by default. If `NODE_USE_ENV_PROXY` is not enough (for example for Pi's bundled fetch or extension code), the guest needs a transparent redirect, which is more guest-side glue.
2. `sshfs` speed and stability for real workloads, including `git` on a share. This is the main reason to keep Cloud Hypervisor plus virtiofsd, or Gondolin, in reserve.
3. A guest `sshd` and a vsock forwarder add guest user-space services and a few seconds of boot work; boot may end up no faster than today.
4. Firecracker on the owner's actual CPU and kernel is unverified (README lists server platforms only).
5. Speaker's CA must be trusted by every client in the guest (system store, Node's `NODE_EXTRA_CA_CERTS`, Python's CA bundle). Gondolin has the same issue today; the README already lists "certificate inheritance through dtach" as unverified.
6. Anything speaker does not yet provide must exist first: its SSH jump path and `sshfs` folder grants for sandboxed agents (DESIGN.md describes them; I did not check what is implemented), and an agent token usable from the gateway's address.
7. The vsock-only design depends on the guest forwarder being the only way out. A guest compromise is limited to the same doors a granted task already has, but the gateway itself becomes a high-value process and needs the same care as speaker's proxy.

### Migration outline

1. **Spike (days).** Run the checks in the next section; decide microsandbox versus smolvm versus a bottle-school libkrun launcher versus Gondolin fallback.
2. **Gateway first, on today's runtime.** Build the host gateway as a standalone process and test it against the existing Gondolin guest using proxy settings, replacing `secretRoute` and the capture hooks. This removes the patch while keeping everything else, and is a safe stopping point (it is also the fallback's strongest form).
3. **Folders.** Switch folders to `sshfs` through speaker; retire `ShareRouter` and the VM-mount item reporting; update speaker's share report.
4. **New VM layer.** Add a launcher module on microsandbox's TypeScript library (no network, vsock routes to the gateway's per-VM sockets, resource limits, OCI image built from the existing Dockerfile), exec and attach through its API, `/work` and `/output` on a per-task disk; change archiving to read it. Pin the microsandbox version.
5. **Cut over.** Run both for a while, then remove Gondolin, the patch, `boot-assets.mjs`, `krun-runner.sh`, the Krun checks in `doctor.sh`, and `PI_V2_VMM`.
6. **Later, optional.** Firecracker as a Linux-only backend behind the same contract, if it proves faster.

## 6. What must be verified by a spike before committing

1. On libkrun through microsandbox, on the Linux server (service account, `/dev/kvm` only) and on a Mac: a sandbox with `disableNetwork()` and one `vsock()` route boots an image with Pi's packages, reaches a test listener on the host unix socket from a guest forwarder, and passes exec and `attachShell`; measure time to first exec and memory per VM against Gondolin's 0.95 s. Also check the guest kernel supports FUSE for `sshfs`, and that a large number of concurrent vsock connections works.
   Include a bottle-school-written libkrun launcher with vsock only (no network device) as the fallback measurement, and Firecracker on the owner's CPU if it is still wanted.
2. Pi, `gh`, `git`, `curl`, `uv`/`pip` and Playwright work through the proxy only (env variables or guest redirect). Include `NODE_USE_ENV_PROXY=1` on the Node version Pi ships with.
3. The CONNECT chain to speaker's proxy: `git clone` of a large repo and `gh pr create` end to end with the placeholder; revoke returns 403 at once; the guest trusts speaker's CA in every client.
4. `sshfs` against speaker's jump server: `grep -r`, `find`, `git status` on a realistic share, compared with the current sandboxfs numbers (README: 75-157 MB/s throughput); behaviour at grant expiry.
5. `attach` experience: PTY, resize, detach with `dtach`, reconnect, from the CLI and inside herdr.
6. Artifact retrieval: `tar` over the launcher's exec (or `ssh tar`) while running and `debugfs rdump` on a stopped disk; crash recovery of a half-written work disk.
7. Whether Node's `fetch` honours a plain-HTTP `model.internal` base URL and streaming responses through the gateway without buffering (the model replies are streamed and reassembled for the trace).
8. smolvm check, only if microsandbox fails check 1: `--mount-socket` on a no-network machine on Linux and macOS, attach through the CLI or local API, seccomp mode under the service account.
9. Whether speaker's agent API can be reached over plain HTTP from the gateway and whether its token binding (bound to the sandbox host's address) works when the gateway is the caller.

### Trial result on Linux: go

microsandbox 0.7.14 from npm (`microsandbox` plus `@superradcompany/microsandbox-linux-x64-gnu`, Apache-2.0), driven from Node as the owner's user with no root, no daemon and no system packages; one `libkrun` process per VM, needing only `/dev/kvm` access.

| Check | Result |
| --- | --- |
| Boot a stock OCI image (`debian:stable-slim`) | first command at about 0.28 s with the image cached; 4.4 s with a cold pull |
| No network device (`disableNetwork()` in the Node API) | only `lo` and an idle kernel `dummy0`; no route |
| Host unix socket to guest vsock (`.vsock(path, port)`) | byte round trip with `socat - VSOCK-CONNECT:2:<port>` in the guest |
| Exec and terminal | `exec` returns output and exit code; `attachShell()` gives a PTY (needs a host TTY; resize not yet checked) |
| CPU, memory, disk | `cpus`, `memory` and a root-disk size cap hold; the OCI image is a read-only layer under a writable overlay that lasts for the VM's life |
| FUSE and `sshfs` with no network | `/dev/fuse` present; `sshfs -F <config>` with `ProxyCommand socat - VSOCK-CONNECT:2:<port>` mounted a host folder through a stock non-root `sshd`, reads and writes both ways |

Setup requirement: microsandbox refuses a storage folder that other accounts could write; bottle-school must create its microsandbox storage folder with mode 700 (or run with `umask 077`).

What the gateway still needs from maintained parts: `socat`, `sshfs` and `openssh-client` baked into the guest image; an egress proxy with a per-request allow list and upstream chaining to speaker's proxy (candidate: the `proxy-chain` npm package; alternatives squid or tinyproxy); a model-call recorder.

Still unverified: macOS (vsock routes are documented as supported; entitlements and FUSE in the macOS guest kernel are open), `sshfs` throughput over vsock, many concurrent VMs, terminal resize, `sb.ssh()`.

## 7. Owner's decisions

- **macOS is a requirement.** A separate backend is fine if it stays a few dozen lines. Consequence: libkrun first (one backend for Linux and macOS); Firecracker optional on Linux. Spike check 1 runs on libkrun (through microsandbox) on both the Linux server and a Mac, with no network device and vsock only.
- **Folders over `sshfs` are acceptable.** Consequence: no VM-mount path is kept; `ShareRouter` and VM-mount share reporting can be retired in the folders step of the migration.
- **A custom Ubuntu rootfs is not a requirement; project age is not a reason.** The Ubuntu image only supplied the packages Pi needs (Node, Python/uv, git, gh, common CLI tools, optionally Playwright and Chromium). Any image format a project supports is acceptable if those packages can be installed; none of the four projects was ranked down for its image format, and all verdicts in 3.3 rest on technical facts (the maintenance figures there are information only).

## 8. What I could not verify

- Luis Cardoso's essay (HTTP 429 on two attempts). I did not use it.
- OpenShell: how its egress proxy handles TLS, what its CLI attach path is, which database the gateway uses, and whether the microVM driver is ready for daily use. The docs I read did not say.
- microsandbox (resolved from source, not run): upstream proxy is one per sandbox for all TCP and sends IPs; network policy is fixed at creation; mounts can be read-only. Still unverified: boot and vsock with the network device disabled on both platforms, FUSE in its guest kernel for `sshfs`, behaviour of `attachShell` inside herdr, and whether a Dockerfile-built image runs unmodified with its agent injected. I found no host-process seccomp or sandbox-exec confinement.
- Matchlock (resolved from source, not run): Linux backend is Firecracker, macOS is Virtualization.framework; resource flags exist (`--cpus`, `--memory`, `--disk-size`). Unverified: whether a guest-to-host vsock route exists beyond what I searched for, and whether the packaged `jailer` is used at all.
- smolvm and BoxLite (resolved from source and docs, not run): smolvm is v1.34.1; BoxLite is v0.13.0 and its network and secret features are described in 3.3. Unverified for smolvm: `--mount-socket` with networking off on macOS, and whether `smolvm serve` can set socket mounts. Unverified for BoxLite: whether its default build turns the jailer on (code says yes, docs say "compatibility" first), and whether gvproxy lets a guest reach a host-LAN gateway address.
- The smolvm finding from varlock (version 1.7.1) was not re-tested; current docs and source describe a different state.
- Licences of Firecracker, Cloud Hypervisor, libkrun, crosvm and jai were not stated on the pages I read; "Apache-2.0" for the first three is my recollection.
- crosvm, QEMU microvm, Kata and gVisor: no pages fetched; descriptions are from general knowledge.
- Firecracker boot time and memory per VM: only the 125 ms figure repeated in speaker's DESIGN.md and the 128 MiB default; the README I read gives no measurement. No published figures for Cloud Hypervisor or libkrun.
- Docker Sandboxes: whether the tool is open source, and Linux support (sources conflict).
- Whether speaker's `sshfs` delivery for sandboxed agents and its jump server are implemented yet; I read only DESIGN.md.
- Whether the stale `patches/gondolin-0.13.0.patch` (RTC and qboot) comment in `gondolin.ts` reflects current behaviour.
- Nothing here was run. All timings of today's system are the README's own measurements on a Core Ultra 7 265K.

## 9. Sources

- NVIDIA OpenShell: [repo](https://github.com/NVIDIA/OpenShell), [docs overview](https://docs.nvidia.com/openshell/about/overview.md), [architecture](https://docs.nvidia.com/openshell/about/architecture.md), [compute drivers](https://docs.nvidia.com/openshell/v0.0.116/reference/sandbox-compute-drivers.md), [support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix.md), [releases](https://api.github.com/repos/NVIDIA/OpenShell/releases?per_page=3)
- [Fly.io: Sandboxing and workload isolation](https://fly.io/blog/sandboxing-and-workload-isolation/)
- [jai (Stanford SCS)](https://jai.scs.stanford.edu/)
- [Luis Cardoso: Sandboxes for AI](https://www.luiscardoso.dev/blog/sandboxes-for-ai) (not readable)
- Gondolin: [docs](https://earendil-works.github.io/gondolin), [repo metadata](https://api.github.com/repos/earendil-works/gondolin), [releases](https://api.github.com/repos/earendil-works/gondolin/releases?per_page=3)
- Matchlock: [repo](https://github.com/jingkaihe/matchlock), [README](https://raw.githubusercontent.com/jingkaihe/matchlock/main/README.md), [VirtusLab article](https://virtuslab.com/blog/ai/matchlock-your-agents-bulletproof-cage/), [releases](https://api.github.com/repos/jingkaihe/matchlock/releases?per_page=2)
- Re-read on 2026-11-11 from cloned source trees (read only): [microsandbox](https://github.com/microsandbox/microsandbox) `f9ae8e2`, [smolvm](https://github.com/smol-machines/smolvm) `f9e93d8`, [smol SDK](https://github.com/smol-machines/smol), [BoxLite](https://github.com/boxlite-ai/boxlite) `6435328`, [Matchlock](https://github.com/jingkaihe/matchlock) `14ad97d`; file-level links are in 3.3. Maintenance figures: repository and releases API pages for each (contributor counts from the first 100 listed by the API).
- microsandbox: [repo](https://github.com/microsandbox/microsandbox), [docs](https://docs.microsandbox.dev), [secrets doc](https://cdn.jsdelivr.net/gh/zerocore-ai/microsandbox@main/docs/sandboxes/secrets.mdx), [docs index](https://docsearch.algolia.com/mcp/docs/repo/superradcompany/microsandbox), [releases](https://api.github.com/repos/microsandbox/microsandbox/releases?per_page=3)
- smolvm: [repo](https://github.com/smol-machines/smolvm), [varlock write-up](https://varlock.dev/sandboxes/smolvm/)
- BoxLite: [architecture](https://docs.boxlite.ai/architecture)
- Arrakis: [repo](https://github.com/abshkbh/arrakis); e2b: [repo](https://github.com/e2b-dev/infra)
- Firecracker: [README](https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/README.md), [releases](https://api.github.com/repos/firecracker-microvm/firecracker/releases?per_page=2)
- Cloud Hypervisor: [README](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/README.md), [releases](https://api.github.com/repos/cloud-hypervisor/cloud-hypervisor/releases?per_page=2)
- libkrun: [README](https://raw.githubusercontent.com/containers/libkrun/main/README.md), [releases](https://api.github.com/repos/containers/libkrun/releases?per_page=2)
- Apple: [Containerization](https://github.com/apple/containerization)
- Docker: [Sandboxes docs](https://docs.docker.com/ai/sandboxes/get-started.md)
- Local: `bottle-school/README.md`, `src/gondolin.ts`, `tasks.ts`, `leases.ts`, `pi.ts`, `server.ts`, `cli.ts`, `guest/`, `patches/`, `doctor.sh`, `krun-runner.sh`, `speaker/DESIGN.md`
