<!-- author: ai -->

# Speaker: design

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab services, folders, network access and hosts without ever holding the owner's keys. Agents ask; the owner approves from a phone, for a chosen time; speaker makes the call, relays the session, or tells a sandbox what to allow, and can cut any of it off.

## In plain words

| Item | Means | Example |
| --- | --- | --- |
| `<service>.read` | read from one of your APIs through speaker; speaker adds the key | `obsidian.read`: read notes |
| `<service>.full` | read and change things in that API | `obsidian.full`: write notes |
| `ssh:<target>` | run commands on one of your hosts, as the account you chose for it | `ssh:nas`: `df -h` on the NAS |
| `folder:<share>` | read files in one of your folders (`:rw` to also change them) | `folder:photos` |
| `site:<host>` | let a sandbox reach a website | `site:pypi.org` |
| `secret:<NAME>` | let an agent use one of your tokens on the sites you allowed for it, without seeing the token | `secret:GITHUB_TOKEN`: `gh` and `git` work |
| `mcp:<id>` | start an MCP server inside the sandbox, from the sandbox host's list (remote MCP servers are services) | `mcp:filesystem` |
| `ext:<id>` | switch on a Pi plugin from the sandbox host's list | `ext:pi-web-access`: web search |
| `group:<name>` | a set of the above you defined, approved as one | `group:developer` |

## Principles

1. **The owner grants everything.** No agent, rule or timer creates or lengthens access on its own. Only the owner approves, extends and revokes. The one exception the owner chooses deliberately: services whose reads are marked open.
2. **Agents never hold the owner's keys.** Speaker adds the real credential itself. A leaked agent token is narrow, short-lived and bound to one address.
3. **Ask for the minimum.** Agents ask for exactly what the task needs, with a one-sentence reason. Groups exist to make review easy, not to widen access.
4. **One call should be enough.** If access is missing, the agent's call waits for the owner and then succeeds. Every failure says what to do next.
5. **Speaker does the controlling.** Limits are enforced by speaker (or by the sandbox host), not by special configuration on each target machine.
6. **Nothing to install for agents.** Plain `curl`, `ssh`, `scp`, `sftp` and, where present, `sshfs`.
7. **Brutally simple state.** Only durable settings, encrypted keys and the append-only log are written to disk. Agents, grants and requests live in memory; after a restart, agents ask again.

## Names

| Name | What it is |
| --- | --- |
| **Owner** | The person who runs speaker and decides every request. |
| **Agent** | Anything holding a speaker token that asks for access: Claude Code on a workstation, or Pi inside one sandbox. |
| **Direct agent** | An agent that enrolled itself. |
| **Sandboxed agent** | An agent created by a sandbox host for one run. It may also ask for items only a sandbox host can enforce. |
| **Sandbox host** | A trusted service (bottle) the owner registers once. It starts sandboxes, creates one agent per run, and enforces that run's sandbox grants inside the VM. |
| **Service** | An HTTP API or remote MCP server that agents reach through speaker, usually with a key speaker holds (Obsidian, Karakeep, Home Assistant). |
| **Target** | A host speaker can open SSH sessions to, as one limited account on that host. |
| **Share** | A named folder on a target (or on a sandbox host) that agents can be given, read-only or read-write. |
| **Item** | One thing that can be granted, written as a string. |
| **Group** | A named, owner-defined set of items with a one-line description. |
| **Request** | One agent asking for items and groups, with a reason and a duration. One card for the owner. |
| **Grant** | One approved item for one agent, until a time. The owner can extend or revoke it. |

### Items

| Item | Grants | Who may ask |
| --- | --- | --- |
| `<service>.read` | GET, HEAD, OPTIONS to a service, plus POST to paths the owner marks as reads in Setup (such as a search endpoint); for MCP services, listing and read-only tools | any agent |
| `<service>.full` | read plus every other method or tool call | any agent |
| `ssh:<target>` | running commands on that target as its agent account | any agent |
| `folder:<share>` / `folder:<share>:rw` | the share, read-only unless the agent asks for `:rw`; delivered over SSH (see below) | any agent |
| `site:<host>` or `site:*.<domain>` | network access from the sandbox | sandboxed |
| `secret:<NAME>` | speaker inserts the secret into the agent's requests to the hosts the owner bound to it in Setup (see Secrets) | any agent |
| `mcp:<id>` | an MCP server that runs inside the VM, from the sandbox host's catalog | sandboxed |
| `ext:<id>` | a Pi extension from the sandbox host's catalog | sandboxed |
| `group:<name>` | every item in that group | any agent, for groups it may use in full |

