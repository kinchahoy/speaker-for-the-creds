<!-- author: ai -->

# Speaker: design

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab services, folders, network access and hosts without ever holding the owner's keys. Agents ask; the owner approves from a phone, for a chosen time; speaker makes the call, relays the session, or tells a sandbox what to allow, and can cut any of it off.

## Principles

1. **The owner grants everything.** No agent, rule or timer creates or lengthens access on its own. Only the owner approves, extends and revokes. The one exception the owner chooses deliberately: services whose reads are marked open.
2. **Agents never hold the owner's keys.** Speaker adds the real credential itself. A leaked agent token is narrow, short-lived and bound to one address.
3. **Ask for the minimum.** Agents ask for exactly what the task needs, with a one-sentence reason. Groups exist to make review easy, not to widen access.
4. **One call should be enough.** If access is missing, the agent's call waits for the owner and then succeeds. Every failure says what to do next.
5. **Speaker does the controlling.** Limits are enforced by speaker (or by the sandbox host), not by special configuration on each target machine.
6. **Nothing to install for agents.** Plain `curl`, `ssh`, `scp`, `sftp` and, where present, `sshfs`.
7. **Brutally simple state.** Only durable settings and encrypted keys are written to disk. Agents, grants and requests live in memory; after a restart, agents ask again.

## Names

| Name | What it is |
| --- | --- |
| **Owner** | The person who runs speaker and decides every request. |
| **Agent** | Anything holding a speaker token that asks for access: Claude Code on a workstation, or Pi inside one sandbox task. |
| **Direct agent** | An agent that enrolled itself. |
| **Sandboxed agent** | An agent created by a sandbox host for one task. It may also ask for items only a sandbox host can enforce. |
| **Sandbox host** | A trusted service (bottle-school) the owner registers once. It starts sandboxes, creates one agent per task, and enforces that task's sandbox grants inside the VM. |
| **Service** | An HTTP API speaker holds a key for (Obsidian, Karakeep, Home Assistant). |
| **Target** | A host speaker can open SSH sessions to, as one limited account on that host. |
| **Share** | A named folder on a target (or on a sandbox host) that agents can be given, read-only or read-write. |
| **Item** | One thing that can be granted, written as a string. |
| **Group** | A named, owner-defined set of items with a one-line description. |
| **Request** | One agent asking for items and groups, with a reason and a duration. One card for the owner. |
| **Grant** | One approved item for one agent, until a time. The owner can extend or revoke it. |

### Items

| Item | Grants | Who may ask |
| --- | --- | --- |
| `<service>.read` | GET, HEAD, OPTIONS to a service (for MCP services: listing and read-only tools) | any agent |
| `<service>.full` | read plus every other method or tool call | any agent |
| `ssh:<target>` | running commands on that target as its agent account | any agent |
| `folder:<share>` / `folder:<share>:rw` | the share, read-only unless the agent asks for `:rw`; delivered as a VM mount or over SSH (see below) | any agent |
| `site:<host>` or `site:*.<domain>` | network access from the sandbox | sandboxed |
| `secret:<NAME>` | a secret the sandbox host injects into requests to the hosts the owner bound to it in Setup | sandboxed |
| `mcp:<id>` | an MCP server from the sandbox host's catalog | sandboxed |
| `ext:<id>` | a Pi extension from the sandbox host's catalog | sandboxed |
| `group:<name>` | every item in that group | any agent, for groups it may use in full |

`secret:` is the one place a real secret reaches a sandbox. The owner decides once, in Setup, which hosts each secret may be sent to (for example `GITHUB_TOKEN` to `api.github.com` and `github.com`); agents cannot choose the destination. Visiting other sites is a separate `site:` item and is unaffected.

Direct agents have their own network access, so `site:`, `secret:`, `mcp:` and `ext:` exist only for sandboxed agents.

### Service rules

Each service has a rule for read and one for write:

- **ask** (default): each agent needs a grant.
- **never**: never granted; requests are answered `denied`.
- **open** (read only): any agent may read without a grant or a card. Open services are not listed to agents; an agent uses one only when the owner has told it the name. Enrollment is open to anyone who can reach speaker, so open means readable by anyone on the owner's network through speaker: meant for harmless state such as whether the lights are on.

## Lifecycles

**Request:** `pending` → `decided`, or `expired` if not decided within 2 hours. A decided request records `granted` or `denied` per item.

**Grant:** `active` → `expired` at its end time, or `revoked` by the owner. The owner can extend an active grant by one more span of its original length. A later approval of the same item for the same agent replaces the earlier grant. Ending a grant immediately ends any session or mount it allowed.

