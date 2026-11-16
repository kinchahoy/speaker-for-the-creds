<!-- author: ai -->

# Speaker: design

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab services, folders, network access and hosts without ever holding the owner's keys. Agents ask; the owner approves in `/admin` (a browser, including a phone) or the Herdr mod, for a chosen time; speaker makes the call, relays the session, or tells a sandbox what to allow, and can cut any of it off.

This document holds the design and the reasons for it. Everything here describes code that exists unless a heading says "Planned". For what the project is for and what works today, see the [top-level README](../README.md); for setup, configuration and the owner API, see [README.md](README.md). Setup-level facts (service rules, scopes, the secrets proxy, keys and sign-in, Docker deployment, `TRUSTED_PROXY`) live only there.
{.ai}

## Principles

1. **The owner grants everything.** No agent, rule or timer creates or lengthens access on its own. Only the owner approves, extends and revokes. The one deliberate exception: services whose reads the owner marked open.
2. **Agents never hold the owner's keys.** Speaker adds the real credential itself. A leaked agent token is narrow, short-lived and bound to one address.
3. **Ask for the minimum.** Agents ask for exactly what the task needs, with a one-sentence reason. Groups exist to make review easy, not to widen access.
4. **One call should be enough.** If access is missing, the call waits for the owner and then succeeds. Every failure says what to do next.
5. **Speaker does the controlling.** Limits are enforced by speaker (or the sandbox host), not by special configuration on each target machine.
6. **Nothing to install for agents.** Plain `curl`, `ssh`, `scp`, `sftp` and, where present, `sshfs`.
7. **Brutally simple state.** Only durable settings, encrypted keys and the append-only log reach disk. Agents, grants and requests live in memory; after a restart, agents ask again.

"Weak agent" means a small model that follows steps literally, copies commands exactly and does not improvise around errors. All agent-facing text and errors are written for it.

## Who it serves

- **Direct agents** (Claude Code on a workstation) have their own internet, files and tools. They come to speaker only for the owner's credentials or hosts, and never need `site:`, `mcp:` or `ext:`.
- **Sandboxed agents** (Pi in a bottle VM) start with nothing, so they also need websites, MCP servers and extensions. Same flows, three differences: the sandbox host creates the agent and hands it a token, the token is bound to the host's address, and the VM needs a route to speaker's HTTP and SSH ports.
- **Unattended agents** are in scope, because the goal is an agent that wakes on a schedule. The launch card is the approval (see the `cron` template in bottle); anything beyond it is a card the agent waits on. Not built: a to-do list kept across runs, and any channel that reaches the owner away from a browser or Herdr.
- **Single laptop** works: direct agents use `http://localhost`, the owner signs in over plain HTTP (the page warns), and VMs reach speaker by the laptop's network address. Every local client shares one source address, so address binding adds little there; it protects against accidents and keeps a record, not against a hostile agent running as the owner.

## Names and items

Terms: the **owner** runs speaker and decides every request. An **agent** is anything holding a speaker token: *direct* (enrolled itself) or *sandboxed* (created by a **sandbox host**, bottle, for one run). A **service** is an HTTP API or remote MCP server reached through speaker; a **target** is a host speaker opens SSH sessions to, as one limited account; a **share** is a named folder on a target. A **request** is one card; a **grant** is one approved item for one agent until a time; a **group** is an owner-defined set of items.

| Item | Grants | Who may ask |
| --- | --- | --- |
| `<service>.read` | GET, HEAD, OPTIONS, plus POST to paths marked as reads in Setup; for MCP services, listing and read-only tools | any |
| `<service>.full` | read plus every other method or tool call | any |
| `ssh:<target>` | commands on that target as its agent account | any |
| `folder:<share>[:rw]` | the share, read-only unless `:rw`; always delivered over SSH | any |
| `secret:<NAME>` | speaker inserts the secret into the agent's requests to the hosts the owner bound to it in Setup | any |
| `site:<host>`, `site:*.<domain>` | network access from the sandbox (`*.x` covers subdomains only) | sandboxed |
| `mcp:<id>` | an MCP server running inside the VM, from the sandbox host's catalog | sandboxed |
| `ext:<id>` | a Pi extension from the sandbox host's catalog | sandboxed |
| `group:<name>` | every item in the group | any, if it may use all members |

