<!-- author: ai -->

# Speaker: design

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab services, folders, network access and hosts without ever holding the owner's keys. Agents ask; the owner approves from a phone, for a chosen time; speaker makes the call, relays the session, or tells a sandbox what to allow, and can cut any of it off.

## Principles

1. **The owner grants everything.** No agent, rule or timer creates or lengthens access on its own. Only the owner approves, extends and revokes.
2. **Agents never hold the owner's keys.** Speaker adds the real credential itself. A leaked agent token is narrow, short-lived and bound to one address.
3. **Ask for the minimum.** Agents ask for exactly what the task needs, with a one-sentence reason. Groups exist to make review easy, not to widen access.
4. **One call should be enough.** If access is missing, the agent's call waits for the owner and then succeeds. Every failure says what to do next.
5. **Speaker does the controlling.** Limits are enforced by speaker (or by the sandbox host), not by special configuration on each target machine.
6. **Nothing to install for agents.** Plain `curl`, `ssh`, `scp`, `sftp` and, where present, `sshfs`.
7. **Brutally simple state.** Only durable settings and encrypted keys are written to disk. Agents, grants and asks live in memory; after a restart, agents ask again.

## Names

| Name | What it is |
| --- | --- |
| **Owner** | The person who runs speaker and decides every ask. |
| **Agent** | Anything holding a speaker token that asks for access: Claude Code on a workstation, or Pi inside one sandbox task. |
| **Direct agent** | An agent that enrolled itself. |
| **Sandboxed agent** | An agent created by a sandbox host for one task. It may also ask for items only a sandbox host can enforce. |
| **Sandbox host** | A trusted service (bottle-school) the owner registers once. It starts sandboxes, creates one agent per task, and enforces that task's sandbox grants inside the VM. |
| **Service** | An HTTP API speaker holds a key for (Obsidian, Karakeep, Home Assistant). |
| **Target** | A host speaker can open SSH sessions to, as one limited account on that host. |
| **Share** | A named folder on a target (or on a sandbox host) that agents can be given, read-only or read-write. |
| **Item** | One thing that can be granted, written as a string. |
| **Group** | A named, owner-defined set of items with a one-line description. |
| **Ask** | One request from one agent: items and groups, a reason, a duration. One card for the owner. |
| **Grant** | One approved item for one agent, until a time. The owner can extend or revoke it. |

### Items

| Item | Grants | Who may ask |
| --- | --- | --- |
| `<service>.read` | GET, HEAD, OPTIONS to a service (for MCP services: listing and read-only tools) | any agent |
| `<service>.write` | every other method or tool call | any agent |
| `ssh:<target>` | running commands on that target as its agent account | any agent |
| `folder:<share>` / `folder:<share>:rw` | the share, read-only or read-write: a VM mount for sandboxed agents whose sandbox host has the share, otherwise file transfer and `sshfs` through speaker | any agent |
| `site:<host>` or `site:*.<domain>` | network access from the sandbox | sandboxed |
| `secret:<NAME>@<host>[,<host>]` | a secret the sandbox host injects into requests to those hosts only | sandboxed |
| `mcp:<id>` | an MCP server from the sandbox host's catalog | sandboxed |
| `ext:<id>` | a Pi extension from the sandbox host's catalog | sandboxed |
| `group:<name>` | every item in that group | any agent, for groups it may use in full |

`secret:` is the one place a real secret reaches a sandbox; the sandbox host injects it only into requests to the named hosts.

### Service rules

Each service has a rule for read and one for write: **open** (an agent the owner has granted anything uses it without a card), **ask** (each agent needs a grant), or **blocked** (never granted; agents are told not to ask).

## Lifecycles

**Ask:** `pending` → `decided`, or `expired` if not decided within 2 hours. A decided ask records `granted` or `denied` per item.

**Grant:** `active` → `expired` at its end time, or `revoked` by the owner. The owner can extend an active grant by one more span of its original length. A later approval of the same item for the same agent replaces the earlier grant. Ending a grant immediately ends any session or mount it allowed.

**Agent:** an agent exists from enrollment. It can do nothing until the owner grants it something; having a grant is what "approved" means, and it is what unlocks open services. Denying items denies only those items. An agent stays valid while it has an active grant or has made a call in the last 7 days. A sandboxed agent ends when its task ends. **Revoke agent** ends its token and all its grants at once.

