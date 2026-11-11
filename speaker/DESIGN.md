<!-- author: ai -->

# Speaker: design

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab services and network access without ever holding the owner's keys. Agents ask; the owner approves from a phone, for a chosen time; speaker makes the call on the agent's behalf or tells a sandbox what to allow.

## Principles

1. **The owner grants everything.** No agent, rule, or timer can create or lengthen access on its own. Only the owner approves, extends, and revokes.
2. **Agents never hold upstream keys.** Speaker adds the real credential to each forwarded call. A leaked agent token is narrow, short-lived, and bound to one machine.
3. **Ask for the minimum.** Agents ask for exactly what the task needs, with a one-sentence reason. Standard groups exist to make review easy, not to widen access.
4. **One call should be enough.** An agent makes the call it needs; if access is missing, that call waits for the owner and then succeeds. Every failure says what to do next.
5. **Nothing to install.** Agents use plain `curl` (or PowerShell) and one header file. Instructions are short and served by speaker itself.
6. **Small and explicit.** Few names, few routes, one clock per grant. Fail fast with a clear message instead of guessing.

## Names

| Name | What it is |
| --- | --- |
| **Owner** | The person who runs speaker and decides every ask. |
| **Agent** | Anything holding a speaker token that asks for access: for example Claude Code on a workstation, or Pi inside one sandbox task. |
| **Direct agent** | An agent that enrolled itself. It may ask for service access and SSH. |
| **Sandboxed agent** | An agent created by a sandbox host for one task. It may also ask for sites, folders, secrets, MCP servers and extensions, because the sandbox host enforces those. |
| **Sandbox host** | A trusted service (bottle-school) the owner registers once. It starts sandboxes, creates one agent per task, and enforces that task's grants inside the VM. It never asks for access for itself. |
| **Service** | An API speaker holds a key for (Obsidian, Karakeep, Home Assistant). Speaker forwards calls to it. |
| **Item** | One thing that can be granted, written as a string (below). |
| **Group** | A named, owner-defined set of items with a one-line description, such as `developer`. |
| **Ask** | One request from one agent: a list of items and groups, a reason, a duration. Shown to the owner as one card. |
| **Grant** | One approved item for one agent, until a time. The owner can extend or revoke it. |

### Items

| Item | Meaning | Who may ask |
| --- | --- | --- |
| `<service>.read` | GET, HEAD, OPTIONS to a service (for MCP services: listing and read-only tools) | any agent |
| `<service>.write` | every other method or tool call | any agent |
| `ssh:<user>@<host>` | a short-lived SSH certificate for the agent's own key | any agent |
| `site:<host>` or `site:*.<domain>` | network access from the sandbox | sandboxed |
| `secret:<NAME>@<host>[,<host>]` | a secret the sandbox host injects for those hosts only | sandboxed |
| `folder:<share>` or `folder:<share>:rw` | a host folder mounted into the sandbox | sandboxed |
| `mcp:<id>` | an MCP server from the sandbox host's catalog | sandboxed |
| `ext:<id>` | a Pi extension from the sandbox host's catalog | sandboxed |
| `group:<name>` | every item in that group | any agent, for groups it may use in full |

### Service rules

Each service has a rule for read and one for write:

- **open**: an approved agent uses it without a card, for as long as the agent is alive.
- **ask**: each agent needs a grant.
- **blocked**: never granted; agents are told not to ask.

## Lifecycles

**Ask:** `pending` → `decided`, or `expired` if the owner does not decide within 2 hours. A decided ask records, per item, `granted` or `denied`.

**Grant:** `active` → `expired` at its end time, or `revoked` by the owner. The owner can extend an active grant by one more span of its original length, any number of times. A later approval of the same item for the same agent replaces the earlier grant.

**Agent:**
- A direct agent enrolls with its first ask. Approving that ask approves the agent; denying all of it denies the agent.
- An agent stays valid while it has an active grant or has made a call in the last 7 days. After that its token stops working and it enrolls again with a new token.
- A sandboxed agent is created by its sandbox host without a card and ends when its task ends. Its asks still need the owner.
- The owner can revoke an agent at any time; all its grants end with it.