Remote MCP servers are services, so every agent reaches them the same way; only in-VM ones need `mcp:`. Visiting other sites is a separate `site:` item, unaffected by a secret.

## Lifecycles

Both are explicit tables with one `transition()` (`lifecycle.ts`).

- **Approval** (everything anyone asks the owner for, agent or sandbox host): `pending` becomes `granted` or `denied`. Rules can answer without the owner, creating it already `open` (an open read) or `denied` (`never`, unavailable, locked after three denials). Pending ends `expired` (nobody decided) or `revoked` (what it asks for went away); granted ends `expired` or `revoked`. Extend keeps it granted.
- **Request:** one card, `pending` while any approval is, then `decided`, or `expired` after 2 hours (host registrations wait until decided).
- **Reconcile:** after any Setup change, every pending or granted approval whose item is gone ends (`grant_revoked`, with why), and so does a grant whose reach grew beyond what the owner approved. What a card says approving opens (a secret's hosts, a service's URL and read paths, a target's account, a share's path) is stored with the grant.
- **Grant:** exists only while in force; ending it (`grant_expired` or `grant_revoked`) immediately ends any session or mount it allowed. Extend adds one more span of the original length. A later approval of the same item for the same agent replaces it. Durations: `30m`, `1h`, `2h` (default), `1d`, `30d`, and for the owner only, until revoked. Everything ends when speaker restarts.
- **Agent:** exists from enrollment and can do nothing but read open services until granted something. Valid while it holds a grant or called in the last 7 days; a sandboxed agent ends with its run. A direct agent whose address changes enrolls again. **Revoke agent** ends its token and grants and leaves a tombstone until restart, so the token answers `denied` ("stop") rather than `enroll`.
- **Sandbox host:** registers (unauthenticated; adds only a pending entry) and the owner approves it. Speaker keeps the host record on disk but not its approval, so after a restart every known host is a pending card again and its calls answer `approval_required`; bottle treats that as an outage and stops if the owner does not approve within 5 minutes (30 seconds at its own start). Approving removes any other host with the same name and source address (`host_replaced`): the same machine registering again, its old tokens dead and its agents ended.
- **Restart:** speaker starts locked; agents, grants and requests are gone; sessions and mounts end.

## How an agent works

**Setup (direct agents, once).** `/help` tells the agent to create a random token, keep it only in a user-only header file (`Authorization: Bearer …`) and enroll with the token's SHA-256, its identity and its first request. Calls use `curl -H @<header file>`, keeping the token off command lines; no script is served or run. Identity fields: `label` (task in at most 8 words), `agent` (`<model> · <app> on <machine>`) and, on every request, a one-sentence `reason`. Speaker adds the source address and a token fingerprint; those are the only verified facts, and the rest are shown as the agent's claims.

**Waiting.** One mechanism: the `Speaker-Wait: <seconds>` header (max 120) on any call, with curl's `--max-time` a little above it. Without access, speaker files a request (or joins the agent's pending one for the item; `Speaker-Reason` gives the reason), holds the call until the owner decides or time runs out, then forwards or says what to do next. `POST /_speaker/requests` and enrollment hold the same way, and `GET /_speaker/requests/<id>` lets a client file at once and watch later without filing again. `/help` suggests 60 seconds because many agent shells kill commands at 120.

**Requesting.** `POST /_speaker/requests` with `{"want":[…],"reason":"…","duration":"2h"}`. An agent that will use SSH or folders sends one throwaway public key (`sshKey`; a newer one replaces the old). Target and share names come only from the owner or the task; speaker never lists them. The agent is told to ask for the minimum: for three or more items from one group, ask for the group; otherwise the exact items. The reply is per item; the agent works with what it got. Each POST is its own card, except one naming exactly the same items as the agent's pending request, which joins it. A name the agent may not ask for fails the whole POST with 400 `invalid` and creates nothing; an item that exists but cannot be delivered is answered `denied` at once and logged. When an `ext:` request's catalog entry has `sites`, speaker adds those `site:` items to the same card, so one approval covers both. The owner approves exactly what the card shows.