**Sandbox host:** registers once, the owner approves it, and it stays until removed.

**Restart:** speaker starts locked (see Keys). Agents, grants and asks are gone; agents enroll and ask again, and open sessions and mounts end.

## Durations

Agents may name a duration; the default is **2h**. Choices: `15m`, `1h`, `2h`, `1d`, `30d`, and (owner only) until revoked. The card preselects what the agent asked for; the owner can change it.

## How an agent works

### Setup (direct agents, once)

The agent runs a short sh or PowerShell block from `/help`. It creates a random token, stores it only in a user-only header file (`Authorization: Bearer …`), and enrolls with the token's SHA-256, its identity, and its first ask. It then calls with `curl -H @<header file>`, which keeps the token off command lines.

Identity fields, as the agent is told to fill them:

- `label`: the task in at most 8 words, as the user would say it. Example: `Update the PrimeX homelab notes`.
- `agent`: `<model> · <app> on <machine>`. Example: `Opus 5.5 · Claude Code on PrimeX`. `unknown` for any part it does not know.
- `reason` (every ask): one sentence on why the task needs this now.

Speaker adds the source address and a token fingerprint to the card itself.

### Calling a service

`<method> $SPEAKER_URL/<service>/<path>` with the header file. Speaker checks the rule and grants, adds the real credential, and forwards the call.

