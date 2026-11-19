# speaker

_AI-drafted_

Reference for running and configuring speaker. What it is for, a two-minute try-out and where every setting lives are in the [top-level README](../README.md). The security model and the reasons behind it close this file.

## Running locally

_AI-drafted_

```sh
mise trust && mise install
mise run init speaker
```

Run this on the machine that hosts speaker. It asks its questions, writes `speaker/.env`, creates the encrypted store and offers to start speaker, signing in once with the password typed (kept in memory only). Data goes to `~/.local/share/speaker` by default. The web, secrets-proxy and SSH ports default to 3000, 3128 and 2222 and must be free. Agents in VMs cannot use `127.0.0.1` (inside a VM that is the VM itself), so `init` offers the machine's LAN address. For scripts:

```sh
printf '%s\n' "$PASSWORD" | mise run init speaker --yes --password-stdin --data-dir DIR --address IP
```

Other flags: `--port`, `--proxy-port`, `--ssh-port`, `--public-url`, `--trusted-proxy`, `--start`, `--no-start`, `--env-path`, `--force`. Start speaker later with `mise run speaker`, and sign in at `PUBLIC_URL/admin` after every restart.

## Docker deployment

_AI-drafted_

`speaker/compose.yaml` builds the image from the repository root, keeps state in a named volume at `/data`, and runs read-only with all capabilities dropped except `SETUID` and `SETGID` (the start script uses them to run the browser broker and speaker as two users) and `SYS_CHROOT` (Chromium's sandbox chroots inside its own user namespace), with the `chrome-seccomp.json` profile and `no-new-privileges`. Checked on Ubuntu 26.04 with Docker 28: Chromium reports itself fully sandboxed (PID and network namespaces, seccomp-BPF). `mise run init speaker` is for running without Docker; in Docker the owner sets the password on the first visit to `/admin`.

```sh
cd speaker
cp .env.example .env && chmod 600 .env   # set PUBLIC_URL first
docker compose up --build -d              # or: mise run speaker:up
docker compose logs --tail=100 speaker
```

- `PUBLIC_URL` is the exact URL opened in the browser, with scheme and any nonstandard port: `http://localhost:3000` locally, `https://speaker.example.com` behind a proxy. After changing `.env`, run `docker compose up -d --force-recreate`; a plain restart does not reload it.
- Compose binds `PORT` and `PROXY_PORT` to `127.0.0.1` and publishes `SSH_PORT` on every address. A bottle in a container on speaker's Docker network reaches them by service name. **When bottle runs on another machine**, publish `PROXY_PORT` on an address it can reach too (edit its `ports` line, as `compose.yaml`'s header shows), and keep both off the public internet. The SSH port never goes through a web reverse proxy.
- The image installs the newest release of each dependency; `docker compose build --build-arg LOCKED=1` uses `pnpm-lock.yaml`. Chromium adds about 740 MB.
- Bring a reverse proxy for HTTPS. Raise its timeout above 120 s, because speaker holds waiting calls that long. Set `TRUSTED_PROXY` to its IP or Docker service name (speaker looks the name up again every 30 seconds); speaker then takes the last `X-Forwarded-For` entry from it and ignores that header from everyone else. External login middleware, if any, goes on `/admin` and its child paths only, so agents can still use their tokens.
- Run one replica. Keep the data volume outside every agent's file access. `audit.jsonl` is append-only; rotate or delete it by hand.

## Services

_AI-drafted_

A request to speaker swaps the service name for the service's API base:

```text
/obsidian/vault/note.md  → https://notes.example.com/api/vault/note.md
```

- Enter a service's key in `/admin`; it is never shown again. Auth types: Bearer, Basic (`username:password`), a custom header, `path` (a secret URL segment such as a webhook ID, inserted after the base URL), or none (a keyless API or MCP server that speaker only gates). Only the upstream ever receives the key.
- Read rule: `ask` (default), `open` or `never`. Write rule: `ask` or `never`. `never` answers `denied` at once. `open` lets any enrolled agent read with no card; anyone who can reach speaker can enrol, so use it only for harmless state. Open services are never listed to agents.
- `<service>.read` covers GET, HEAD, OPTIONS and POST to the read paths listed on the service (such as a search endpoint). `<service>.full` covers everything.
- A scope is a service named `parent:name` (such as `obsidian:tasks`) that uses its parent's key, with its own address (same site, under the parent's) and its own rules. One key entered once then serves several narrow scopes; set the parent to `never` for both if it should only hold the key. Add one with the plus icon on the parent's row.
- "MCP server" marks a streamable-HTTP MCP service. Protocol housekeeping, tool listing and tools annotated `readOnlyHint: true` are reads; any other tool call needs `.full`, and cards mark destructive tools. "Refresh tools" shows how each tool classifies.
- `demo` has open reads and asked-for writes against a fake upstream; `/demo/check` answers `"credential":"accepted"`.
- `GET /_speaker/help/<service>` gives an agent the service's notes and its own state. A call without access answers `approval_required` and files a request for that service's `.read` or `.full`; with `Speaker-Wait: <seconds>` (at most 120) the call waits for the owner and goes through once granted.

