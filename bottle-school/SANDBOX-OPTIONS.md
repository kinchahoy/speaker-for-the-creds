<!-- author: ai -->

# Sandbox options for bottle-school: alternatives to Gondolin

<sub>AI-written</sub>

Written 2026-11-11 against bottle-school at commit 946f6f3. Research only: nothing was built or run, and every claim about an outside project comes from the pages linked at the end. Where I could not confirm something I say so, and section 8 lists all of it in one place.

## 1. Summary and recommendation

**What the owner asked for.** No patches against a sandbox runtime. Something simpler and better. "Minimal fast microvms abound."

**What the research found.**

- The VM runtimes themselves (Firecracker, Cloud Hypervisor, libkrun) are small, well maintained and need no patching. What Gondolin adds on top is a programmable network stack, a virtual filesystem and an exec protocol. Those are the parts bottle-school patches (`patches/@earendil-works__gondolin@0.14.0.patch`) or works around (`guest/boot-assets.mjs`, `krun-runner.sh`, `ShareRouter` in `src/gondolin.ts`).
- Almost everything bottle-school needs from that layer can live outside the VM, in code bottle-school owns and that speaks only standard protocols: an HTTP proxy on the host, SSH, and a vsock socket.
- No project I found is a drop-in replacement. The closest (Matchlock, microsandbox, smolvm) are young, move fast, and none documents the one unusual thing bottle-school needs: sending requests for secret hosts through speaker's proxy without holding the secret.
- Boot time will not improve much. Today's 0.95 s median (README, QEMU) is mostly Ubuntu user space starting, not the hypervisor. Firecracker's headline 125 ms is for a minimal guest.