The owner decides once, in Setup, which hosts each secret may be sent to (for example `GITHUB_TOKEN` to `api.github.com` and `github.com`); agents cannot choose the destination, and no agent or sandbox host ever holds the value. Visiting other sites is a separate `site:` item and is unaffected.

Remote MCP servers, with a key or without, are services: every agent reaches them through speaker in the same way. Direct agents have their own network access, so `site:`, `mcp:` (servers inside the VM) and `ext:` exist only for sandboxed agents.

### Service rules

Each service has a rule for read and one for write:

- **ask** (default): each agent needs a grant.
- **never**: never granted; requests are answered `denied`.
- **open** (read only): any agent may read without a grant or a card. Open services are not listed to agents (see What an agent can see). Enrollment is open to anyone who can reach speaker, so open means readable by anyone on the owner's network through speaker: meant for harmless state such as whether the lights are on.

## Lifecycles

**Approval:** everything anyone asks the owner for, of every kind and for an agent or a sandbox host, is one approval with one lifecycle: `pending` → `granted` or `denied`, or created already `open` (an open read) or `denied` when the rules answer without the owner (`never`, unavailable, locked after three denials); a pending approval `expired` when nobody decides in time, or `revoked` when what it asks for goes away; a granted one `expired` at its end, or `revoked`. Extend keeps it `granted`. The table is `approvalTable` in `lifecycle.ts`, and every change goes through its `transition()`.

**Request:** one card: `pending` while any of its approvals is, then `decided`, or `expired` if not decided within 2 hours (a sandbox host's registration waits until the owner decides). Items the rules answer without the owner are approvals created in their final state, so one structure holds every outcome; an `open` one is not a grant.

**Reconcile:** after any Setup change (a service, secret, target or share changed or deleted), every pending or granted approval whose item is no longer available ends (`revoked`, logged as `grant_revoked` with why), and so does a grant whose reach grew beyond what the owner approved: what a kind's card says approving opens (a secret's hosts, a service's URL and read paths, a target's account, a share's path) is kept with the grant.

**Grant:** a grant exists only while it is in force. It ends (and is logged as `grant_expired`) at its end time, or (logged as `grant_revoked`) when the owner revokes it; either way it is gone from speaker's list. The owner can extend an active grant by one more span of its original length. A later approval of the same item for the same agent replaces the earlier grant. Ending a grant immediately ends any session or mount it allowed.

**Agent:** an agent exists from enrollment. It can do nothing except read open services until the owner grants it something. Denying items denies only those items. An agent stays valid while it has an active grant or has made a call in the last 7 days. A sandboxed agent ends when its run ends. If a direct agent's address changes (a laptop on another network), its token stops working and it simply enrolls and asks again. **Revoke agent** ends its token and all its grants at once. The agent stays as a revoked tombstone (with the time) until speaker restarts, so its token keeps answering `denied` instead of `enroll`; an idle agent that is not revoked is removed as above.

**Sandbox host:** registers, the owner approves it, and it stays until removed. Speaker keeps the host record (id, name, kinds, token hash, address, time) on disk but not its approval: after a restart each known host is a pending card again, and the owner re-approves it after signing in. Meanwhile the host's calls answer `approval_required`. bottle counts that as an outage: approved within its outage limit (5 minutes after speaker was reached, 30 seconds at its own startup) it resumes; otherwise it stops and says to approve the host. Registering is unauthenticated and only adds a pending entry (name, kinds, source address, time). Approving it removes any other host with the same name and the same source address (audited `host_replaced`): that is the same machine registering again, its old tokens are unusable, and its agents end with it. A different name or address is kept. The pending card says what approval will replace, and host cards show address, registration time and status.

**Restart:** speaker starts locked (see Keys). Agents, grants and requests are gone, and every known sandbox host waits for approval again; agents enroll and ask again, and open sessions and mounts end.

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

There is one way to wait: the `Speaker-Wait: <seconds>` header (at most 120) on any call, with curl's `--max-time` a little above it. On a service call without access, speaker files a request (or joins the agent's pending one for the same item; `Speaker-Reason: <one sentence>` gives the reason), holds the call until the owner decides or the time passes, then forwards it or answers with what to do next. On `POST /_speaker/requests` and on enrollment it holds the reply until the decision. `GET /_speaker/requests/<id>` holds the same way on a request already filed, so a client can file at once and watch later without ever filing again. Repeating a call later joins the same pending request. Any reverse proxy in front of speaker must allow requests this long (many default to 60 seconds).