## Secrets

_AI-drafted_

A secret in Setup has a name (letters, digits, `_`, `-`), a write-only value, the hosts it may reach (`*.domain` covers subdomains only) and the environment variable the agent sees. An agent granted `secret:<NAME>` gets a random per-agent placeholder from `GET /_speaker/catalog`, along with `HTTPS_PROXY`, the proxy certificate (`GET /_speaker/proxy/ca.pem`), `SSL_CERT_FILE` (or `GIT_SSL_CAINFO` for `git`) and the `gh auth setup-git` hint. It sets them on the one command that needs them.

The proxy listens on `PROXY_PORT` and takes `CONNECT` with the agent's token as password (`http://agent:<token>@<speaker>:<PROXY_PORT>`). For an allowed host it terminates TLS with its own certificate authority (made at first need, kept in the encrypted store), swaps the placeholder for the real value in the `Authorization` header only (inside Basic credentials too, as `git` sends it) and forwards over TLS. Every other host gets `403`; it is not a general proxy. Grants are checked on every request, so revoke or expiry answers `403` at once, even in an open tunnel. The log records agent, host, method, path (no query) and status. All traffic to those hosts, large `git clone`s included, passes through speaker.

**Released** secrets skip the proxy: after approval the agent reads the value with `GET /_speaker/secrets/<NAME>` (audit event `secret_released`), and the card says "agent receives the value". That cannot be taken back: the value lands in the agent's context, transcripts and model provider's logs. Turning an inserted secret into a released one needs the value typed again.

## Groups

_AI-drafted_

A group (`/admin` Groups, stored under `groups` in `config.json`) is a named set of items with an optional one-line description; it may not contain other groups. An agent asks for the group and the owner sees its items on one card, each with its own checkbox. `GET /_speaker/catalog` offers a group only if the agent may ask for every item in it, so direct agents never see groups with `site:`, `mcp:` or `ext:` items. `speaker/config.example.json` has examples. Its `research` group is keyless Exa search through pi-web-access plus Wikipedia and arXiv; Parallel Search is left out because its hosted fetch reads any page without a `site:` grant, so an agent asks for `parallel-search.read` explicitly.

## SSH and folders

_AI-drafted_

- **Targets** (Setup): alias, host, port, the account speaker uses there. Adding one pins its host key, refuses `root` unless confirmed, warns when `sudo -n true` works, and probes `sftp-server`. Add the line Setup shows to that account's `authorized_keys` first: `from="<speaker's address>",restrict ssh-ed25519 AAAA… speaker`. `from=` makes the key useless elsewhere and `restrict` refuses forwarding; nothing else is installed on the target. Use a limited account. Speaker has one SSH key for all targets, in clear only inside `ssh-agent` after sign-in.
- **Shares** (Setup): a name, a target and an absolute path; every share arrives over SSH. A folder on speaker's own machine is a share on a target for that machine (`127.0.0.1`, or the host's address from Docker) with `sshd` running; grant only `folder:` items there, since `ssh:` runs commands as that account.
- **Asking.** Agents send one throwaway public key (`sshKey`) and ask for `ssh:<target>` or `folder:<share>[:rw]`. Names are never listed to agents; an unknown one answers 400 `There is no folder named <share> that you can use.` and makes no card. After approval `GET /_speaker/catalog` gives complete command lines (`ssh … <target> '<command>'`, `sshfs`, `scp`, `sftp`, with the pinned host key, `IdentitiesOnly` and `BatchMode`). For `ssh:` grants, `scp`/`sftp` paths are `<target>/<absolute path>`.
- **Jump server.** Speaker listens on `SSH_PORT` only while an SSH or folder grant is active, handing each connection to a stock non-root `sshd -i` with a new host key each start. Per agent it writes one memory-backed line, `restrict,from="<agent's address>",command="relay <agent>",expiry-time="<grant end>" <key>`, so the agent never gets a shell on speaker. `relay.ts` checks the grant and runs `ssh` to the target with the exact command, no local shell. Ending, revoking or restarting closes the session; `expiry-time` stops new logins even if speaker stalls. Active lists open sessions with **End**.
- **Folder limits.** For `folder:` grants the relay reads each SFTP operation (`sftp`, `scp` and `sshfs` all use it): every path is resolved by the target and must stay inside the share, links are refused, read-only grants refuse writes, deletes, renames and permission changes, and the target's `sftp-server` also runs read-only (`-R`) in the share (`-d`). Commands, `rsync` and legacy `scp -O` are refused on folder grants. Limits: `ssh:` commands are not folder-limited, and a change by another process between check and operation could escape the share. Cards warn when a share is a home directory.
- `sshfs` works in place but is slow for `grep -r`, `find` and `git status`: each operation is a round trip through speaker.