Without access, the agent repeats the call with `Speaker-Wait: 60` and `Speaker-Reason: <one sentence>`. Speaker files an ask (or joins the agent's pending one), holds the call until the owner decides or 60 seconds pass, then forwards it or answers with what to do next. Repeating the call later joins the same pending ask.

### Asking

`POST /_speaker/asks` with `{"want":["group:developer","site:example.org"],"reason":"…","duration":"2h"}`. SSH and folder asks over SSH also carry the agent's throwaway public key (`"sshKey":"ssh-ed25519 …"`). The agent is told:

> Ask for the minimum the task needs. If a group fits the task closely, i.e. you need most of its items, ask for the group: it is one decision for the owner. If you need one or two things, ask for exactly those items (`site:google.com`), even when a larger group contains them. Never ask for a group to cover a single item, and never list a group's items one by one.

The decision comes back per item: `{"granted":[…],"denied":[…],"expiresAt":"…"}`. The agent works with what was granted and does not ask again for what was denied.

### Using SSH and folders over SSH

Speaker runs an SSH jump server (stock OpenSSH, in speaker's container). It listens only while at least one SSH or folder grant is active, on a port chosen at random from a configured range; `/me` gives the agent the exact command and the server's host key. Each grant has its own throwaway key, so the key alone identifies agent, grant and target.

- **Commands** (`ssh:<target>`): `ssh -p <port> -i <key> s@<speaker> '<command>'`. No interactive terminal: every action is one command, so nothing secret is ever typed into a session. Speaker runs the command on the target as its agent account, exactly as given, and returns the output.
- **Files** (`folder:<share>`): `scp -P <port> -i <key> <file> s@<speaker>:<path>`, `sftp`, or `sshfs -p <port> -o IdentityFile=<key> s@<speaker>: <mountpoint>`. Paths are relative to the share. Commands, `rsync` and legacy `scp -O` are refused on folder grants.

### Knowing where it stands

`GET /_speaker/me` returns the agent's status, the services it may use with read and write state and end times, its SSH and folder grants with the exact commands to use, the groups it may ask for (with description and items), and its asks with per-item outcomes. `?wait=60` holds the reply until something the agent waits on is decided.

### Errors

Every error is JSON with `error`, and where useful `next` and `tell_user`. `next` is either `GET /_speaker/me?wait=60` or an instruction to stop; `tell_user` is one line with the approval link. 401 responses also carry `WWW-Authenticate: Bearer realm="speaker"` and `Link: </skill.md>; rel="help"`.

Error codes: `locked`, `unknown_token`, `expired`, `source_mismatch`, `approval_required`, `denied` (with `retry_after` when applicable), `blocked`, `not_configured`, `rate_limited`.

### Denials

Each denied item is reported as `denied`, and the agent is told to stop. If the same agent asks for an item again anyway, the owner sees it again, up to three denials. After the third, speaker answers `denied` with `retry_after` 15 minutes later and does not ask the owner until then; the count then starts over. Agents are not told that asking again is possible.

## SSH and shares: how speaker controls them

### Targets

The owner adds a target in Setup: an alias, host name, port, the account speaker uses there, and the target's pinned host key. Speaker shows its own public key and the one line to add on the target:

```
from="<speaker's address>",restrict ssh-ed25519 AAAA… speaker
```

That line goes into the `authorized_keys` of a dedicated, limited account (for example `agent`: not root, no passwordless sudo). This is the only configuration a target needs: no CA, no `sshd_config` change, nothing installed. `from=` makes the key useless from anywhere but speaker; `restrict` refuses forwarding.

### Speaker's SSH key

Speaker generates one SSH key for all targets. It is stored encrypted with the other keys and exists in clear only in memory after the owner unlocks speaker. Revoking it everywhere means deleting one line per target.

### The jump server and relay

- Speaker writes, in memory-backed storage, one `authorized_keys` line per active grant: `restrict,command="relay <grant>",expiry-time="<end>" <agent's throwaway key>`. The agent never gets a shell on speaker.
- `relay` runs the system `ssh` client to the target with speaker's key and the agent's exact command, without a local shell. It keeps a connection open to speaker for the session.
- At the grant's end, on revoke, or when speaker restarts, speaker closes that connection, `relay` ends the session, and the grant's line is removed. `expiry-time` stops new logins even if speaker stalls.

### Folder limits over SSH

For `folder:` grants, `relay` reads each file-transfer operation (`sftp`, `scp`, `sshfs` all use SFTP) and enforces the share itself:

- every path is resolved by the target and must stay inside the share;
- creating symlinks and hard links is refused;
- read-only grants refuse every write, delete, rename and permission change;
- unknown operations are refused;
- every file operation is logged with its path.

Limits: commands are not folder-limited (they run as the target's agent account), and a change made by another process on the target between speaker's check and the operation could still escape the share. The card warns when a share is a home directory.

### Folder grants inside sandboxes

When a sandboxed agent's sandbox host has the share locally, the sandbox host mounts it into the VM (fast, enforced by the VM boundary). Otherwise the agent mounts it with `sshfs` through speaker, which needs FUSE in the sandbox. `sshfs` is much slower than a VM mount for metadata-heavy work (`grep -r`, `find`, `git status` over many small files), because each file operation is a network round trip through speaker; reading or writing individual files is fine.

### What is logged

For every SSH session: grant, agent, key fingerprint, source address, target, the exact command (or each file operation), start, end, exit code and why it ended.

## Keys and unlocking

All secrets (service keys and speaker's SSH key) are encrypted with one random data key (AES-256-GCM). The data key is wrapped with a key derived from the owner's sign-in password (scrypt).

- Speaker starts **locked**. It sends a push "speaker restarted: sign in to unlock"; signing in to `/admin` unwraps the data key, and secrets exist in clear only in memory. While locked, agents get `locked` with a `tell_user` line.
- Changing the password re-wraps the data key. A forgotten password means re-entering the service keys and re-adding speaker's key on targets; nothing else is lost.
- A copied disk or backup reveals no secret. A takeover of the running process can, which is why grants stay short and target accounts limited.

## The owner's side (`/admin`)

**Sign-in:** a login form with the owner's password (hashed, rate limited, session cookie). An optional passkey adds a second factor and is required for Setup changes and "until revoked" grants. Network identity (for example a tailnet login) is never accepted as the owner: agents on the owner's machines share it.

- **Inbox:** pending asks as cards. A card shows label, agent string, source address and token fingerprint, the reason, and a duration picker. Each group is one row (name, description, item count, expandable); items outside any group are listed separately and highlighted; folder items show the share and read-only or read-write. Every group, member and item has a checkbox, ticked by default; **Approve** grants what is ticked and denies the rest. A card warns when the same agent string enrolled shortly before.
- **Active:** grants and agents, each with time left, **Extend** (+1× its original span) and **Revoke**; open SSH sessions with **End**.
- **Setup:** services (URL, key, read and write rules, notes for agents), targets, shares, groups, sandbox hosts.
- **Log:** forwarded calls, SSH sessions and file operations, and decisions, filterable by agent, grant, service, target or share.

New asks and the locked state go to the owner's phone as a push notification that carries only a link to the card.

## Sandbox hosts

A sandbox host registers with a name and the item kinds it can enforce; the owner approves it once. For each task it creates a sandboxed agent and receives that agent's token. It holds a WebSocket to speaker, receives every grant and revocation for its agents as they happen, applies them inside the VM, and reports which grants are in force. A task template names what the task starts with as a `want` list and a `label`; that becomes the task's first ask.

## Discovery and instructions

- `GET /` and `GET /skill.md`: the core instructions (a few lines: what speaker is, the call form, `Speaker-Wait`, follow `next`, where `/help` is). Browsers get a three-line page.
- `GET /_speaker/help`: one page with setup (sh and PowerShell), asking and groups, SSH and folders, and sandbox notes.
- `GET /_speaker/help/<service>`: that service's notes plus the caller's current state.

Services, rules, targets, shares and groups stay behind authentication.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /`, `GET /skill.md` | anyone | core instructions |
| `GET /_speaker/help[/<service>]` | anyone (service state needs a token) | full instructions, service notes |
| `POST /_speaker/agents` | anyone, rate limited | enroll a direct agent with its first ask |
| `GET /_speaker/me[?wait=60]` | agent | everything about the caller |
| `POST /_speaker/asks` | agent, sandbox host for its agents | ask for items and groups |
| `* /<service>/<path>` | agent | forwarded call, with optional `Speaker-Wait` |
| SSH on a random port | agent with an SSH or folder grant | commands and file transfer, relayed |
| `POST /_speaker/hosts` | anyone, rate limited | register a sandbox host |
| `GET /_speaker/hosts/ws` | sandbox host | live grants for its agents |
| `POST /_speaker/hosts/agents`, `DELETE /_speaker/hosts/agents/<id>` | sandbox host | create and end a task's agent |
| `GET /_speaker/health` | anyone | liveness |
| `/admin/...` | owner | HTML forms only |

## Deployment

One container, running as a non-root user with a read-only root filesystem, no added capabilities and no privilege escalation, image pinned by digest. Settings: the public URL, optionally a push topic and `TRUSTED_PROXY`. Everything else (owner password, services, targets, shares, groups) is set in `/admin` on first run.

Placement:

- **Default:** a published port on the LAN.
- **Recommended:** a shipped compose profile with a Tailscale sidecar that serves speaker on the tailnet with HTTPS, so access is limited by tailnet rules and passkeys work.
- **Behind an existing reverse proxy:** set `TRUSTED_PROXY` to the proxy's address.

## Security model

- **Agent tokens** are random, stored by speaker only as SHA-256 hashes, kept by agents in a user-only header file, and bound to the address they enrolled from. That address is the socket address, or the address recorded by `TRUSTED_PROXY` when one is configured; a client-supplied `X-Forwarded-For` is never trusted otherwise.
- **Enrollment** is unauthenticated but rate limited (20 per 15 minutes in total). It refuses malformed hashes and the hash of an empty token; enrolling again with the same token returns the existing agent.
- **Approval** happens only in `/admin`, behind the owner's sign-in, with same-origin checks on every change. Card details supplied by the agent (label, agent string, reason) are shown as claims; the source address and fingerprint are speaker's own.
- **Upstream calls** do not follow redirects; a key embedded in an upstream URL is redacted from replies and logs.
- **Limits of the model:** speaker cannot stop an agent from misusing access it was granted, and a takeover of the running speaker exposes every unlocked key. Hence short grants, least-privilege upstream tokens and limited target accounts, everything logged, and one-click revoke.

## Data

On disk, in speaker's data volume: settings (services with rules and notes, targets with pinned host keys, shares, groups, sandbox hosts, the owner's password hash and optional passkey) and the encrypted keys. In memory only: agents, grants, asks, SSH sessions, usage counters. The log goes to standard output, for Docker's log handling.

## Open decisions

- Whether the internal code, stored files and API adopt these names fully, or only the UI and documentation do.
- `asks` versus `requests` as the API noun.