### Requesting access

`POST /_speaker/requests` with `{"want":["group:developer","site:example.org"],"reason":"…","duration":"2h"}`. An agent that will use SSH or folders sends one throwaway public key, once (`"sshKey":"ssh-ed25519 …"` on enrollment or with its first request). Groups may contain any items, including `ssh:` and `folder:`. Target and share names come only from the owner's instructions (the task prompt or the conversation); speaker never lists them. The agent is told:

> Ask for the minimum the task needs. If you need three or more items from one group, ask for the group: it is one decision for the owner. Otherwise ask for exactly those items (`site:google.com`), even when a larger group contains them.

The decision comes back per item: `{"granted":[…],"denied":[…],"expiresAt":"…"}`. The agent works with what was granted and does not ask again for what was denied. Every POST is a request of its own, with its own card and its own reply. The one exception is a POST naming exactly the same items (after group expansion) as that agent's pending request: it joins that request, which is how a caller waits by posting again. A name the agent may not ask for fails the whole POST with 400 `invalid`, names the real ones, and creates nothing (see What an agent can see). An item that exists but cannot be delivered to that agent (for example a share not offered over SSH) is answered `denied` at once and recorded in the Log; it never becomes a card. When a request includes `ext:<id>` and the sandbox host's catalog gives that extension `sites`, speaker adds a `site:<host>` item for each to the same request, so the card shows them and one approval covers both. The owner approves exactly the items shown on the card when tapping Approve.

### Using SSH and folders over SSH

Speaker runs an SSH jump server in its container (see The jump server and relay). It listens only while at least one SSH or over-SSH folder grant is active, on one unusual port chosen at install. `/catalog` gives the agent the complete command line, including `-o IdentitiesOnly=yes -o BatchMode=yes` and the server's pinned host key, so nothing prompts or hangs. The login name (`<account>` below) is the account speaker runs as. The agent's key identifies the agent; the target or share is named in the command or path, and speaker checks that the agent holds a grant for it.

- **Commands** (`ssh:<target>`): `ssh … <account>@<speaker> <target> '<command>'`; for anything multi-line, `ssh … <account>@<speaker> <target> 'sh -s' <<'EOF'`. The grant also allows `scp` and `sftp` as that account. No interactive terminal: every action is one command, so nothing secret is ever typed into a session. Speaker runs the command on the target as its agent account, exactly as given, and returns the output.
- **Files** (`folder:<share>`): `scp -P <port> -i <key> <file> <account>@<speaker>:<share>/<path>`, `sftp`, or `sshfs -p <port> -o IdentityFile=<key> <account>@<speaker>:<share> <mountpoint>`. The first part of every path names the share. `/catalog` offers `sshfs` first, so the agent works on the share in place rather than copying files around; `scp` and `sftp` are for a one-off copy. `sshfs` needs FUSE (macFUSE on a Mac). Commands, `rsync` and legacy `scp -O` are refused on folder grants with a message to use `sftp`. When a grant ends, an `sshfs` mount stops working; the message gives the unmount command.

### Knowing where it stands

`GET /_speaker/catalog` returns the agent's status, the services it may ask for with read and write state and end times, its live grants (with `applying` until a sandbox host reports one in force; speaker tracks each grant as `enforced`, `sent` (to a connected sandbox host, not yet reported) or `host-offline` (its host is not connected)), every secret the owner set up (name, hosts, variable, and `state` `granted` or `ask`; the placeholder and setup hints only once granted), the exact commands for its SSH and folder grants, the groups it may ask for, and its requests with per-item outcomes. For a sandboxed agent it also lists `extensions` and `mcp` from its sandbox host's catalog, each with its state. `text` is the same list as plain markdown for a weak model, with one line per item; the `request_capability` tool pastes it into its description, so it names no routes. What it leaves out, and why, is in What an agent can see.

### Errors

Every error is JSON with `error` (a code), `message` (a human sentence), and where useful `next` and `tell_user`. `next` is the exact call to make (including re-enrolling, or repeating the call with `Speaker-Wait`) or an instruction to stop; when it sends the agent to the docs it names a section, for example `read "Folders and SSH" in GET /_speaker/help`; `tell_user` is one line with the approval link. 401 responses also carry `WWW-Authenticate: Bearer realm="speaker"` and `Link: </_speaker/help>; rel="help"`.