**Denials.** A denied item tells the agent to stop. If it asks again anyway the owner sees it again, up to three denials; then speaker answers `denied` with `retry_after` (15 minutes, ISO 8601) without asking the owner, and the count restarts. Agents are not told asking again is possible.

**Knowing where it stands.** `GET /_speaker/catalog` returns everything the agent may ask for with its state: services, live grants (`applying` until a sandbox host reports one in force), every secret (name, hosts, variable, state; the placeholder only once granted), exact SSH and folder commands, groups, its requests, and for sandboxed agents the host's `extensions` and `mcp`. `text` is the same as plain markdown for a weak model; `request_capability` pastes it into its description.

**Errors.** Every error is JSON: `error` (code), `message`, and where useful `next` (the exact call to make, or "stop"; when it points at docs it names a section) and `tell_user` (one line with the approval link). 401s carry `WWW-Authenticate` and a `Link` to help. `enroll` does not disclose why a token failed. Shape and codes are defined once (`errorBody`, `ErrorCode` in `items.ts`); bottle reuses them.

## SSH and shares: how speaker controls them

**Targets.** The owner adds a target in Setup (alias, host, port, the account speaker uses, pinned host key) and puts one line in that account's `authorized_keys`: `from="<speaker's address>",restrict ssh-ed25519 AAAA… speaker`. `from=` makes the key useless from anywhere else and `restrict` refuses forwarding. Nothing else is installed on the target. A dedicated limited account is recommended; the owner's own works at the cost of granting everything it can do. Adding a target refuses `root` unless confirmed and warns on passwordless sudo. Speaker has one SSH key for all targets, in clear only in memory (`ssh-agent`) after unlock; revoking it everywhere means deleting one line per target.

**Jump server and relay.**

- Speaker listens on `SSH_PORT` only while an SSH or over-SSH folder grant is active, handing each connection to a stock non-root `sshd -i` (no daemon to reap), with a new host key each start.
- Per agent with an active grant, speaker writes one memory-backed `authorized_keys` line: `restrict,from="<agent's address>",command="relay <agent>",expiry-time="<grant end>" <throwaway key>`. The agent never gets a shell on speaker.
- `relay` takes the target (first word of the command) or share (first part of each path), checks the grant with speaker, and runs the system `ssh` to the target with the exact command, no local shell, via `ssh-agent`. It keeps a connection to speaker for the session. At expiry, revoke or restart, speaker closes it and the line is removed; `expiry-time` stops new logins even if speaker stalls.
- Commands run as `ssh … <account>@<speaker> <target> '<command>'`; there is no interactive terminal, so nothing secret is typed into a session. `/catalog` gives complete command lines (`IdentitiesOnly`, `BatchMode`, the pinned host key) so nothing prompts or hangs.

**Folder limits.** For `folder:` grants `relay` reads each SFTP operation (`sftp`, `scp` and `sshfs` all use it) and enforces the share itself: every path is resolved by the target and must stay inside; symlinks and hard links are refused; read-only grants refuse writes, deletes, renames and permission changes, and the target's `sftp-server` is also started read-only (`-R`) in the share (`-d`); unknown operations are refused; every operation is logged with its path. Limits: commands are not folder-limited (they run as the target's account), and a change by another process on the target between check and operation could escape the share. The card warns when a share is a home directory.

**Delivery.** Folders always arrive over SSH, labelled **over SSH** on cards, `/catalog` and Active. `/catalog` offers `sshfs` first (needs FUSE) so the agent works in place; `scp` and `sftp` are for one-offs. `sshfs` is slow for metadata-heavy work (`grep -r`, `find`, `git status`) because each operation is a round trip through speaker. Commands, `rsync` and legacy `scp -O` are refused on folder grants with a pointer to `sftp`.

