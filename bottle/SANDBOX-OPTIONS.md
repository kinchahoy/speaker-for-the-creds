<!-- author: ai -->

# Sandbox runtime: decision record

<sub>AI-written</sub>

**Decision.** bottle runs each agent in a [microsandbox](https://github.com/superradcompany/microsandbox) VM (libkrun, from the `microsandbox` npm package) with no network device. The guest's only doors are vsock ports bridged to host unix sockets owned by bottle: an allow-list egress proxy that chains secret hosts to speaker's proxy, a model gateway that records and counts model requests, the speaker door, and a status channel. Folders arrive over `sshfs` through speaker's jump server.
{.ai}

**What was compared (2026-11-11).** The previous runtime, Gondolin (as is, or with its patches upstreamed); a bottle-owned gateway on Firecracker, Cloud Hypervisor, libkrun directly, or microsandbox as the launcher; and the sandbox products microsandbox (as a full sandbox), smolvm, BoxLite, Matchlock, OpenShell, e2b infra, Arrakis, Apple Containerization, and gVisor / Kata / jai. No project replaces the whole sandbox layer, because none sends chosen hosts to speaker's proxy without holding the secret itself.
{.ai}

**Why microsandbox.** It is the only candidate that provides, in one in-process Node library on Linux and macOS, a no-network-device mode, guest vsock to host unix socket routes, exec with PTY attach, and CPU, memory and disk limits. smolvm has the same capabilities, but socket mounts and attach are not in its Node SDK; BoxLite and Matchlock lack a host door for a guest without a NIC. The design needs no patches and no TLS interception by bottle, and a guest with no network card is a simpler boundary than a filtered one. A Linux trial of microsandbox 0.7.14 (no root, no daemon, only `/dev/kvm`) passed: first command at about 0.28 s with the image cached, no route out of the guest, vsock round trips with `socat`, exec and `attachShell()`, resource limits, and `sshfs` over vsock through a stock `sshd`.
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

**Later: pre-warmed snapshots (idea, 2026-11-15).** A launch takes a few seconds: the VM boots in about 2 s, then Pi loads from a cold guest disk (it runs as `node-MainThread` until loaded). microsandbox 0.7.15 can restore a full snapshot (memory included) with `Sandbox.restore()`, rebinding host folders, and can copy a running VM with `fork()`; `cowMemory()` lets restored VMs share unchanged memory pages (an idle agent holds about 410 MiB today).
{.ai}

Order the boot so Pi is warm before anything agent-specific arrives:
{.ai}

1. Snapshot once per guest image: boot, guest setup (doors, `/etc/hosts`), then start a generic Pi with the always-on extensions and let it load. The snapshot then holds Pi's loaded code and a warm page cache.
2. Per agent: restore with `cowMemory()`, rebinding `/work`, `/output`, `/etc/bottle` and launch folders to the agent's own, and the vsock door sockets to its own.
3. Write the agent's config (model, system note, prompt, opt-in extensions as `-e`) and restart Pi. Pi reads these only at start, so a restart is needed, but it loads from the warm cache in well under a second. Opt-in extensions add their own load time.
4. Things Pi never reads at start come last and need no restart: the SSH key and `sshfs` shares (mounted as grants arrive, as today), the speaker CA for tools, and grants (the doors read them live).
{.ai}

Open points: Pi's process environment carries the agent's token variables, so they would move to a file Pi's extensions read, or come with the restart in step 3. Estimated at a few hundred lines on a young API. Worth it if launches still feel slow, or memory limits how many agents run at once.
{.ai}