Error codes: `locked` (speaker has no owner password yet, or waits for the owner to sign in after a restart; it carries `next` and `tell_user`), `no_key` (a service has no key yet), `upstream_unavailable` (the service did not answer), `enroll` (unknown, expired or wrongly placed token: run setup again; the cause is not disclosed), `approval_required`, `register` (a sandbox host token used from another address), `denied` (with `retry_after` only after three denials), `invalid` (malformed input; lists the accepted values), `not_found` (an unknown route, service or agent), `conflict`, `rate_limited`, `internal_error`. The shape and the codes are defined once, as `errorBody` and `ErrorCode` in `items.ts`; bottle answers its own errors with the same function.

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

- Speaker itself listens on `SSH_PORT` only while an SSH or over-SSH folder grant is active, and hands each connection to a stock, non-root `sshd -i` (inetd mode), so there is no daemon to start or reap. The jump server's own host key is generated at each start.
- Speaker writes, in memory-backed storage, one `authorized_keys` line per agent with an active SSH or folder grant: `restrict,from="<agent's address>",command="relay <agent>",expiry-time="<last grant's end>" <agent's throwaway key>`. The agent never gets a shell on speaker.
- `relay` reads the target (first word of the command) or share (first part of each path), checks the agent's grant for it with speaker, and runs the system `ssh` client to the target with the agent's exact command, without a local shell, authenticating through a stock `ssh-agent` that holds speaker's key in memory. It keeps a connection open to speaker for the session.
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

Folders always arrive over SSH (through speaker). The agent asks only for `folder:<share>`.

The card, `/catalog` and the Active list label each folder grant **over SSH**. A sandboxed agent mounts the share with `sshfs`, which needs FUSE in the sandbox. `sshfs` is slower than a local mount for metadata-heavy work (`grep -r`, `find`, `git status` over many small files), because each file operation is a network round trip through speaker; reading or writing individual files is fine.

### What is logged

For every SSH session: grant, agent, key fingerprint, source address, target, the exact command (or each file operation), start, end, exit code and why it ended.

## Keys and unlocking