## Browser sites

_AI-drafted_

A browser site is a website the owner signs in to by hand, for agents to use without seeing the login. Setup holds its name, start URL and the domains it may reach; list every domain the sign-in page loads from (CDNs too), since others are blocked. **Open** (lifetime 1h, 8h or 1d) starts a headless Chromium and a live view where the owner logs in; pasting works for passwords. An agent with `browser:<site>` sends allowlisted commands to `POST /_speaker/browser/<site>`: snapshot, click, fill, type, press, scroll, wait, open (the site's domains only), back, forward, reload, get, screenshot. Agents never get cookies, storage, JavaScript evaluation, uploads, downloads or the debugging port; the log records each command without its arguments.

- A browser runs only while needed. **Open** works only while an agent holds or asks for `browser:<site>` (the card links to it). The browser closes, ending the login, when no agent holds or asks for it, after 15 minutes without a command or live-view input, at its lifetime, when its setup changes, or when speaker stops.
- Chromium runs as its own OS user behind `browser-broker.ts`, a small HTTP server on 127.0.0.1 that only holds a bearer token; speaker makes every check. Speaker needs `BROWSER_BROKER_URL` and `BROWSER_BROKER_TOKEN` (32 characters or more); without them opening a site names the fix. The Docker image starts the broker itself, with a token made at each start unless `.env` sets one; `chrome-seccomp.json` is Docker's default profile plus `clone`, `unshare` and `setns`, so Chromium keeps its own sandbox.
- Without Docker, run the broker as a separate user on speaker's machine: `sudo -u <browser user> env BROWSER_BROKER_PORT=3100 BROWSER_BROKER_TOKEN=<token> AGENT_BROWSER_EXECUTABLE_PATH=<chromium> node browser-broker.ts`, and give speaker `BROWSER_BROKER_URL=http://127.0.0.1:3100` and the same token. There any local process can reach Chromium's debugging and stream ports, so a logged-in session is open to every program on the machine: when other agents share it, use the container.

## Agents

_AI-drafted_

Agents start at `$SPEAKER_URL/_speaker/help` (also `/`), served without a token: one document (`skill/SKILL.md`) with a one-screen top, then setup for sh and PowerShell, what to ask for, folders and SSH, secrets, browser sites, MCP servers and errors. It names no service, group, target or share. Commands in it use the address the caller used.

| Item | Grants | Who may ask |
| --- | --- | --- |
| `<service>.read`, `<service>.full` | reads, or everything (see Services); remote MCP servers are services too | any |
| `ssh:<target>`, `folder:<share>[:rw]` | commands as the target's account; a share, read-only unless `:rw` | any |
| `secret:<NAME>`, `browser:<site>` | the secret inserted for its hosts; a logged-in browser site | any |
| `site:<host>`, `site:*.<domain>` | network access from the VM | sandboxed |
| `mcp:<id>`, `ext:<id>` | an in-VM MCP server or Pi extension from bottle's catalog | sandboxed |
| `group:<name>` | every item in the group | any, if it may ask for all of them |

- **Enrolment.** The agent makes a random token, keeps it in a user-only header file (`curl -H @file`, so it stays off command lines) and sends only its SHA-256, a label, an agent string and a first request. `enroll.sh` does this. Each request carries a one-sentence `reason`. Sandboxed agents are created by their sandbox host instead.
- **Asking.** `POST /_speaker/requests` with `{"want":[…],"reason":"…","duration":"2h"}`, or just call a service with `Speaker-Wait`. `GET /_speaker/requests/<id>` watches a filed request. Posting the same items again joins the pending card. Durations: `30m`, `1h`, `2h` (default), `1d`, `30d`; the owner can also grant until revoked.
- **Seeing where it stands.** `GET /_speaker/catalog` lists services, groups, secrets (name, hosts, variable, state), browser sites, the agent's grants (`applying` until a sandbox host reports one in force) with exact SSH and folder commands, and its requests.
- **Errors** are JSON with `error`, `message`, and where useful `next` (the exact call to make, or "stop") and `tell_user` (one line with the approval link). An unknown name fails the whole request with 400 `invalid` before anything reaches the owner; an item that exists but cannot be delivered is `denied` at once and logged. All agent-facing text is written for a small model that follows steps literally.
- **Denials.** After three denials of the same item to the same agent within 15 minutes, speaker answers `denied` with `retry_after` without asking, for 15 minutes.

## The owner's side

_AI-drafted_

- **Inbox:** each request is a card naming the agent, its source address, "key" plus the first 8 characters of its token's fingerprint (two agents with the same name differ there), the reason and a duration. Every item has a checkbox, ticked by default; **Approve** grants what is ticked and denies the rest. Items that can change things (`.full`, `:rw`, `ssh:`) are tinted. Sandbox host registrations are cards too. Pending requests expire after 2 hours.
- **Active:** grants with **Extend** (one more span of the original length) and **Revoke**, SSH sessions with **End**, approved hosts, and per-agent counts (requests, granted, denied, refused, blocked; the last two turn red when non-zero). Counts reset on restart. Inbox and Active refresh every 5 seconds.
- **Setup** edits services, secrets, groups, targets, shares, browser sites and the password. **Log** shows recent audit lines.
- Scripted form posts need an `Origin` header matching `PUBLIC_URL`; sign-in answers `303` with the session cookie. Sign-in allows 5 failures per 15 minutes, so do not retry blindly.

### Owner API and the Herdr mod

A JSON API under `/admin/api` serves the Herdr mod. It uses the same decide and revoke code and audit lines as the forms.

| Route | Does |
| --- | --- |
| `POST /admin/api/signin` `{ "password" }` | `{ token, publicUrl }`; same check, rate limit and unlock as the form; the token lives in memory for 12 hours |
| `GET /admin/api/pending` | `{ pending: [card] }`, the Inbox's cards: `{ id, subject, type: "agent" \| "host", who, reason, duration, durations, want, items: [{ item, kind, text, reach, warning?, risk? }], createdAt }` |
| `GET /admin/api/active` | `{ grants: [{ id, who, item, expiresAt, text, reach, warning?, risk? }] }` |
| `POST /admin/api/requests/<id>/approve` `{ "duration": "2h" }` | approves every pending item on the card (`204`) |
| `POST /admin/api/requests/<id>/deny` | denies the card (`204`) |
| `POST /admin/api/grants/<id>/revoke` | ends the grant (`204`) |

Every route but sign-in takes only `Authorization: Bearer <token>`; the cookie is never accepted there and the token never as the cookie. Finer decisions (unticking items, Extend, Setup) stay in `/admin`.

**Installing the mod.** From the repository root: `ln -s "$PWD/herdr/mods/speaker" ~/.config/herdr-app/mods/speaker`, then `herdr-app check ~/.config/herdr-app/mods/speaker`. Its one-line bar shows only in a layout with a block for it, and Herdr's own layouts are read-only: `herdr-app do layout.clone '{"name":"main","as":"main-speaker"}'`, then add `{"id":"speaker","type":"block","size":{"px":26},"content":{"mod":"speaker"}}` after the `status` block in `~/.config/herdr-app/layouts/main-speaker.json`. For a key, add `"global": { "alt-s": "mod.open:speaker" }` to `~/.config/herdr-app/keys.json`. In the mod's Settings enter speaker's URL (a tailnet address that skips a reverse proxy's login works), bottle's control URL and, when bottle runs on another Herdr machine, that machine's name; then sign in once per Herdr start.

