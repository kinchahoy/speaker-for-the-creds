# speaker-for-the-creds

_human-drafted_

*Speaker-for-the-creds* evolved out of my need to be able to give powerful access to my agents without giving them permanent always available access and to be able to ensure that the keys they have access to don't accidentally end up stored in places I'm not monitoring. This is especially difficult because I work a great deal with local open models, whose behaviors around access change greatly from model to model. 

At a high level speaker-for-the-creds makes it easy for agents to work with me to get timebound, finegrained permissions to my homelab (e.g. read rights to my obsidian notes, permission to modify my home assistant dashboards, personal databases etc.), external services (Github, billed MCPs etc.), browser access (i.e. safe one-off browser usage) as well as SSH or SFTP (limited to specific folders) access to my devices. It's designed to work well with the surfaces I care about: iOS, Tailscale and Herdr.

The basic trick is keeping true credentials in the speaker process (encrypted at rest, decrypted only in memory) and swapping credentials while proxying efficiently (simple service proxy for normal endpoints, TLS proxy for gh etc., SSH jump proxy for SSH & SFTP).

Speaker works closely with *Bottle-school* (battle-school but bottled agents get it? yeah not my finest naming moment) - which is a sandbox optimized to run local agents for personal tasks, with the ability to control what external services (including web access) and pi extensions the agent can access. I focused a fair bit on ensuring Qwen 3.8 27B agents can actually successfully obtain and use credentials meaningfully in token efficient ways.