All secrets (service keys, secrets for sandboxes, and speaker's SSH key) live in speaker and are encrypted with one random data key (AES-256-GCM). Secret values never leave speaker except inside requests to their allowed hosts (see Secrets). The data key is wrapped with a key derived from the owner's sign-in password (scrypt); a successful unwrap is also the password check, so no separate password hash is stored.

- Speaker starts **locked**; agents are told to ask the owner to sign in. Signing in to `/admin` (or the owner API) unwraps the data key, and secrets exist in clear only in memory. One rule covers the first run too: until the owner has set a password and signed in, agent, sandbox-host, secrets-proxy and proxy-certificate calls are refused (`locked` over HTTP, a refusal line from the proxy).
- Changing the password re-wraps the data key. A forgotten password means re-entering the service keys and re-adding speaker's key on targets; nothing else is lost.
- A copied disk or backup reveals no secret. A takeover of the running process can, which is why grants stay short and target accounts limited.

## The owner's side (`/admin`)

**Sign-in:** a login form with the owner's password (rate limited, session cookie). Plain HTTP works, for example on a single laptop; the sign-in page notes when the password is about to cross the network unencrypted. Network identity (for example a tailnet login) is never accepted as the owner: agents on the owner's machines share it.

The pages use Open Props tokens (`/admin/assets/open-props.css`), a small inline stylesheet (light and dark), Lucide icons (`/admin/assets/icons.svg`, cut from lucide-static to the icons in use) and htmx (`/admin/assets/htmx.js`), all served from their npm packages. Inbox and Active are live panels: they poll every 5 seconds (`/admin/panel/inbox`, `/admin/panel/active`) and are swapped only when their content changed, so ticked boxes stay put. Times are shown in UTC.

- **Inbox:** pending requests as cards, and sandbox hosts waiting for approval. A card shows label, agent string, source address and token fingerprint, the reason, and a duration picker. Each group is one row (name, description, item count, expandable); items outside any group are listed separately and highlighted; folder items show the share, read-only or read-write, and over SSH; items that can change things (`<service>.full`, `folder:…:rw`, `ssh:`) have a slightly different card colour. Every group, member and item has a checkbox, ticked by default; **Approve** grants what is ticked and denies the rest. A card warns when the same agent string enrolled shortly before.
- **Active:** agents with their grants, each with time left, **Extend** (labelled with the amount, such as "Extend 1h": one more span of its original length) and **Revoke**; open SSH sessions with **End**; approved sandbox hosts. Under each agent is one line of counts kept on its in-memory record: requests that reached the owner as cards, items granted, items denied (including those decided without a card), **refused** (the agent's request turned away before the owner saw it: unknown or unavailable names, wrong kinds, a missing `sshKey`, a malformed body) and **blocked** (a call refused for lack of a grant: service calls, the secrets proxy, SSH and folder sessions). Refused and blocked show in the warning colour when non-zero, and the latest such message is the line's hover title. Failures before an agent exists (a bad first enrollment) and failed authentication belong to no agent and are not counted.
- **Setup** (`/admin?section=services`): services (URL, key, read and write rules, notes for agents), secrets with their allowed hosts, groups, SSH targets and shares, and the owner password.
- **Log:** recent forwarded calls, SSH sessions and file operations, decisions, and requests for unknown names, filterable by agent, grant, service, target or share. It is an in-memory buffer; standard output is the full record.

**Owner API** (`/admin/api`, for the Herdr mod): sign in with the password for a bearer token, list pending requests and live grants, approve a card as asked, deny it, revoke a grant. It calls the same decide and revoke functions as the forms. Everything finer stays in the pages.

## Sandbox hosts

A sandbox host registers with a name and the item kinds it can enforce; the owner approves it once. For each run it creates a sandboxed agent, with the same identity fields a direct agent sends (`label` from the task prompt or template, `agent` as `<model> · Pi on <sandbox host>`, and a `reason` on its first request), and receives that agent's token. Speaker adds the sandbox host and run id, which it knows from the host's authenticated channel, and binds the token to the sandbox host's address, so a token leaked from a VM works nowhere else. It holds a WebSocket to speaker, receives every grant and revocation for its agents as they happen, applies them inside the VM, and reports which grants are in force. If that connection is lost for 30 seconds, the sandbox host drops its agents' grants until it reconnects. A task template names what the task starts with as a `want` list and a `label`; that becomes the task's first request.

## Discovery and instructions

- `GET /` and `GET /_speaker/help` serve one document, `skill/SKILL.md`. Its top fits one screen (what speaker is, the call form, how to wait, follow `next`, where things are); sections follow for Set up (sh and PowerShell), What you can ask for, Asking, Folders and SSH, Secrets, Remote MCP servers and Errors. Sandboxed agents get their guidance from the sandbox host's tool instead, which the document points to in one line. Browsers get a three-line page at `/`.
- `GET /_speaker/help/<service>`: that service's notes plus the caller's current state.

### What an agent can see

Anyone who can reach speaker can enroll as an agent, so a list shown to agents is a list shown to anything on the owner's network. Speaker therefore lists only names that reveal little and that an agent needs in order to ask well. Everything else the agent learns only from the owner, its task, or a grant it already holds. Help and service notes need no token; everything in this table does.

| Kind | Direct agent | Sandboxed agent | Where |
| --- | --- | --- | --- |
| Services that need a grant (`ask` or `never`) | listed, with its state | listed, with its state | `/catalog` |
| Services anyone may read (`open`) | not listed; usable if the agent knows the name | same | — |
| Groups the agent may ask for | listed, with description and items | same | `/catalog` |
| Secrets | every secret: name, the variable to set, the hosts it goes to, its state | same | `/catalog` |
| Folders (shares) and SSH targets | not listed; only its own grants, with commands | same | `/catalog` (grants only); inside a group, only a count such as "1 folder" |
| Sites | nothing to list: any hostname may be asked for | same | — |
| In-VM MCP servers and Pi extensions | do not apply | every catalog entry, with its sites | `/catalog`, from the sandbox host's report |

What the table means in practice:

- **Secret names are listed to every agent**, direct ones too. A name reveals little: an agent only ever holds a placeholder, and speaker sends the real value only to the hosts the owner bound it to.
- **Folders and SSH targets stay hidden from every agent.** An agent uses the names its task or the owner gives it.
- **One list, one name.** `GET /_speaker/catalog` is everything the agent may ask for, each entry with the agent's state (granted until a time, `ask`, or `never`), plus its requests. A sandbox host sends its in-VM MCP servers and extensions over its WebSocket as `{"type":"catalog","mcps":[{id,label,tools}],"extensions":[{id,label,description,tools,sites}]}`, kept like its share report and cleared when it disconnects.
- **Unknown names are refused the same way for every kind**: 400 `invalid` with `<name> is not something you can ask for. <Kind> you can ask for: <real names>.`, before anything reaches the owner. Extensions and MCP servers are checked against the host's catalog. For folders and SSH targets there is no list: `There is no folder named <share> that you can use.`

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /` | anyone | core instructions |
| `GET /_speaker/help[/<service>]` | anyone (service state needs a token) | full instructions, service notes |
| `POST /_speaker/agents` | anyone, rate limited | enroll a direct agent with its first request |
| `GET /_speaker/catalog` | agent | everything the caller may ask for and where it stands |
| `POST /_speaker/requests` | agent, sandbox host for its agents | request items and groups |
| `GET /_speaker/requests/<id>` | the request's agent, its sandbox host | one request's outcome, held with `Speaker-Wait`; decided requests are kept for a day |
| `* /<service>/<path>` | agent | forwarded call, with optional `Speaker-Wait` |
| SSH on one unusual port | agent with an SSH or folder grant | commands and file transfer, relayed |
| `POST /_speaker/hosts` | anyone, rate limited | register a sandbox host; the reply carries speaker's `PROXY_PORT` and `SSH_PORT` |
| `GET /_speaker/hosts/ws` | sandbox host | live grants for its agents; the host reports its catalog |
| `GET /_speaker/hosts/self` | sandbox host | `{ id, name, status: "approved" }`; a pending or unknown host token gets the usual `401` (`approval_required`, `enroll` or `register`), an agent token `403` `denied` |
| `POST /_speaker/hosts/agents`, `DELETE /_speaker/hosts/agents/<id>` | sandbox host | create and end a sandboxed agent |
| `GET /_speaker/health` | anyone | liveness |
| `/admin/...` | owner | HTML forms, session cookie |
| `/admin/api/...` | owner | JSON, bearer token only (see Security model) |

## Deployment

One container, running as a non-root user with a read-only root filesystem, no added capabilities and no privilege escalation, image pinned by digest. Settings: the public URL, optionally `TRUSTED_PROXY`, and the required `PROXY_PORT` (the secrets proxy) and `SSH_PORT` (the jump server). Everything else (owner password, services, targets, shares, groups) is set in `/admin` on first run.

Placement:

- **Default:** a published port on the LAN.
- **Single laptop:** run it locally; agents on the same machine use `http://localhost`.
- **Optional:** a compose profile with a Tailscale sidecar that serves speaker on the tailnet with HTTPS (with `TRUSTED_PROXY=127.0.0.1`, kernel networking so the relay reaches tailnet targets, and the SSH port exposed).
- **Behind an existing reverse proxy:** set `TRUSTED_PROXY` to the proxy's address.

## Security model

- **Agent tokens** are random, stored by speaker only as SHA-256 hashes, kept by agents in a user-only header file, and bound to the address they enrolled from. Sandbox host tokens are bound the same way, to the address the host registered from; from anywhere else the host is told to register again. A revoked agent token stays refused, at enrollment too: asking again takes a new token, which reaches the owner as a new agent. That address is the socket address; when the connection comes from `TRUSTED_PROXY`, it is the last `X-Forwarded-For` entry, the one that proxy appended. `X-Forwarded-For` from any other sender is ignored.
- **Enrollment** is unauthenticated but rate limited (20 per 15 minutes in total). It refuses malformed hashes and the hash of an empty token; enrolling again with the same token returns the existing agent.
- **Approval** happens only in `/admin`, behind the owner's sign-in, with same-origin checks on every change. The owner API under `/admin/api` takes only `Authorization: Bearer <token>` from its own sign-in (same password check, rate limit and audit lines). It never accepts the session cookie, and its tokens are never accepted as the cookie, so a browser page cannot ride the owner's session into it and no CSRF surface is added. Its tokens share the in-memory session map and lifetime and die with a restart. The Herdr mod holds its token in memory only; a direct agent running as the owner's user account on the same machine could read the mod's memory or edit its files, the single-machine limit in Rules in detail. Card details supplied by the agent (label, agent string, reason) are shown as claims; the source address and fingerprint are speaker's own.
- **Upstream calls** do not follow redirects; a key embedded in an upstream URL is redacted from replies and logs.
- **Limits of the model:** speaker cannot stop an agent from misusing access it was granted, and a takeover of the running speaker exposes every unlocked key. Hence short grants, least-privilege upstream tokens and limited target accounts, everything logged, and one-click revoke.

## Data

On disk, in speaker's data volume: settings (services with rules and notes, secrets' allowed hosts, targets with pinned host keys, shares, groups, sandbox hosts) and the encrypted keys with their wrapped data key. In memory only: agents, grants, requests, SSH sessions, usage counters. The log goes to standard output, for Docker's log handling.

## Code

`server.ts` composes the parts and starts listening: `engine.ts` (the approval engine: asking, deciding, extending, revoking, expiry, the denial lock, reconcile, cards; it never looks at an item's kind), `core.ts` (schemas, settings, in-memory state, and the registry of kinds: what each item means, through the same small set of functions for every kind), `api.ts` (agent and sandbox-host API, service proxy), `catalog.ts` (what `/catalog` shows an agent), `admin.ts` (owner pages and forms), `ui.ts` (page templates), `proxy.ts` (secrets proxy), `jump.ts` (targets, shares, `ssh-agent`, the jump server), `relay.ts` (the forced command) with `sftp.ts` (folder limits), `store.ts` (encrypted keys), `lifecycle.ts` (approval and relay-session transition tables).

## Rules in detail

**Agents and tokens**

- One header file per user per machine; every agent of that user on that machine shares it, and each request carries its own reason.
- Enrollment may carry an empty `want`: the agent then reads `/catalog` and asks once it knows what it needs.
- An agent may send its `sshKey` with any request; a newer key replaces the older one.
- After **Revoke agent**, its token answers `denied` with "stop" (not `enroll`) until speaker restarts.
- Commands and links in `/help` and `/catalog` use the address the caller used to reach speaker, so `localhost` on a single laptop and the LAN or tailnet name elsewhere both work.

**Requests and waiting**

- A request made by a service call (`Speaker-Wait` on `/<service>/<path>`) asks for exactly that service's `.read` or `.full`. The advice to ask for groups applies to `POST /_speaker/requests`.
- Every hold needs the `Speaker-Wait` header; without it, calls answer at once. `/help` suggests 60 seconds (the maximum is 120), because many agent shells stop commands after 120 seconds.
- A request the owner does not decide within 2 hours is `expired`; the agent's next call answers `approval_required` again.
- `retry_after` is an ISO 8601 time.
- A group is offered to an agent only if every member is an item kind that agent can use; direct agents never see groups containing `site:`, `mcp:` or `ext:`.
- `/help` explains items and groups in general and never names a group, service, target or share.
- `site:*.example.org` covers subdomains only, not `example.org` itself.

**SSH**

- On any refusal or ended session, the relay prints one line on standard error saying what happened and to check `GET /_speaker/catalog`.
- In Setup, each target shows the address speaker will appear from (the `from=` value); the owner can edit it or list several.

**Sandboxes**

- A sandbox host authenticates with the token it received at registration; agents it creates need no card of their own.
- At agent start the sandbox host gives the VM speaker's address, the agent's token (as a placeholder), and the skill. Speaker is always reachable from the VM. The template's `want`, `label` and `duration` become the agent's first request; the agent starts at once and Pi works on whatever needs no new access while it waits.
- The sandbox host tells each agent, in its instructions, the names of the `mcp:` and `ext:` entries in its catalog and the secrets it can use. Groups appear in `/catalog`.
- The sandbox host sends speaker its catalog of `mcp:` and `ext:` entries over its WebSocket. Speaker lists them, with every secret and group, in `/catalog`, and the `request_capability` tool shows that text to the agent.
- A grant for a sandbox-only item counts as decided for the agent once the sandbox host reports it in force.
- After an `mcp:` or `ext:` grant, Pi reloads at its next idle moment and gains the new tools.
- An extension's sites live and end with it. A site that came only because a request named `ext:<id>` (not asked for in that request) records the ext grant it belongs to; revoking, expiring or ending the agent of that ext grant ends the site grant too, through the same path (audit and push to the sandbox host). A site asked for explicitly, or already held on its own, stays. A site shared by two extensions ends with the last of them. Extending the ext grant extends its bundled sites. Cards and the Active list show the relationship.
- A secret's Setup entry names the environment variable the sandbox sees (for example `GH_TOKEN`); `/catalog` shows it with the allowed hosts. Granting a secret also opens its allowed hosts; the card lists them, in the write tint.
- A sandbox host mounts its agents' folders itself with `sshfs`: speaker sends it those grants in its snapshots, the agent's `sshKey` comes with the host's own requests for it, and speaker still enforces and logs everything.
- After a speaker restart, the agent tokens of running agents are unknown and their grants are gone. Those agents lose speaker access until they are relaunched (the sandbox host does not re-create their agents).

**Deployment**

- The SSH port does not go through a web reverse proxy; open it separately.
- Approving from a phone away from home needs a route to speaker, such as the tailnet.
- On a single machine every local client can share one source address, so address binding adds little there; that setup protects against accidents and keeps a record, not against a hostile agent running as the owner.

## Alternative to explore: a slimmer VM if every folder goes over SSH

Every folder reaches sandboxes over SSH (`sshfs` through speaker), so the VM needs no shared-filesystem device at all, which opens up slimmer and faster runtimes:

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

## Secrets: speaker inserts them

A real secret is never handed to an agent or a sandbox host. Speaker keeps it and puts it into each request itself; agents and sandbox hosts only ever see a placeholder. Speaker runs an HTTPS proxy for this, using a maintained proxy library, with its own certificate authority: it decrypts only requests to hosts covered by an active `secret:` grant, inserts the secret, and forwards them. Sandbox hosts send their secret-host traffic to this proxy; direct agents use it the same way.

### Worked example: `gh` and `git` in a sandbox

**Once, in speaker's Setup.** The owner adds a secret:

- name `GITHUB_TOKEN`;
- value: a GitHub fine-grained token limited to the repositories and permissions tasks should have;
- allowed hosts `api.github.com` and `github.com`.

**At agent start.** Nothing is set in the VM: speaker issues the placeholder (`speaker-placeholder-<random, per agent>`) only when the grant exists. The agent reads it from `/catalog` and sets `GH_TOKEN` on the command that needs it, running `gh auth setup-git` once so `git` gets its credentials from `gh`. The placeholder is not a GitHub token and is worthless anywhere else.

**The agent asks.** Pi requests `secret:GITHUB_TOKEN` with a reason, for example "open a pull request for the fix". The owner's card shows the secret, its allowed hosts, and the write tint. Granting it also allows the sandbox to reach those two hosts; no separate `site:` items are needed. Speaker tells the sandbox host over its WebSocket that the agent holds `secret:GITHUB_TOKEN` for `api.github.com` and `github.com`, until the grant's end. The value is not sent.

**Each request, for example `gh pr create`:**

1. `gh` sends `POST https://api.github.com/repos/<owner>/<repo>/pulls` with `Authorization: token speaker-placeholder-…`.
2. The VM's only network route is the sandbox host's interception. It terminates TLS with the sandbox's own certificate authority, which the VM trusts, and sees a request to a host covered by an active secret grant.
3. Instead of sending it straight to GitHub, the sandbox host sends it to speaker's proxy (an HTTP `CONNECT` tunnel to the destination, authenticated as the agent; the tunnel trusts speaker's certificate authority).
4. Speaker checks that the agent holds `secret:GITHUB_TOKEN`, that `api.github.com` is one of its allowed hosts, and that the grant is still active. It replaces the placeholder with the real token, in the `Authorization` header and, for `git`, inside HTTP Basic credentials (`git` sends the token as the Basic password), and nowhere else.
5. Speaker sends the request to GitHub over its own TLS connection, streams the response back to the sandbox host, and logs agent, host, method, path and status, never the token and never the bodies.
6. The sandbox host returns the response to `gh`, which works as usual. `git clone`, `git push` and `gh api` go the same way to `github.com` and `api.github.com`.

**Revoke or expiry.** Speaker stops forwarding at once: the next `gh` or `git` call gets a 403 whose message says the access ended.

**What each party holds:**

| | Real token | Requests and responses | Placeholder |
| --- | --- | --- | --- |
| Speaker | yes, encrypted at rest, in memory after unlock | passes through, not stored | knows which placeholder belongs to which agent |
| Sandbox host | never | sees them (it already sees all sandbox traffic) | sets it in the VM |
| Agent in the VM | never | its own | sees it |
| GitHub | yes, on each request | yes | never |

**If the sandbox host is taken over,** it can make GitHub requests through speaker only while a `secret:GITHUB_TOKEN` grant is active, only to the allowed hosts, and every request is logged. It cannot copy the token for later or for use elsewhere.

**Costs.** All traffic to the secret's hosts, including large `git clone`s, goes through speaker, so speaker needs the bandwidth and adds one hop of latency. The sandbox host's interception gains one hand-off rule: requests to hosts covered by an active secret grant go to speaker instead of the internet.

### The same for a direct agent

Claude Code holding `secret:GITHUB_TOKEN` runs `gh` with three environment variables from `/catalog`: `GH_TOKEN=<placeholder>`, `HTTPS_PROXY` pointing at speaker's proxy (with its agent token as the proxy credential), and `SSL_CERT_FILE` naming speaker's certificate authority (fetched once from `/catalog`). `gh`, and `git` with `gh auth setup-git`, then work exactly as in the sandbox, and the token never reaches the agent's machine. Use it when it is reasonable; an owner may equally give a direct agent its own token.