**Sandbox host:** registers once, the owner approves it, and it stays until the owner removes it.

## Durations

Agents may name a duration; the default is **2h**. Choices: `15m`, `1h`, `2h`, `1d`, `30d`, and (owner only) until revoked. The card preselects what the agent asked for; the owner can change it before approving. SSH certificates are capped by a configured maximum and cannot be extended or revoked early, so their duration stays short.

## How an agent works

### Setup (direct agents, once)

The agent runs a short sh or PowerShell block from `/help`. It creates a random token, stores it only in a header file readable by the user (`Authorization: Bearer …`), and enrolls with the SHA-256 of the token, its identity, and its first ask. It then calls with `curl -H @<header file>`, which keeps the token off command lines and out of process lists.

Identity fields, as the agent is told to fill them:

- `label`: the task in at most 8 words, as the user would say it. Example: `Update the PrimeX homelab notes`.
- `agent`: `<model> · <app> on <machine>`. Example: `Opus 5.5 · Claude Code on PrimeX`. `unknown` for any part it does not know.
- `reason` (every ask): one sentence on why the task needs this now. Example: `Write the session report into Homelab/Services`.

Speaker adds the source address and a token fingerprint itself.

### Calling a service

`<method> $SPEAKER_URL/<service>/<path>` with the header file. Speaker checks the rule and grants, adds the real credential, and forwards the call to the service's API root.

