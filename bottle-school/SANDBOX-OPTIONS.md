<!-- author: ai -->

# Sandbox runtime: decision record

<sub>AI-written</sub>

**Decision.** bottle-school runs each task in a [microsandbox](https://github.com/superradcompany/microsandbox) VM (libkrun, from the `microsandbox` npm package) with no network device. The guest's only doors are vsock ports bridged to host unix sockets owned by bottle-school: an allow-list egress proxy that chains secret hosts to speaker's proxy, a model gateway that records and counts model requests, the speaker door, and a status channel. Folders arrive over `sshfs` through speaker's jump server.
{.ai}

**What was compared (2026-11-11).** The previous runtime, Gondolin (as is, or with its patches upstreamed); a bottle-school-owned gateway on Firecracker, Cloud Hypervisor, libkrun directly, or microsandbox as the launcher; and the sandbox products microsandbox (as a full sandbox), smolvm, BoxLite, Matchlock, OpenShell, e2b infra, Arrakis, Apple Containerization, and gVisor / Kata / jai. No project replaces the whole sandbox layer, because none sends chosen hosts to speaker's proxy without holding the secret itself.
{.ai}

**Why microsandbox.** It is the only candidate that provides, in one in-process Node library on Linux and macOS, a no-network-device mode, guest vsock to host unix socket routes, exec with PTY attach, and CPU, memory and disk limits. smolvm has the same capabilities, but socket mounts and attach are not in its Node SDK; BoxLite and Matchlock lack a host door for a guest without a NIC. The design needs no patches and no TLS interception by bottle-school, and a guest with no network card is a simpler boundary than a filtered one. A Linux trial of microsandbox 0.7.14 (no root, no daemon, only `/dev/kvm`) passed: first command at about 0.28 s with the image cached, no route out of the guest, vsock round trips with `socat`, exec and `attachShell()`, resource limits, and `sshfs` over vsock through a stock `sshd`.
{.ai}

**Why Gondolin was dropped.** It needed a local patch (`httpHooks.upstreamDispatcher` plus body-capture hooks, about 220 lines) for the secret route, a rewritten init, reshaped boot assets, a locally built Krun runner for CPUs without AVX-512, and a custom filesystem class for shares, all tied to the internals of a project that calls itself "an early project". The last state with Gondolin is the git tag `pre-gondolin-removal`.
{.ai}

**Known limits.**
{.ai}

- Folders over `sshfs` are much slower than a VM mount for `grep -r`, `find` and `git status` over many files.
- Without TLS termination, `trace.jsonl` holds bodies only for model calls, and there are no path-level rules for third-party HTTPS hosts.
- Every client in the guest must honour the proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`) and trust speaker's proxy CA for secret hosts.
- microsandbox refuses a storage folder that other accounts could write; its storage must be mode 700.
- The egress gateway is a high-value host process and needs the same care as speaker's proxy.
- Not yet verified: macOS (entitlements and FUSE in the guest kernel), `sshfs` throughput over vsock, many concurrent VMs, terminal resize.