**Agent:** an agent exists from enrollment. It can do nothing except read open services until the owner grants it something. Denying items denies only those items. An agent stays valid while it has an active grant or has made a call in the last 7 days. A sandboxed agent ends when its task ends. **Revoke agent** ends its token and all its grants at once.

**Sandbox host:** registers once, the owner approves it, and it stays until removed.

**Restart:** speaker starts locked (see Keys). Agents, grants and requests are gone; agents enroll and ask again, and open sessions and mounts end.

## Durations

Agents may name a duration; the default is **2h**. Choices: `30m`, `1h`, `2h`, `1d`, `30d`, and (owner only) until revoked. Every grant also ends when speaker restarts. The card preselects what the agent asked for; the owner can change it.

## How an agent works

### Setup (direct agents, once)

`/help` tells the agent, in a few plain steps for sh and for PowerShell, to create a random token, store it only in a user-only header file (`Authorization: Bearer …`), and enroll with the token's SHA-256, its identity, and its first request. It then calls with `curl -H @<header file>` (`curl.exe` in PowerShell), which keeps the token off command lines. No script is served or run.

Identity fields, as the agent is told to fill them:

- `label`: the task in at most 8 words, as the user would say it. Example: `Update the PrimeX homelab notes`.
- `agent`: `<model> · <app> on <machine>`. Example: `Opus 5.5 · Claude Code on PrimeX`. `unknown` for any part it does not know.
- `reason` (every request): one sentence on why the task needs this now.

Speaker adds the source address and a token fingerprint to the card itself. The source address is the only verified fact about where an agent runs; `label` and `agent` are the agent's claims and are shown as such.

### Calling a service

`<method> $SPEAKER_URL/<service>/<path>` with the header file. Speaker checks the rule and grants, adds the real credential, and forwards the call.

### Waiting for the owner

There is one way to wait: the `Speaker-Wait: <seconds>` header (at most 120) on any call, with curl's `--max-time` a little above it. On a service call without access, speaker files a request (or joins the agent's pending one; `Speaker-Reason: <one sentence>` gives the reason), holds the call until the owner decides or the time passes, then forwards it or answers with what to do next. On `POST /_speaker/requests` and on enrollment it holds the reply until the decision. Repeating a call later joins the same pending request. Any reverse proxy in front of speaker must allow requests this long (many default to 60 seconds).

### Requesting access

`POST /_speaker/requests` with `{"want":["group:developer","site:example.org"],"reason":"…","duration":"2h"}`. SSH and folder requests also carry one throwaway public key per such item (`"sshKeys":{"ssh:nas":"ssh-ed25519 …"}`). Target and share names come only from the owner's instructions (the task prompt or the conversation); speaker never lists them. The agent is told:

> Ask for the minimum the task needs. If you need three or more items from one group, ask for the group: it is one decision for the owner. Otherwise ask for exactly those items (`site:google.com`), even when a larger group contains them.

The decision comes back per item: `{"granted":[…],"denied":[…],"expiresAt":"…"}`. The agent works with what was granted and does not ask again for what was denied. A request for a target or share that does not exist, or cannot be delivered to that agent, is answered `denied` at once and recorded in the Log (so the owner can spot a typo such as `nass`); it never becomes a card. The owner approves exactly the items shown on the card when tapping Approve; anything an agent adds to a pending request afterwards stays pending.

### Using SSH and folders over SSH