**Using it.** The bar polls every 10 seconds ("speaker · 2 waiting (oldest 4m)") and posts a toast per new request. The inbox shows each card with **Approve as asked**, **Deny** and **Open in browser** (always speaker's `PUBLIC_URL`, since the browser UI refuses sign-ins from other addresses); bottle's open agents (**Stop**, click to focus its terminal); the last five finished agents (click to open the archive); **Start an agent** (a prompt, extra folders, one button per template and model; runs `bottle run -d` in the bottle space); and Active with **Revoke**. The token stays in the mod's memory, never on disk. `~/.config/herdr-app/speaker.log` holds its last 300 calls (address, status, error line; never a password, token or body). `herdr/mods/speaker-lite` is a trimmed reference variant (about 100 lines: bar, toasts, sign-in, approve and deny), not installed by default.

## Security model and design

_AI-drafted_

**Principles.** The owner grants everything: no agent, rule or timer creates or lengthens access, except reads of services the owner marked open. Agents never hold the owner's keys. Agents ask for the minimum, with a reason; groups make review easier, not access wider. One call should be enough: missing access waits for the owner, and every failure says what to do next. Limits are enforced by speaker or the sandbox host, not by configuration on each target. Only settings, encrypted keys and the append-only log reach disk; agents, grants, requests, sessions and counts live in memory, and after a restart agents ask again.

**Keys.** All values (service keys, secrets, speaker's SSH key, the proxy certificate authority) are sealed with one random data key (AES-256-GCM), wrapped by a key derived from the owner password (scrypt). Unwrapping is the password check, so no password hash is stored. Speaker starts **locked**: until the owner sets a password and signs in, agent, sandbox-host, proxy and certificate calls answer `503 locked` and `/admin` shows only sign-in. Values exist in clear only in memory. A copied disk or backup reveals none; a takeover of the running process can, which is why grants stay short and target accounts limited. Changing the password re-wraps the data key. A forgotten password means deleting `store.json` and entering every key again (and re-adding speaker's SSH key on targets); `config.json` holds no values and can be shared.

**Tokens and addresses.** Agent and sandbox-host tokens are random, stored as SHA-256 hashes and bound to the address they enrolled or registered from (the socket address, or the last `X-Forwarded-For` entry when the peer is `TRUSTED_PROXY`). Enrolment is unauthenticated but rate limited (20 per 15 minutes in total) and refuses malformed hashes and the empty token's hash. An agent stays valid while it holds a grant or called in the last 7 days. **Revoke agent** ends its token and grants; the token then answers `denied` ("stop"), and asking again takes a new token that reaches the owner as a new agent. On one laptop every local client shares one address, so binding protects against accidents and keeps a record, not against a hostile agent running as the owner.

**Approval.** Only `/admin`, behind the owner's sign-in (HttpOnly, SameSite=Strict session cookie, Secure over HTTPS) with same-origin checks (Fetch Metadata, or an `Origin` matching `PUBLIC_URL`); do not disable them or add wildcard origins. Network identity such as a tailnet login is never accepted as the owner, because agents on the owner's machines share it. Plain HTTP from another machine works, with a warning on the sign-in page. Card details from the agent are shown as claims; the source address and fingerprint are speaker's own. The Herdr mod holds its token in memory, so a direct agent running as the owner's user on that machine could read it.

**Grants and lifecycles.** Approvals, requests, grants and hosts each follow one explicit table with one `transition()` (`lifecycle.ts`). A grant exists only while in force; ending it ends any session or mount it allowed. After any Setup change, a pending or granted approval whose item is gone ends, and so does a grant whose reach grew beyond what the card showed: what approving opens (a secret's hosts, a service's URL and read paths, a target's account, a share's path) is stored with the grant. A speaker restart ends every grant, request and session.

**Sandbox hosts.** A host (bottle) registers unauthenticated, which only adds a pending card, and the owner approves it. Approving removes any older host with the same name and address, with its tokens and agents. Speaker keeps the host record but not its approval, so after a restart every host is a card again; bottle stops if it is not re-approved within 5 minutes. Per run the host creates an agent (the template's items become its first request), and speaker binds the agent's token to the host's address. The host holds a WebSocket, receives every grant and revocation, applies it in the VM and reports what is in force; silent for 30 seconds, it drops its agents' grants. An extension's sites end with the extension's grant unless the agent asked for them itself.

**What agents can see.** Anyone who can reach speaker can enrol, so lists shown to agents are shown to the whole network. Services needing a grant are listed; open services are not. Groups are listed with their items (folders and targets only as a count). Every secret is listed by name, hosts and variable: names reveal little, and the agent only ever holds a placeholder. Folders and SSH targets are never listed; names come from the owner or the task. Sandboxed agents also see the host's in-VM MCP servers and extensions.

**Proxy boundary.** Speaker keeps each request on the service's origin and under its base path. Before adding the credential it strips caller credentials, cookies, proxy identity and hop-by-hop headers. It streams replies, returns upstream redirects without following them, and redacts a key embedded in an upstream URL from replies and logs. It checks read or full access per call; it does not authorize individual paths or bodies.

**Limits.** Speaker cannot stop an agent misusing access it was granted, and revocation cannot undo completed operations or reliably cancel a request already forwarded. An agent with its own upstream credentials or a local vault mount bypasses speaker; remove those routes if speaker must control all access. Hence short grants, least-privilege upstream tokens, limited target accounts, everything logged and one-click revoke.