**Primary path.** A plain microVM with no network card. The guest's only doors are vsock sockets to a small host-side gateway owned by bottle-school: an allow-list egress proxy that chains secret hosts to speaker's proxy, a model gateway that records and counts model requests, and a status channel. Folders arrive over `sshfs` through speaker (speaker's DESIGN.md already describes this). Exec and attach use SSH over vsock. Start on **Firecracker** (Linux, KVM) and keep the contract (kernel, ext4 disks, vsock) VMM-neutral so libkrun or Apple's framework can be added for macOS later. Before committing, run a short trial of **Matchlock** to see whether it already provides the launcher and exec pieces, which would shrink the code to own.

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
- Glue: a thin C or Rust launcher is needed, or use a wrapper below. Does Design B on both Linux and macOS with one VMM. TSI does not enforce egress, so use vsock-only.
- I did not look at `krunvm` or `muvm` individually beyond their being libkrun front ends.

**crosvm, QEMU microvm, Kata, gVisor.** I did not fetch pages for these this session; the notes are from general knowledge and should be re-checked.

- crosvm: Chrome OS's Rust VMM, Linux only, virtio-fs and vsock; no versioned releases that I know of, built from source. Firecracker or Cloud Hypervisor fit better.
- QEMU `microvm` machine (what Gondolin uses today): ubiquitous and runs on macOS, but a large C codebase; Fly's article calls C hypervisors a larger attack surface. Good as an emergency backend because it boots the same rootfs.
- Kata Containers: runs OCI containers in microVMs (Firecracker, Cloud Hypervisor, QEMU) and expects containerd or Kubernetes. Far heavier than needed for one host. Fly cites a roughly 75% boot-time reduction for Kata's lightweight VM work ([Fly.io](https://fly.io/blog/sandboxing-and-workload-isolation/)).
- gVisor: a user-space kernel in Go. Not a hardware boundary; Fly cites a "low double-digit" performance cost that worsens under I/O. Linux only, no VM. It would be a weaker-isolation fallback, not a microVM.

### 3.3 Sandbox products

**Matchlock** ([repo](https://github.com/jingkaihe/matchlock)). The closest match to Design B out of the box.

- What: Go CLI and SDK for disposable microVMs. Host side runs a policy engine, a transparent HTTP/TLS proxy and a filesystem server; guest talks to host over vsock port 5000.
- Linux backend: VirtusLab says Firecracker ([blog](https://virtuslab.com/blog/ai/matchlock-your-agents-bulletproof-cage/)); the README I read says only "KVM" and does not mention Firecracker. Conflict, unresolved. macOS: Virtualization.framework, with gVisor's user-space TCP/IP used when allow lists or secrets are active.
- Egress and secrets: `--allow-host` and `--secret NAME@host`; placeholder in the guest, real value swapped by the host proxy; allow list can be edited on a running VM with `matchlock allow-list add/delete` (needs `--network-intercept`).
- Folders: the README says host-directory mounts are not supported ("Host directories are never shared with the guest"), so folders would be `sshfs`, which is what Design B wants anyway. VirtusLab describes a FUSE-over-vsock workspace that the README contradicts; I trust the README.
- Exec: `matchlock exec <vm>` including `-it`; Go SDK `ExecInteractive`. Image build via BuildKit.
- Maturity: MIT, 652 stars, v0.3.1 released 2026-10-31 ([releases](https://api.github.com/repos/jingkaihe/matchlock/releases?per_page=2)); describes itself as experimental with breaking changes. The VirtusLab article counted 2 contributors at v0.1.6. No documented resource flags, no documented per-request upstream choice, and its own secret handling holds the real value in the host process, so it would need the same speaker hop that Gondolin needs.
- Verdict: worth a one-day trial as the launcher and exec layer; too young and too thinly staffed to be the only bet.

**microsandbox** ([repo](https://github.com/microsandbox/microsandbox), now also under `superradcompany`).

- libkrun based; Apache-2.0; about 9.0k stars, v0.7.14 on 2026-11-08, previous release a week earlier ([releases](https://api.github.com/repos/microsandbox/microsandbox/releases?per_page=3)). Self-described beta: "Expect breaking changes."
- Embeddable library with TypeScript, Rust, Python, Go SDKs. Linux (KVM) and macOS (Apple silicon). OCI images directly, which removes the kernel-and-initramfs reshaping bottle-school does now. Average guest boot under 100 ms on an M1 (their claim; for a small image).
- Network: own user-space stack with host allow lists, TLS interception and placeholder secrets; headers and Basic auth by default ([secrets doc](https://cdn.jsdelivr.net/gh/zerocore-ai/microsandbox@main/docs/sandboxes/secrets.mdx)). The doc does not say whether upstream traffic can be sent through another proxy. Whether the network policy can change live: not specified. Read-only mounts: not specified.
- Verdict: the closest like-for-like replacement for Gondolin, but it has the same shape (programmable network stack inside the runtime), so the same patch question reappears. Fast-moving API means chasing breaking releases.

**smolvm** ([repo](https://github.com/smol-machines/smolvm)). libkrun; Apache-2.0; about 7.1k stars; boot "under 200 ms to agent ready" (its claim). `smolvm machine update` changes allow lists on a running machine. Host folder mounts. A `--credential` placeholder option. Linux, macOS Apple silicon, Windows. Release version not shown. One independent write-up found that with its default networking (TSI) egress rules are not enforced, and that the enforcing network mode could not be combined with a host-side proxy in 1.7.1 ([varlock](https://varlock.dev/sandboxes/smolvm/)). That is the opposite of what bottle-school needs; hold.

**BoxLite** ([docs](https://docs.boxlite.ai/architecture)). "SQLite for sandboxing": embeddable libkrun runtime, Apache-2.0, SDKs for Python, Node, Rust, Go; jailer with seccomp on Linux and sandbox-exec on macOS. About 451 stars when indexed and about a month old then; crate versions 0.7.4 and 0.8.0. I did not read its network or secret features. Too young to base a security boundary on without more reading.

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
| Design B on libkrun | microVM | both | not stated | v1.19.8 2026-11-06 | owned | yes | sshfs | as above, plus a small launcher |
| Matchlock | microVM (Firecracker per one source) | both | MIT | v0.3.1 2026-10-31; 652 stars; very small team | yes, live CLI | unknown; holds real secret | none by design (use sshfs) | image, glue, a speaker hop to be proven |
| microsandbox | libkrun | both | Apache-2.0 | v0.7.14 2026-11-08; 9.0k stars; beta | yes (live: unspecified) | unknown | host dirs | likely the same patch problem |
| smolvm | libkrun | both | Apache-2.0 | 7.1k stars; release unseen | allow list updatable; enforcement mode conflicts with host proxy | unknown | host dirs | uncertain |
| BoxLite | libkrun | both | Apache-2.0 | young; 0.8.0 crate | not read | not read | not read | unknown |
| OpenShell | container or libkrun VM | both (macOS via Docker) | Apache-2.0 | v0.1.8 2026-11-10; 21.5k stars | yes | its own, overlaps speaker | policy-based | a second policy plane |
| e2b infra | Firecracker | Linux | Apache-2.0 | active | n/a | n/a | n/a | far too large |
| Arrakis | Cloud Hypervisor | Linux | AGPL-3.0 | no releases seen | none documented | none | none | licence blocker |
| Apple Containerization | VZ VM | macOS 26 only (Linux secondary) | Apache-2.0 | 0.1.x | none | none | virtiofs | macOS leg only |
| gVisor / Kata / jai | user-space kernel / VM via containerd / namespaces | Linux | not checked / not checked / not stated | not checked | via netns, owned | owned | bind mounts | weaker boundary or too heavy |

## 4. Step 1 revisited: what moves where

| Capability | Design B answer |
|---|---|
| VM boot from image | Docker build kept; export rootfs to ext4 (`mke2fs -d`); stock Firecracker CI kernel or the Alpine `linux-virt` kernel already used (virtio_blk and ext4 built in or an initramfs; to be decided in the spike). The 372-line `rootfs-init.sh` and `boot-assets.mjs` go; a short init replaces them. |
| Exec and attach | SSH over vsock (key on config disk). |
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
| Krun, QEMU, macOS | Deferred: contract is VMM-neutral. |

## 5. Step 3: decision

### Primary: Design B on Firecracker, with a Matchlock trial first

Reasons:

- It deletes every patch and every dependency on another project's internal files. What remains talks to Firecracker's documented API, SSH, and an HTTP proxy.
- It matches speaker's own conclusion in DESIGN.md: "one folder mechanism for every agent, live revoke of folders, and a free choice of VM runtime".
- The no-network-card guest is a stronger and simpler boundary than a filtered NIC: there is no route to police, and each VM's socket identifies the task.
- The secret hop needs no TLS interception by bottle-school, so bottle-school never touches the secret exchange at all.
- Every part (proxy, SSH, ext4, vsock) has several replacements, so no single young project can strand it.

Honest cost: this is not less code than today. Rough count of what is replaced: about 1,200 lines (`gondolin.ts` 439, patch 220, `rootfs-init.sh` 372, `boot-assets.mjs` 127, `krun-runner.sh` 38) against a new launcher, gateway and short init that I would expect in the same range. The gain is the kind of code, not the amount: nothing that must be re-derived when a dependency changes.

If the Matchlock trial shows its launcher, exec and image build work with a no-NIC or gateway-only network, adopt it for those parts and own only the gateway. If it does not, the Firecracker launcher is a few hundred lines.

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

1. **Spike (days).** Run the checks in the next section; decide Firecracker versus Matchlock-as-launcher versus fall back.
2. **Gateway first, on today's runtime.** Build the host gateway as a standalone process and test it against the existing Gondolin guest using proxy settings, replacing `secretRoute` and the capture hooks. This removes the patch while keeping everything else, and is a safe stopping point (it is also the fallback's strongest form).
3. **Folders.** Switch folders to `sshfs` through speaker; retire `ShareRouter` and the VM-mount item reporting; update speaker's share report.
4. **New VM layer.** Add the Firecracker launcher, rootfs and config disk builder, short guest init, SSH exec and attach; move `/work` and `/output` to a per-task disk; change archiving to read it.
5. **Cut over.** Run both for a while, then remove Gondolin, the patch, `boot-assets.mjs`, `krun-runner.sh`, the Krun checks in `doctor.sh`, and `PI_V2_VMM`.
6. **Later, optional.** macOS leg via libkrun or Apple Containerization using the same disks and vsock contract.

## 6. What must be verified by a spike before committing

1. Firecracker boots the Ubuntu rootfs on the owner's CPU under the service account (only `/dev/kvm` access, no jailer); measure time to first SSH command and memory per VM against Gondolin's 0.95 s.
2. Pi, `gh`, `git`, `curl`, `uv`/`pip` and Playwright work through the proxy only (env variables or guest redirect). Include `NODE_USE_ENV_PROXY=1` on the Node version Pi ships with.
3. The CONNECT chain to speaker's proxy: `git clone` of a large repo and `gh pr create` end to end with the placeholder; revoke returns 403 at once; the guest trusts speaker's CA in every client.
4. `sshfs` against speaker's jump server: `grep -r`, `find`, `git status` on a realistic share, compared with the current sandboxfs numbers (README: 75-157 MB/s throughput); behaviour at grant expiry.
5. `attach` experience: PTY, resize, detach with `dtach`, reconnect, from the CLI and inside herdr.
6. Artifact retrieval: `ssh tar` while running and `debugfs rdump` on a stopped disk; crash recovery of a half-written work disk.
7. Whether Node's `fetch` honours a plain-HTTP `model.internal` base URL and streaming responses through the gateway without buffering (the model replies are streamed and reassembled for the trace).
8. Matchlock trial: Linux backend actually Firecracker or not, resource flags, vsock-only networking, SDK hooks, behaviour under a 24-hour `loop` task.
9. Whether speaker's agent API can be reached over plain HTTP from the gateway and whether its token binding (bound to the sandbox host's address) works when the gateway is the caller.

## 7. Things the owner should decide

- Is macOS a real requirement for bottle-school, or only for the owner's own machine? That decides whether libkrun, not Firecracker, should be the first VMM.
- Is slower folder metadata over `sshfs` acceptable for the usual shares, or are there repositories that must be fast? If the latter, keep a VM-mount path (Cloud Hypervisor with virtiofsd, or Gondolin).

## 8. What I could not verify

- Luis Cardoso's essay (HTTP 429 on two attempts). I did not use it.
- OpenShell: how its egress proxy handles TLS, what its CLI attach path is, which database the gateway uses, and whether the microVM driver is ready for daily use. The docs I read did not say.
- microsandbox: whether upstream traffic can be chained to another proxy, whether network policy changes live, whether mounts can be read-only. The pages I read did not say. Its secrets are handled inside its own host process.
- Matchlock: whether Linux uses Firecracker (sources conflict); resource limits; release cadence beyond the two releases seen; contributor count today.
- smolvm and BoxLite: release numbers, and BoxLite's network and secret features.
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