If access is missing, the agent repeats the call with `Speaker-Wait: 60` and `Speaker-Reason: <one sentence>`. Speaker files an ask (or joins the agent's pending one), holds the call until the owner decides or 60 seconds pass, and then either forwards it or answers with what to do next. Repeating the call later joins the same pending ask; it never creates a second card.

### Asking for several things

`POST /_speaker/asks` with `{"want":["group:developer","site:example.org"],"reason":"…","duration":"2h"}`. The agent is told:

> Ask for the minimum the task needs. If a group fits the task closely, i.e. you need most of its items, ask for the group: it is one decision for the owner. If you need one or two things, ask for exactly those items (`site:google.com`), even when a larger group contains them. Never ask for a group to cover a single item, and never list a group's items one by one.

The decision comes back per item: `{"granted":[…],"denied":[…],"expiresAt":"…"}`. The agent works with what was granted and does not ask again for what was denied.

### Knowing where it stands

`GET /_speaker/me` returns, for the calling agent: its status, the services it may use with read and write state and end times, the groups it may ask for (with description and items), the SSH hosts it may ask for, and its asks with per-item outcomes (and an SSH certificate once granted). `?wait=60` holds the reply until something the agent is waiting on is decided. A pending agent may call it; this is how it waits for its first approval.

### Errors

Every error is JSON with `error`, and where useful `next` and `tell_user`:

- `next` is either `GET /_speaker/me?wait=60` or an instruction to stop.
- `tell_user` is one line with the approval link for the owner.
- 401 responses also carry `WWW-Authenticate: Bearer realm="speaker"` and `Link: </skill.md>; rel="help"`, so an agent that knows nothing about speaker can recover from its first failed call.

Error codes: `agent_pending`, `agent_denied`, `agent_expired`, `unknown_token`, `source_mismatch`, `approval_required`, `denied` (with `retry_after` when applicable), `blocked`, `service_not_configured`, `rate_limited`.

### Denials

Each denied item is reported as `denied`, and the agent is told to stop. If the same agent asks for an item again anyway, the owner sees it again, up to three denials. After the third, speaker answers `denied` with `retry_after` 15 minutes later and does not ask the owner until then; the count then starts over. Agents are not told that asking again is possible.

## The owner's side (`/admin`)

- **Inbox**: pending asks as cards. A card shows the agent's label, agent string, source address and token fingerprint, the reason, and a duration picker. Each group is one row (name, description, item count, expandable to its members) and items outside any group are listed separately and highlighted. Every group, member and item has a checkbox, ticked by default; **Approve** grants what is ticked and denies the rest. A card warns when the same agent string enrolled shortly before.
- **Active**: grants and agents, each with time left, **Extend** (+1× its original span), and **Revoke**.
- **Setup**: services (URL, key, read and write rules, optional notes for agents), groups, sandbox hosts.
- **Log**: every forwarded call and decision, filterable by agent, grant, or service.

New asks also go to the owner's phone as a push notification linking to the card.

## Sandbox hosts

A sandbox host registers with a name and the item kinds it can enforce; the owner approves it once. For each task it creates a sandboxed agent and receives that agent's token. It holds a WebSocket to speaker, receives every grant and revocation for its agents as they happen, applies them inside the VM, and reports which grants are in force. A task template names what the task starts with as a `want` list (usually one group) and a `label`; that becomes the task's first ask.

## Discovery and instructions

- `GET /`: a three-line page for browsers; for agents, the core instructions.
- `GET /skill.md`: the same core instructions, registered as a skill where a harness supports skills. It is a few lines: what speaker is, the call form with the header file, `Speaker-Wait`, follow `next`, and where `/help` is.
- `GET /_speaker/help`: one page with setup (sh and PowerShell), asking and groups, sandbox notes, and SSH.
- `GET /_speaker/help/<service>`: that service's notes for agents plus the caller's current read and write state.

Services, rules and groups stay behind authentication. Speaker is reachable only on the LAN and tailnet.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /`, `GET /skill.md` | anyone | core instructions |
| `GET /_speaker/help[/<service>]` | anyone (service state needs a token) | full instructions, service notes |
| `POST /_speaker/agents` | anyone, rate limited | enroll a direct agent with its first ask |
| `GET /_speaker/me[?wait=60]` | agent | everything about the caller |
| `POST /_speaker/asks` | agent, sandbox host for its agents | ask for items and groups |
| `* /<service>/<path>` | agent | forwarded call, with optional `Speaker-Wait` |
| `POST /_speaker/hosts` | anyone, rate limited | register a sandbox host |
| `GET /_speaker/hosts/ws` | sandbox host | live grants for its agents |
| `POST /_speaker/hosts/agents`, `DELETE /_speaker/hosts/agents/<id>` | sandbox host | create and end a task's agent |
| `GET /_speaker/ssh/ca.pub` | anyone | CA key for target hosts |
| `GET /_speaker/health` | anyone | liveness |
| `/admin/...` | owner (password) | HTML forms only |

## Security model

- **Keys** stay in speaker's data volume, readable only by speaker, and are added to calls server-side. Responses are passed back without following redirects; a key embedded in an upstream URL is redacted from replies and logs.
- **Tokens** are random, stored by speaker only as SHA-256 hashes, and kept by agents in a user-only header file. A token works only from the address it enrolled from (the first `X-Forwarded-For` hop from the owner's reverse proxy, or the socket address). The proxy must set that header and speaker must not be reachable around it.
- **Enrollment** is unauthenticated but rate limited (20 per 15 minutes in total). It refuses malformed hashes and the hash of an empty token. Enrolling again with the same token returns the existing pending agent instead of a second card.
- **Approval** happens only in `/admin`, behind the owner's password, with same-origin checks on every change.
- **Limits of the model:** speaker cannot stop an agent from misusing access it was granted, and an agent running as the owner's own user can read that user's files. Grants are therefore narrow, short, logged, and revocable; open rules are for low-risk reads only.

## Data

Speaker keeps, in its data volume: services and their keys, groups, sandbox hosts, agents (token hash, identity, source, status), grants with end times, pending and recent asks, usage counters, and an append-only JSON log. Everything survives a restart. One instance serves one owner.

## Open decisions

- Whether the internal code, stored files and API adopt these names fully, or only the UI and documentation do.
- `asks` versus `requests` as the API noun.