Every session logs grant, agent, key fingerprint, source address, target, exact command or file operation, timing, exit code and why it ended.

## Keys and unlocking

All secrets (service keys, `secret:` values, speaker's SSH key) are encrypted with one random data key (AES-256-GCM), wrapped by a key derived from the owner's password (scrypt). A successful unwrap is the password check, so no password hash is stored. Speaker starts **locked**: until the owner has set a password and signed in, agent, sandbox-host, proxy and proxy-certificate calls are refused. Secrets exist in clear only in memory. A forgotten password means re-entering service keys and re-adding speaker's key on targets; nothing else is lost. A copied disk or backup reveals no secret; a takeover of the running process can, which is why grants stay short and target accounts limited.

## The owner's side

Sign-in is the owner's password (rate limited, session cookie). Network identity such as a tailnet login is never accepted as the owner, because agents on the owner's machines share it. Inbox and Active poll and swap only when content changed, so ticked boxes stay put.

- **Inbox:** requests as cards (label, agent string, source address, token fingerprint, reason, duration picker), plus sandbox hosts awaiting approval. Every group, member and item has a checkbox, ticked by default; **Approve** grants what is ticked and denies the rest. Items that can change things (`.full`, `:rw`, `ssh:`) are tinted. A card warns when the same agent string enrolled shortly before.
- **Active:** grants with **Extend** and **Revoke**, open SSH sessions with **End**, approved hosts, and per-agent counts. **Refused** (turned away before reaching the owner) and **blocked** (refused for lack of a grant) turn red when non-zero.
- **Setup** edits services, secrets, groups, targets, shares and the password. **Log** is an in-memory buffer; standard output is the full record.

## Sandbox hosts

A sandbox host registers with a name and the item kinds it can enforce, and the owner approves it once. Per run it creates a sandboxed agent (a template's `want`, `label` and `duration` become its first request, and it starts at once), receives its token, and speaker binds that token to the host's address so a token leaked from a VM works nowhere else. The host holds a WebSocket to speaker, receives every grant and revocation as it happens, applies them in the VM and reports which are in force; a grant for a sandbox-only item counts as decided once reported. Silent for 30 seconds, it drops its agents' grants until reconnected. It also sends its catalog (`mcps`, `extensions` with `sites`) over the socket, kept like its share report and cleared on disconnect.

- **Launched extensions.** An extension whose catalog entry has no `sites` is loaded at launch without a card: the owner wrote the template and started it. The host names them (`launched`) when it creates the agent; speaker logs them in `agent_created` and shows them in Active, but they are not approvals and cannot be revoked.
- **Launch folders** the owner names at launch are bound into the VM by the host directly. Launching is the approval, so speaker never sees them; bottle records them in the archive.
- **Extension sites** live and end with the extension. A site that came only because a request named `ext:<id>` records its ext grant; revoking, expiring or ending that grant ends the site too (a site asked for explicitly stays; one shared by two extensions ends with the last). Extending the ext extends its sites.
- Granting a secret also opens its allowed hosts; the card lists them.
- After a speaker restart the running agents' tokens are unknown and their grants gone; they lose speaker access until relaunched (the host does not re-create agents).

## Discovery and what an agent can see

`GET /` and `GET /_speaker/help` serve one document (`skill/SKILL.md`): a one-screen top (what speaker is, the call form, how to wait, follow `next`), then Set up (sh and PowerShell), What you can ask for, Asking, Folders and SSH, Secrets, Remote MCP servers, Errors. It never names a group, service, target or share. Sandboxed agents get guidance from the sandbox host's tool instead. `GET /_speaker/help/<service>` gives a service's notes plus the caller's state.

Anyone who can reach speaker can enroll, so a list shown to agents is shown to anything on the owner's network. Speaker lists only names that reveal little and that an agent needs to ask well; the rest comes from the owner, the task, or a grant already held.

| Kind | Shown to agents |
| --- | --- |
| Services needing a grant (`ask`, `never`) | listed with state |
| Open-read services | not listed; usable if the agent knows the name |
| Groups it may ask for | listed with description and items; direct agents never see groups with `site:`, `mcp:` or `ext:` |
| Secrets | every secret: name, variable, hosts, state (names reveal little: the agent only ever holds a placeholder) |
| Folders and SSH targets | never listed; only its own grants, with commands; inside a group only a count ("1 folder") |
| Sites | nothing to list; any hostname may be asked for |
| In-VM MCP servers and extensions | sandboxed only: every catalog entry with its sites |

Unknown names are refused the same way for every kind, before anything reaches the owner: 400 `invalid`, `<name> is not something you can ask for. <Kind> you can ask for: <real names>.` For folders and targets there is no list: `There is no folder named <share> that you can use.`

## Security model

- **Tokens** are random, stored as SHA-256 hashes, kept by agents in a user-only header file and bound to the address they enrolled from; sandbox host tokens likewise (from elsewhere the host is told to register again). A revoked token stays refused, at enrollment too: asking again takes a new token, which reaches the owner as a new agent. "Address" is the socket address, or the last `X-Forwarded-For` entry when the peer is `TRUSTED_PROXY`; the header from anyone else is ignored.
- **Enrollment** is unauthenticated but rate limited (20 per 15 minutes in total). It refuses malformed hashes and the hash of an empty token; re-enrolling with the same token returns the existing agent.
- **Approval** happens only in `/admin` behind the owner's sign-in, with same-origin checks. The owner API takes only a bearer token from its own sign-in and never the cookie, and its tokens are never accepted as the cookie, so a browser page cannot ride the session into it. Card details from the agent are shown as claims; source address and fingerprint are speaker's own. The Herdr mod holds its token in memory, so a direct agent running as the owner's user on the same machine could read or edit it: the single-machine limit.
- **Upstream calls** do not follow redirects; a key embedded in an upstream URL is redacted from replies and logs.
- **Limits:** speaker cannot stop an agent misusing access it was granted, and a takeover of the running speaker exposes every unlocked key. Hence short grants, least-privilege upstream tokens, limited target accounts, everything logged, one-click revoke. Revocation cannot undo completed operations.

Data: settings and encrypted keys are on disk in the data volume; agents, grants, requests, sessions and counters are in memory; the log goes to standard output.

## Planned, not built

_Nothing here exists in the code._
{.ai}

- **Bottle status in the web admin.** Agents' runtime status and latest messages as a bounded, allowlisted report over the existing host connection, shown as untrusted text; the phone never calls bottle's control API.
- **Herdr launch form.** Replace the template-by-model button matrix with a form (template, model, mode, folder scope) that keeps its values until accepted, so exploring models cannot start a VM.
- **One WebSocket instead of most routes.** Each agent keeps one socket for requests, pushed decisions and revocations, and tunnelled SSH. For: no waiting or polling, one port, far fewer routes and error cases. Against: agents run one short process per tool call, so a lasting connection needs a background helper (close to installing something); `curl` WebSocket support is recent; weak agents handle one request and one reply better. Best fit is sandboxes, where the host already holds a socket.

## Secrets: speaker inserts them

A real secret is never handed to an agent or a sandbox host. Speaker keeps it and inserts it into each request; everyone else sees a placeholder. Speaker's HTTPS proxy (setup in [README.md](README.md#secrets-proxy)) decrypts only requests to hosts covered by an active `secret:` grant. The owner decides once in Setup which hosts each secret may reach; agents cannot choose the destination.

**Example: `gh pr create` in a sandbox, secret `GITHUB_TOKEN` for `api.github.com` and `github.com`.**

1. Nothing is set in the VM at start. When `secret:GITHUB_TOKEN` is granted, speaker issues a per-agent placeholder (`speaker-placeholder-<random>`), worthless anywhere else. The agent reads it from `/catalog` and sets `GH_TOKEN` on the command that needs it (`gh auth setup-git` once for `git`). Speaker tells the sandbox host which hosts the grant covers, never the value.
2. `gh` sends `POST https://api.github.com/…` with the placeholder. The VM's only route is the host's egress proxy, which decrypts nothing: it sees a `CONNECT` to a host under an active secret grant and chains the tunnel to speaker's proxy as the agent. The VM's TLS ends at speaker's proxy, whose authority the VM trusts.
3. Speaker checks the grant, the host and the time, swaps the placeholder for the real token in the `Authorization` header only (for `git`, inside Basic credentials), forwards over its own TLS, streams the reply back and logs agent, host, method, path and status, never the token or bodies.
4. Revoke or expiry stops forwarding at once; the next call gets a 403 saying the access ended.

| | Real token | Placeholder |
| --- | --- | --- |
| Speaker | encrypted at rest, in memory after unlock | knows which belongs to which agent |
| Sandbox host | never; sees only encrypted tunnels | never |
| Agent in the VM | never | yes |
| GitHub | on each request | never |

If the sandbox host is taken over, it can make requests through speaker only while the grant is active, only to the allowed hosts, all logged; it cannot copy the token. Cost: all traffic to those hosts (large `git clone`s too) passes through speaker. A direct agent does the same with `GH_TOKEN`, `HTTPS_PROXY` and `SSL_CERT_FILE` from `/catalog`.

## Verifying end to end

Status: written, no recorded run. The unit tests cover the proxy, secrets, lifecycle, jump server and sandbox host, but nothing boots a guest, so this one pass on real endpoints is what proves the property the project rests on: an agent asks, the owner approves, the call goes through, a revoke cuts it off.

A subagent drives the pass through Herdr (`hc send`, `hc wait`, `hc read`) while the owner approves cards: a card whose reason contains `E2E-DENY` is denied, every other is approved for the shortest duration. It changes no code, never prints a secret (it tests a key prefix), and polls up to 10 minutes per card. Evidence: `audit.jsonl`, `~/.bottle/bottle.log`, the archive under `~/.bottle/output/`.

Gotchas: `mise run init` needs a real terminal and the first image build takes over 10 minutes. The share path must be written out in full (no `~`), the folder must exist, and the account needs Setup's `authorized_keys` line first.

Setup: `check` and `test` pass; the owner runs `mise run init`, enters the OpenRouter key, adds SSH target `local` (127.0.0.1) and share `e2e` holding a `hello.txt`; the subagent sets one cheap model in `hostedProviders`.

| Check | Passes when |
| --- | --- |
| A. `bottle run`, then `hc ls` | A `pi-<id>` terminal appears in Herdr's bottle space and Pi answers through the local model |
| B. Models call through `openrouter.read`, then `openrouter.full` | Both return 200; audit log has proxy lines; VM environment and Pi config hold no key |
| C. `site:example.com` with `E2E-DENY` | Pi reports a denial; `curl` in the VM gets 403 |
| D. `site:pypi.org` approved | pypi.org answers 200 and example.org still 403 |
| E. Revoke B's read grant while live | The next call is refused within seconds |
| F. Shortest duration, call after expiry | Refused after expiry |
| G. `folder:e2e` read-only, then `:rw` | Read works, write fails, nothing outside the share shows; read-write lands on the host; revoke unmounts |
| H. `bottle run -d -m openrouter/<model>` with a file-writing prompt | Waits in `awaiting-grant`, starts after approval, finishes and archives; model-call lines are 200 and the archive holds no key |
| I. After H | Tab gone; archive has `agent.json`, `manifest.json`, `pi-session.jsonl`, `transcript.html`, `model-calls.jsonl`, `artifacts/` |
| J. `bottle stop` | Archived, tab gone, agent gone from Active |
| K. Approve `site:pypi.org` from the Herdr inbox | A toast, the bar counts 1 then 0, the grant shows in the inbox and `/admin` |
| L. Deny a request in Herdr, then revoke K's grant | Pi reports the denial, the revoked site gets 403, the audit log has both decisions |

The report: one table (check, pass, fail or no decision, evidence), then each failure with its exact error. No fixes.