Core design principles:
- Agents should not actually ever get true credentials that are an exfiltration risk (unless absolutely necessary)
- Agents should be able to token efficiently use granted endpoints like they normally would (i.e. I don't want every API called wrapped in MCP overhead)
- Smaller open models should get enough information when things go wrong to understand how to use the speaker endpoint correctly and efficiently
- Permission requests should be managable by me with a UI that I find usable! I really don't want to be overloaded by unintelligible requests

Types of permissions this project handles well:
- Arbitrary API endpoints in a token efficient way (including but not limited to MCPs)
- HTTPS services (git, gh etc.)
- SSH and SFTP access
- Protecting web access (for bottled agents)
- Reasonably safe management of "the agent really needs a logged in browser" workflow 
- One time transfer of secrets like wifi passwords (no real protection there)

What this project hasn't solved yet:
- Full OAuth intermediation
- Wierd prompt injection risks / concerns

_AI-drafted (based on my evolving guidence)_

AI agents are useful in proportion to what they can touch, and dangerous in the exact same proportion. Give an agent an Obsidian vault, Home Assistant, a GitHub token, and SSH keys, and it can finally do real work. It can also leak or misuse every one of those keys the moment a prompt goes sideways.

`speaker-for-the-creds` splits the problem in two. **speaker** is a small, hardened service that holds every real API key, token, SSH login, and browser session in an encrypted vault unlocked only in memory. Agents never see a real credential. Instead they ask for what they need, the owner approves a card for a set time, and speaker injects the real credential into each request on the way out. **bottle** is a companion that runs agents in throwaway micro-VMs with no network card, so speaker's grants are the only doors they have.

The point is not to make agents safe with prompt rules—prompt rules fail whenever an agent reads untrusted input. The point is to enforce real OS and network boundaries: zero ambient authority, just-in-time approval, short lifetimes, one-click revocation, and a log of everything that crossed the boundary.

One honest limit: speaker keeps raw credentials out of the agent and bounds *when* and *where* it may act, not *what* it chooses to do inside an active grant. Mixing untrusted web input with private reads or write access still leaves prompt-injection and data-exfiltration risks open. This project does not defend against that; keep sensitive grants narrow, short, and away from public web egress.

## Try it in two minutes

_AI-drafted_

Speaker ships with a built-in `demo` service (no real keys needed; reads are open, writes need approval). From the repository root, with [mise](https://mise.jdx.dev):

```sh
mise trust && mise install
mise run init speaker      # choose a password; let it start speaker
```

Open the `PUBLIC_URL` it printed, add `/admin`, and sign in. Then act as an agent from the same machine:

```sh
export SPEAKER_URL=http://localhost:3000   # the address init printed
curl -s $SPEAKER_URL/_speaker/enroll.sh | sh -s -- "try the demo" "curl on this machine"
H=@"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header"
curl -s -H "$H" $SPEAKER_URL/demo/check            # open read: "credential":"accepted"
curl -s -H "$H" -H 'Speaker-Wait: 60' --max-time 70 -d '{}' $SPEAKER_URL/demo/note
```

The write pauses; a card appears immediately in `/admin`. Approve it and the call finishes. Revoke the grant and the next write fails again. Any real agent with `curl` does the same after reading `$SPEAKER_URL/_speaker/help`.

_Owner's overview goes here._

## What works today

_AI-drafted_

| Outcome | State | Notes |
| --- | --- | --- |
| Approve, deny, extend, or revoke an agent's access in real time | Done | `/admin` (SSE live updates), plus the Herdr mod. |
| Approve from a phone | Done | `/admin` installs as an iOS Home Screen PWA with Web Push alerts. |
| Approve from the terminal | Done | The Herdr mod (`herdr/mods/speaker`): docked bar, instant toasts, inbox, agent list, launch. |
| Start a sandboxed agent from a template | Done | `sealed`, `builder`, `trusted`, and `cron` templates; groups approved on one card. |
| Use an API or MCP server without seeing its key | Done | Anthropic, OpenAI, Obsidian, Home Assistant, remote MCP; read and write are separate. |
| Use a token (such as GitHub's) without seeing it | Done | Speaker's proxy swaps a placeholder for the real token only for allowed hosts. |
| Run SSH commands or mount a folder, scoped and revocable | Done | Through speaker's SSH/SFTP boundary. |
| Use a website the owner logged in to by hand | Done | Browser sites: headless Chromium as a separate OS user, live sign-in view, allowlisted commands. |
| Ask for more access mid-task | Done | The agent waits or gets notified when the owner decides. |
| Cap what an agent can spend | Partial | Model-request and runtime limits; no token or dollar budget yet. |
| Review what an agent did | Partial | Activity log and per-agent counts; no export yet. |

Ready for supervised use on a private network. Not yet battle-tested for long unattended runs. Check real upstream URLs, TLS, private routing, and the approval flow before relying on it.

## How it works

_AI-drafted_

1. **Secrets stay out of the agent.** Keys sit encrypted at rest (`store.json`), unlock in memory when the owner signs in, and are inserted into requests by speaker.
2. **The owner grants everything.** Every grant expires on a timer or ends immediately on revoke; a speaker restart drops active grants and locks the vault.
3. **Two layers of enforcement.** Speaker checks every proxied call; bottle enforces network and VM grants on the host side of a networkless micro-VM.
4. **Everything is logged.** Calls, SSH commands, file operations, and decisions go to an append-only audit log—never keys or request bodies.
5. **Nothing to install for agents.** Standard `curl`, `git`, `ssh`, `scp`, `sftp`, and MCP clients work out of the box.

The parts: [speaker](speaker/README.md) holds the keys, renders `/admin`, proxies APIs/tokens/SSH/browsers, and manages grants (its security model is at the end of its README). [bottle](bottle/README.md) runs the Pi coding agent inside [microsandbox](https://github.com/superradcompany/microsandbox) micro-VMs. An optional Herdr mod (`herdr/mods/speaker`) puts the live inbox in the owner's terminal.

## Getting started

_AI-drafted_

Needs Linux or macOS with `mise`, Docker (to build the guest image), `setsid` (macOS: `brew install util-linux`), and `/dev/kvm` on Linux. Optional: `sshd` on SSH targets, `sshfs` for mounting folders from direct agents.

```sh
mise trust && mise install
mise run init              # both on this machine; or `init speaker` / `init bottle` separately
```

`init` installs both packages, asks only what it needs, offers to start each service, and can run a smoke-test agent. Scripts can pass `--yes` and flags (`mise run init speaker -- --help`, `mise run init bottle -- --help`).

Then:

1. Open `PUBLIC_URL/admin` and sign in. Speaker stays locked until the owner signs in after each restart. (On iOS Safari over HTTPS, use **Share → Add to Home Screen**, then enable push notifications under **Setup → Owner security**.)
2. In **Setup**, add services, secrets, SSH targets, shares, and browser sites.
3. **Direct agent:** give it `SPEAKER_URL` and tell it to read `$SPEAKER_URL/_speaker/help`.
4. **Sandboxed agent:** `mise run bottle run "<prompt>"` (attaches to Pi; `Ctrl-\` detaches; `-d` runs detached).
5. **Stop:** `mise run bottle stop <id>` archives the agent. `bottle` stops itself 10 minutes after its last agent, or immediately with `mise run bottle down`.

## Where configuration lives

_AI-drafted_

| What | Where | Holds |
| --- | --- | --- |
| How speaker runs | `speaker/.env` (from `speaker/.env.example`) | Ports, `PUBLIC_URL`, `DATA_DIR`, `TRUSTED_PROXY`, browser broker |
| What speaker offers | `/admin` Setup | Services, groups, secrets, SSH targets/shares, browser sites (`DATA_DIR/store.json` encrypted; `DATA_DIR/config.json` plain, hot-reloaded) |
| bottle | `~/.bottle/config.json` (from `bottle/config.example.json`) | Host, ports, speaker's URL, models, launch templates |
| Extensions and in-VM MCPs | `bottle/catalog.json` | Must match the guest image built from `bottle/guest/` |
| Guest tools | `bottle/guest/locally-available-tools.md` | One line per tool installed in the guest image |
| Herdr mod (optional) | Mod Settings in Herdr | Speaker's URL, bottle's control URL, bottle's machine |

## Commands

_AI-drafted_

| Command | Purpose |
| --- | --- |
| `mise run init [speaker \| bottle]` | Guided setup |
| `mise run install` / `install:locked` / `lock` | Install newest releases / install lockfile / update lockfile |
| `mise run check` / `test` / `format` | Typecheck, lint, format-check; run tests; format |
| `mise run speaker` / `speaker:up` | Run speaker locally / in its hardened container |
| `mise run bottle run ["<prompt>"] [-d] [-t template] [-m model] [-f path[:rw]]` | Launch a sandboxed agent |
| `mise run bottle ls` / `attach [<id>]` / `stop [<id>]` | List, join, or stop and archive agents |
| `mise run bottle templates [--json]` | List templates and models |
| `mise run bottle serve` / `down` / `register` / `build bottle-guest` | Run, stop, register, or build the guest image |
| `mise run bottle:logs` | Follow bottle's log |

Once on `PATH` (see [bottle's README](bottle/README.md#build-and-run)), every `mise run bottle <command>` also runs as `bottle <command>`.

## Future work

_AI-drafted_

- **Standing profiles and remembered hosts.** Keep `store.json` locked on reboot until the owner signs in once, then restore approved hosts and narrow recurring profiles from the decrypted vault.
- **Token usage and telemetry from bottled agents.** Emit standard OpenTelemetry (`gen_ai.*`) token and cost reporting from `bottle`'s model door (compatible with Langfuse, Phoenix, or Grafana), with hard spend caps as a later step.
- **Agent questions on the same push/approval surface.** Surface mid-run questions from unattended agents (`ask_user_question` or checkpoints) through the same `/admin` inbox and iOS Web Push notifications as permission cards.
- **Single-call approvals for high-risk writes.** If a real use case justifies the extra friction, approve one concrete write or diff rather than a time-bounded window.