Speaker runs an SSH jump server (stock OpenSSH, in speaker's container). It listens only while at least one SSH or folder grant is active, on one unusual port chosen at install. `/me` gives the agent the complete command line, including `-o IdentitiesOnly=yes -o BatchMode=yes` and the server's pinned host key, so nothing prompts or hangs. Each grant has its own throwaway key, so the key alone identifies agent, grant and target.

- **Commands** (`ssh:<target>`): `ssh … s@<speaker> '<command>'`; for anything multi-line, `ssh … s@<speaker> 'sh -s' <<'EOF'`. No interactive terminal: every action is one command, so nothing secret is ever typed into a session. Speaker runs the command on the target as its agent account, exactly as given, and returns the output.
- **Files** (`folder:<share>`): `scp -P <port> -i <key> <file> s@<speaker>:<path>`, `sftp`, or `sshfs -p <port> -o IdentityFile=<key> s@<speaker>: <mountpoint>`. Paths are relative to the share. Commands, `rsync` and legacy `scp -O` are refused on folder grants with a message to use `sftp`. When a grant ends, an `sshfs` mount stops working; the message gives the unmount command.

### Knowing where it stands

`GET /_speaker/me` returns the agent's status, the services it may use with read and write state and end times, its own SSH and folder grants with the exact commands to use, the groups it may ask for (with description and items; `ssh:` and `folder:` members appear only as a count, such as "1 folder"), and its requests with per-item outcomes.

### Errors

Every error is JSON with `error`, and where useful `next` and `tell_user`. `next` is the exact call to make (including re-enrolling, or repeating the call with `Speaker-Wait`) or an instruction to stop; `tell_user` is one line with the approval link. 401 responses also carry `WWW-Authenticate: Bearer realm="speaker"` and `Link: </skill.md>; rel="help"`.

Error codes: `locked` (speaker waits for the owner to sign in), `enroll` (unknown, expired or wrongly placed token: run setup again; the cause is not disclosed), `approval_required`, `denied` (with `retry_after` only after three denials), `invalid` (malformed input; lists the accepted values), `rate_limited`.

### Denials

Each denied item is reported as `denied`, and the agent is told to stop. If the same agent asks for an item again anyway, the owner sees it again, up to three denials. After the third, speaker answers `denied` with `retry_after` 15 minutes later and does not ask the owner until then; the count then starts over. Agents are not told that asking again is possible.

## SSH and shares: how speaker controls them

### Targets

The owner adds a target in Setup: an alias, host name, port, the account speaker uses there, and the target's pinned host key. Speaker shows its own public key and the one line to add on the target:

```
from="<speaker's address>",restrict ssh-ed25519 AAAA… speaker
```

That line goes into the `authorized_keys` of the account speaker should use. A dedicated, limited account (for example `agent`: not root, no passwordless sudo) is recommended; the owner's everyday account works too, at the cost of granting everything that account can do. When a target is added, speaker connects once to pin the host key and checks the account: it refuses `root` unless the owner confirms, and warns when `sudo -n true` succeeds (passwordless sudo). The account is shown on every SSH and folder card. This is the only configuration a target needs: no CA, no `sshd_config` change, nothing installed. `from=` makes the key useless from anywhere but speaker; `restrict` refuses forwarding.

### Speaker's SSH key

Speaker generates one SSH key for all targets. It is stored encrypted with the other keys and exists in clear only in memory, inside `ssh-agent`, after the owner unlocks speaker. Revoking it everywhere means deleting one line per target.

### The jump server and relay

- Speaker writes, in memory-backed storage, one `authorized_keys` line per active grant: `restrict,from="<agent's address>",command="relay <grant>",expiry-time="<end>" <agent's throwaway key>`. The agent never gets a shell on speaker. The jump server's own host key is generated at each start.
- `relay` runs the system `ssh` client to the target with the agent's exact command, without a local shell, authenticating through a stock `ssh-agent` that holds speaker's key in memory. It keeps a connection open to speaker for the session.
- At the grant's end, on revoke, or when speaker restarts, speaker closes that connection, `relay` ends the session, and the grant's line is removed. `expiry-time` stops new logins even if speaker stalls.

### Folder limits over SSH

For `folder:` grants, `relay` reads each file-transfer operation (`sftp`, `scp`, `sshfs` all use SFTP) and enforces the share itself:

- every path is resolved by the target and must stay inside the share;
- creating symlinks and hard links is refused;
- read-only grants refuse every write, delete, rename and permission change, and the target's own `sftp-server` is started read-only (`-R`) in the share (`-d`), so stock OpenSSH enforces it too;
- unknown operations are refused;
- every file operation is logged with its path.

Limits: commands are not folder-limited (they run as the target's agent account), and a change made by another process on the target between speaker's check and the operation could still escape the share. The card warns when a share is a home directory.

### How a folder grant reaches the agent

Each share lists how it may be delivered: **VM mount** (by a sandbox host that has the folder locally), **over SSH** (through speaker), or both. The agent asks only for `folder:<share>`; speaker picks the delivery:

- a sandboxed agent whose sandbox host has the share, where the share allows VM mounts, gets a VM mount (fast, enforced by the VM boundary);
- every other agent, including every direct agent, gets it over SSH, if the share allows that; otherwise the item is answered like a denial.

The card, `/me` and the Active list label each folder grant **VM mount** or **over SSH**, so the owner always sees which one is in use. Over SSH, a sandboxed agent mounts the share with `sshfs`, which needs FUSE in the sandbox. `sshfs` is much slower than a VM mount for metadata-heavy work (`grep -r`, `find`, `git status` over many small files), because each file operation is a network round trip through speaker; reading or writing individual files is fine.

### What is logged

For every SSH session: grant, agent, key fingerprint, source address, target, the exact command (or each file operation), start, end, exit code and why it ended.

## Keys and unlocking

All secrets (service keys, secrets for sandboxes, and speaker's SSH key) are encrypted with one random data key (AES-256-GCM). The data key is wrapped with a key derived from the owner's sign-in password (scrypt); a successful unwrap is also the password check, so no separate password hash is stored.

- Speaker starts **locked**. It sends a push "speaker restarted: sign in to unlock"; signing in to `/admin` unwraps the data key, and secrets exist in clear only in memory. While locked, agents get `locked` with a `tell_user` line.
- Changing the password re-wraps the data key. A forgotten password means re-entering the service keys and re-adding speaker's key on targets; nothing else is lost.
- A copied disk or backup reveals no secret. A takeover of the running process can, which is why grants stay short and target accounts limited.

## The owner's side (`/admin`)

**Sign-in:** a login form with the owner's password (rate limited, session cookie). Plain HTTP works, for example on a single laptop; the sign-in page notes when the password is about to cross the network unencrypted. Network identity (for example a tailnet login) is never accepted as the owner: agents on the owner's machines share it.

- **Inbox:** pending requests as cards. A card shows label, agent string, source address and token fingerprint, the reason, and a duration picker. Each group is one row (name, description, item count, expandable); items outside any group are listed separately and highlighted; folder items show the share, read-only or read-write, and VM mount or over SSH; items that can change things (`<service>.full`, `folder:…:rw`, `ssh:`) have a slightly different card colour. Every group, member and item has a checkbox, ticked by default; **Approve** grants what is ticked and denies the rest. A card warns when the same agent string enrolled shortly before.
- **Active:** grants and agents, each with time left, **Extend** (labelled with the amount, such as "Extend 1h": one more span of its original length) and **Revoke**; open SSH sessions with **End**.
- **Setup:** services (URL, key, read and write rules, notes for agents), secrets with their allowed hosts, targets, shares, groups, sandbox hosts.
- **Log:** recent forwarded calls, SSH sessions and file operations, decisions, and requests for unknown names, filterable by agent, grant, service, target or share. It is an in-memory buffer; standard output is the full record.

New requests and the locked state go to the owner's phone as a push notification that carries only a link to the card.

## Sandbox hosts

A sandbox host registers with a name and the item kinds it can enforce; the owner approves it once. For each task it creates a sandboxed agent, with the same identity fields a direct agent sends (`label` from the task prompt or template, `agent` as `<model> · Pi on <sandbox host>`, and a `reason` on its first request), and receives that agent's token. Speaker adds the sandbox host and task id, which it knows from the host's authenticated channel, and binds the token to the sandbox host's address, so a token leaked from a VM works nowhere else. It holds a WebSocket to speaker, receives every grant and revocation for its agents as they happen, applies them inside the VM, and reports which grants are in force. If that connection is lost for 30 seconds, the sandbox host drops its agents' grants until it reconnects. A task template names what the task starts with as a `want` list and a `label`; that becomes the task's first request.

## Discovery and instructions

- `GET /` and `GET /skill.md`: the core instructions (a few lines: what speaker is, the call form, `Speaker-Wait`, follow `next`, where `/help` is). Browsers get a three-line page.
- `GET /_speaker/help`: one page with setup (sh and PowerShell), asking and groups, SSH and folders, and sandbox notes.
- `GET /_speaker/help/<service>`: that service's notes plus the caller's current state.

Services, rules and groups stay behind authentication. Targets and shares are never listed to agents at all, not even to approved ones: an agent knows only the names the owner gives it and the grants it holds.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /`, `GET /skill.md` | anyone | core instructions |
| `GET /_speaker/help[/<service>]` | anyone (service state needs a token) | full instructions, service notes |
| `POST /_speaker/agents` | anyone, rate limited | enroll a direct agent with its first request |
| `GET /_speaker/me` | agent | everything about the caller |
| `POST /_speaker/requests` | agent, sandbox host for its agents | request items and groups |
| `* /<service>/<path>` | agent | forwarded call, with optional `Speaker-Wait` |
| SSH on one unusual port | agent with an SSH or folder grant | commands and file transfer, relayed |
| `POST /_speaker/hosts` | anyone, rate limited | register a sandbox host |
| `GET /_speaker/hosts/ws` | sandbox host | live grants for its agents |
| `POST /_speaker/hosts/agents`, `DELETE /_speaker/hosts/agents/<id>` | sandbox host | create and end a task's agent |
| `GET /_speaker/health` | anyone | liveness |
| `/admin/...` | owner | HTML forms only |

## Deployment

One container, running as a non-root user with a read-only root filesystem, no added capabilities and no privilege escalation, image pinned by digest. Settings: the public URL, optionally a push topic and `TRUSTED_PROXY`. Everything else (owner password, services, targets, shares, groups) is set in `/admin` on first run.

Placement:

- **Default:** a published port on the LAN.
- **Single laptop:** run it locally; agents on the same machine use `http://localhost`.
- **Optional:** a compose profile with a Tailscale sidecar that serves speaker on the tailnet with HTTPS (with `TRUSTED_PROXY=127.0.0.1`, kernel networking so the relay reaches tailnet targets, and the SSH port exposed).
- **Behind an existing reverse proxy:** set `TRUSTED_PROXY` to the proxy's address.

## Security model

- **Agent tokens** are random, stored by speaker only as SHA-256 hashes, kept by agents in a user-only header file, and bound to the address they enrolled from. That address is the socket address; when the connection comes from `TRUSTED_PROXY`, it is the last `X-Forwarded-For` entry, the one that proxy appended. `X-Forwarded-For` from any other sender is ignored.
- **Enrollment** is unauthenticated but rate limited (20 per 15 minutes in total). It refuses malformed hashes and the hash of an empty token; enrolling again with the same token returns the existing agent.
- **Approval** happens only in `/admin`, behind the owner's sign-in, with same-origin checks on every change. Card details supplied by the agent (label, agent string, reason) are shown as claims; the source address and fingerprint are speaker's own.
- **Upstream calls** do not follow redirects; a key embedded in an upstream URL is redacted from replies and logs.
- **Limits of the model:** speaker cannot stop an agent from misusing access it was granted, and a takeover of the running speaker exposes every unlocked key. Hence short grants, least-privilege upstream tokens and limited target accounts, everything logged, and one-click revoke.

## Data

On disk, in speaker's data volume: settings (services with rules and notes, secrets' allowed hosts, targets with pinned host keys, shares, groups, sandbox hosts) and the encrypted keys with their wrapped data key. In memory only: agents, grants, requests, SSH sessions, usage counters. The log goes to standard output, for Docker's log handling.

## Alternative to explore: a slimmer VM if every folder goes over SSH

Sandbox folders are delivered as VM mounts today because the VM runtime provides a shared-filesystem device. If every folder instead reached sandboxes over SSH (`sshfs` through speaker), the VM would need no shared-filesystem device at all, which opens up slimmer and faster runtimes:

- **Firecracker:** the smallest device model of the common options (network, block, vsock; no shared-filesystem device at all, so only usable with folders over SSH), with boot to user space in about 125 ms per its documentation, and a jailer process for extra isolation. Linux with KVM only.
- **Cloud Hypervisor:** a little larger, also KVM-only; useful if a shared-filesystem device is still wanted for some folders.
- **libkrun:** small, and runs on both Linux and macOS (Hypervisor.framework), so the same sandbox works on a Mac.

What still has to be provided outside the VM, whichever runtime is chosen:

- the egress allowlist (`site:`) and secret injection (`secret:`): the VM's only network route goes through a host-side proxy that enforces them;
- FUSE and `sshfs` in the guest image, and delivery of `mcp:` and `ext:` items.

Trade-off: every folder becomes slower for metadata-heavy work (each file operation is a network round trip through speaker), in exchange for one folder mechanism for every agent, live revoke of folders, and a free choice of VM runtime. To decide, benchmark against the current runtime: boot time, memory per VM, and `grep -r`, `find` and `git status` on a realistic share.

## Alternative to explore: one WebSocket instead of most routes

Instead of separate HTTP routes, the `Speaker-Wait` hold and an SSH port, each agent could keep one WebSocket connection to speaker and exchange messages over it: requests, decisions pushed the moment the owner taps, revocations, and SSH traffic tunnelled through the same connection.

For:

- no waiting or polling: decisions and revocations arrive as they happen;
- one port for everything, including SSH (a sandbox image can carry a small tunnel; on direct agents, `ssh -o ProxyCommand='node -e "…"'` could bridge SSH over WebSocket using Node's built-in WebSocket client, where Node exists);
- far fewer routes and error cases.

Against:

- agents run one short process per tool call, so a lasting connection needs a helper process running in the background, which is close to installing something;
- `curl` support for WebSocket is recent and not universal, and weak agents handle a stateful connection worse than one request and one reply;
- reverse proxies need WebSocket upgrades enabled, and debugging by hand gets harder.

Where it fits best: sandboxes, where the sandbox host already holds a WebSocket to speaker and can carry its agents' traffic. A likely path is WebSocket through the sandbox host first, HTTP for direct agents, and revisiting direct agents once the sandbox path proves out.
