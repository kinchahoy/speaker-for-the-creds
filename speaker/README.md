<!-- author: ai -->

# speaker

<sub>AI-written</sub>

Reference for running and configuring speaker. For what speaker is for and how it fits with bottle, see the [top-level README](../README.md). For the design and its rationale, see [DESIGN.md](DESIGN.md).
{.ai}

<!-- author: ai -->

## Running locally

<sub>AI-written</sub>

```sh
mise trust && mise install
mise run init speaker
```

Run this on the machine that hosts speaker. It asks its questions, creates the encrypted store, writes `speaker/.env`, and offers to start speaker. If it starts speaker, it signs in once with the password you typed, so speaker is unlocked (the password stays in memory only). Speaker keeps its data in `~/.local/share/speaker` by default. The web, secrets-proxy, and SSH ports default to 3000, 3128, and 2222, and each must be free. Agents and VMs need an address for this machine. They cannot use `127.0.0.1`, because inside a VM that is the VM itself, so `init` offers the machine's LAN address. Every question has a flag, so it also runs unattended. `init` needs a real terminal for its prompts; scripts use `--yes` and flags, and `mise run init speaker -- --help` lists them:
{.ai}

```sh
printf '%s\n' "$PASSWORD" | mise run init speaker --yes --password-stdin --data-dir DIR --address IP
```

The other flags are `--port`, `--proxy-port`, `--ssh-port`, `--public-url`, `--trusted-proxy`, `--start`, `--no-start`, `--env-path`, and `--force`. On a separate sandbox machine, run `mise run init bottle` afterward.
{.ai}

Open `PUBLIC_URL/admin` and sign in with the password you chose. You sign in again after every restart, which unlocks the stored keys (see Keys and sign-in). Start speaker later with `mise run speaker`.
{.ai}

<!-- author: ai -->

## Services

<sub>AI-written</sub>

A request to speaker swaps the service name for the service's configured API base:
{.ai}

```text
/obsidian/vault/note.md  → https://notes.example.com/api/vault/note.md
/karakeep/bookmarks     → https://bookmarks.example.com/api/v1/bookmarks
```

- Edit a service in `/admin` and enter its key. Speaker never shows a saved key again. For Basic auth, enter `username:password`.
- Each service has a read rule and a write rule. Read is `ask` (the default), `open`, or `never`. Write is `ask` or `never`. Speaker answers `never` with `denied` at once. `open` lets any enrolled agent read without a grant or a card. Anyone who can reach speaker can enroll, so use `open` only for harmless state. Speaker never lists open services to agents.
- `<service>.read` covers GET, HEAD, and OPTIONS, plus POST to the read paths listed on the service (for example, a search endpoint). `<service>.full` covers everything, including read.
- `GET /_speaker/help/<service>` gives an agent the service's notes and its own current state.
- A scope is a service named `parent:name` (for example `obsidian:tasks`) that uses the key of its parent, which must hold its own key. Its address must be on the same site and under the parent's address, and it has its own read and write rules (add one with the plus icon on the parent's row in Setup). So one key, entered once, serves several narrow scopes; the parent can be set to never for both read and write so that it only holds the key. A base address can be a single endpoint: a call to `/<service>` reaches it exactly as written, and `/parent:name/...` reaches a scope. A service stored by an older version with a differently named parent keeps working.
- Auth type `path` stores a secret URL segment, such as a webhook ID, and inserts it after the base URL (`/hook/x` becomes `<baseUrl>/<secret>/x`). Logs record only the agent-facing path.
- Tick "MCP server" for a streamable-HTTP MCP service. Speaker classifies each POST. Protocol housekeeping, tool listing, and tools annotated `readOnlyHint: true` are reads. Any other tool call needs full, and approval cards mark destructive tools. "Refresh tools" lists the tools and shows how they classify.
- The `demo` service allows open reads and requires a grant for writes. `/demo/check` answers `"credential":"accepted"` without exposing the fake key.

A call without access answers `approval_required` with the request's ID, and files a request for exactly that service's `.read` or `.full`. With a `Speaker-Wait` header, the call waits for your decision and goes through once granted.
{.ai}

<!-- author: ai -->

## Who receives service credentials

<sub>AI-written</sub>

| Service auth type | Stored by | Receives the real credential |
| --- | --- | --- |
| Bearer | Speaker, in the encrypted store | The configured upstream API, in `Authorization: Bearer …` |
| Basic | Speaker, in the encrypted store, as `username:password` | The configured upstream API, encoded in `Authorization: Basic …` |
| Custom header | Speaker, in the encrypted store; the header name is service configuration | The configured upstream API, in that header |
| None | Nothing | Nothing: a keyless remote MCP server or API; speaker only gates and forwards |

Speaker keeps these values encrypted on its data volume, decrypts them in memory after you sign in, and injects them only when it forwards a granted request. Agents receive a speaker token, never the upstream credential. The upstream API receives the real credential and the request data.
{.ai}

<!-- author: ai -->

## Keys and sign-in

<sub>AI-written</sub>

Speaker keeps two files in `DATA_DIR`. `config.json` holds everything you set up except the values: services, groups, and each secret's name, allowed hosts and environment variable. It holds no key, so you can share it; another speaker that loads it answers `no_key` for each service until its owner adds the key, and offers a secret only once it has a value. Every value (service keys, secret values) and speaker's own SSH key and proxy certificate authority live in `store.json`. A random data key seals them (AES-256-GCM). A key derived from the owner password (scrypt) wraps the data key. Unwrapping the data key is the password check, so speaker stores no password hash. Clear values exist only in memory after sign-in.
{.ai}

- `mise run init speaker` sets the owner password. Without it, the first visit to `/admin` does. Sign-in uses a session cookie (HttpOnly, SameSite=Strict, Secure over HTTPS) and is rate limited: sign-in allows 5 failed attempts per 15 minutes. Plain HTTP from another machine works, but the sign-in page warns that the password crosses the network unencrypted.
- In scripts, form posts to `/admin` (sign-in, approvals) need an `Origin` header matching the URL, such as `Origin: http://192.168.1.10:3000`. A successful sign-in answers `303` with the session cookie to send on later posts. Do not retry a failed sign-in blindly: after 5 failures speaker refuses for 15 minutes.
- One lock rule: speaker serves agents, sandbox hosts, the secrets proxy and the proxy certificate only after you have set the owner password and signed in. Until then (first run, or after every restart) agent and sandbox-host calls answer `503` `locked` with a `next` and a `tell_user` line, and the proxy refuses. `/admin` shows only sign-in or the first-run password page. Signing in (the form or the owner API) unlocks.
- Setup lists Secrets: a name, a value (write-only), the allowed hosts, and the environment variable the agent sees. Speaker inserts them through its HTTPS proxy (see Secrets proxy). A name may use letters, digits, `_` and `-`. Tick Released instead to hand the agent the value itself (no hosts): that cannot be taken back once read. Turning an inserted secret into a released one needs the value typed again.
- Change the password in Setup. This re-wraps the data key. If you forget it, delete `store.json`: speaker resets, and you re-enter every key.

<!-- author: ai -->

## Secrets proxy

<sub>AI-written</sub>

Speaker's HTTPS proxy listens on `PROXY_PORT`, which is required. Publish the port next to `PORT`.
{.ai}

An agent holding `secret:<NAME>` sends HTTPS through the proxy with `CONNECT`. It authenticates with its speaker token as the proxy password: `http://agent:<token>@<speaker>:<PROXY_PORT>`. curl, `gh`, and `git` send it as Basic credentials.
{.ai}

For a host the secret's Setup entry allows, speaker terminates TLS with its own certificate authority. (`*.domain` covers subdomains only.) It replaces the agent's placeholder with the real value in the `Authorization` header only, including inside HTTP Basic credentials, which is how `git` sends it. Then it forwards the request to the real host over TLS.
{.ai}

Every other host gets `403` and a one-line message. This is not a general proxy. Speaker checks grants on every request, so a revoke or expiry answers `403` at once, even in an open tunnel.
{.ai}

- Speaker makes the certificate authority at first need, keeps it in the encrypted store, and serves it at `GET /_speaker/proxy/ca.pem`. It makes leaf certificates per host and caches them in memory. Agents trust the authority for the proxy only.
- Each agent gets one random placeholder per secret, held in memory. For each secret grant, `GET /_speaker/catalog` shows the variable with its placeholder, `HTTPS_PROXY`, where to fetch the certificate, `SSL_CERT_FILE` for `gh` (`GIT_SSL_CAINFO` or `http.sslCAInfo` for `git`), the allowed hosts, and the `gh auth setup-git` hint.
- Set those variables on the one command that needs them, not on the whole shell. The proxy refuses every other host.
- The log records agent, host, method, path (no query), and status. It never records the token or bodies.
- `site:` items stay sandbox-only. Direct agents can use `secret:` items.
- A released secret skips the proxy: after approval the agent reads the value with `GET /_speaker/secrets/<NAME>` and a live grant (`403` otherwise). Each read is the audit event `secret_released` (agent and name, never the value) and counts as a use of the grant. The card marks it "agent receives the value". Revoking or expiry stops further reads; it cannot take back a value already read, and the value will be in the agent's context (its transcripts, the model provider's logs, anything it writes).

<!-- author: ai -->

## Groups

<sub>AI-written</sub>

Define groups under `groups` in `DATA_DIR/config.json`:
{.ai}

```json
{ "<name>": { "description": "<one line>", "items": ["<item>", "…"] } }
```

The description is optional. A group may hold any items except other groups. [groups.example.json](groups.example.json) has examples. The `/admin` Groups page edits the file live. If you edit it by hand, restart speaker. (A speaker from before `config.json` moves its `services.json` and `groups.json` into it at start, and each secret's hosts and variable out of `store.json` at the first sign-in, keeping the old store as `store.json.bak`.)
{.ai}

A request names the group, and you approve it with the group's items. `GET /_speaker/catalog` offers an agent a group, and the agent may request it, only if the agent may request every item in it. So direct agents never see groups with `site:`, `mcp:`, or `ext:` items.
{.ai}

## Inbox and Active

<sub>AI-written</sub>

- Each agent in `/admin` Active has a line of counts (requests, granted, denied, refused, blocked). Refused (rejected before reaching you, such as an unknown name) and blocked (a call refused for lack of a grant) turn red when non-zero; hover for the latest message. Counts reset when speaker restarts.
- The Inbox and Active panels in `/admin` refresh every 5 seconds. Pending requests expire after 2 hours.
- A card names the agent, where it came from, and "key" followed by the first 8 characters of the fingerprint (hash) of its agent token. Two agents that call themselves the same thing have different keys, so use it to tell them apart.

<!-- author: ai -->

## Owner API and the Herdr mod

<sub>AI-written</sub>

A small JSON API under `/admin/api` lets the Herdr mod in `herdr/mods/speaker` review and decide requests. It calls the same decide and revoke code as the `/admin` forms and writes the same audit lines.
{.ai}

| Route | Does |
| --- | --- |
| `POST /admin/api/signin` `{ "password": "…" }` | `{ "token": "…", "publicUrl": "…" }`: the same password check, rate limit (5 failures per 15 minutes, shared with the form) and audit lines as the form; it unlocks speaker after a restart the same way. The token lives in speaker's in-memory session map for 12 hours. `publicUrl` is speaker's `PUBLIC_URL`, where the browser UI accepts sign-ins, so a client that reaches the API by another address (a tailnet port) still opens the right page. |
| `GET /admin/api/pending` | `{ pending: [card] }`, the same cards the Inbox shows, sandbox host registrations included: `{ id, subject, type: "agent" \| "host", who: { label, says?, via?, source, key?, at? }, reason, trigger?, duration, durations, want, items: [{ item, kind, text, reach, warning?, risk?, with? }], createdAt }` |
| `GET /admin/api/active` | `{ grants: [{ id, who, item, expiresAt, text, reach, warning?, risk? }] }`, a sandbox host's approval included (revoking it removes the host) |
| `POST /admin/api/requests/<id>/approve` `{ "duration": "2h" }` | approves every pending item on the card (`204`) |
| `POST /admin/api/requests/<id>/deny` | denies the card (`204`) |
| `POST /admin/api/grants/<id>/revoke` | ends the grant (`204`) |

- Every route except sign-in takes only `Authorization: Bearer <token>`. The session cookie is never accepted there, and an API token is never accepted as the cookie. Anything else answers `401` in speaker's error shape (`{ "error": "denied", "message": … }`).
- Finer decisions (unticking items, Extend, Setup, Log) stay in `/admin`. A sandbox host's registration is a card like any other, so the mod approves and denies it too.

The mod: link it in with `ln -s "$PWD/herdr/mods/speaker" ~/.config/herdr-app/mods/speaker` (from the repository root), then check it with `herdr-app check ~/.config/herdr-app/mods/speaker`. Its one-line bar (the part that polls and notifies; "speaker · set up" at first) shows only in a layout that has a block for it, and Herdr's own layouts are read-only, so clone one and add the block: `herdr-app do layout.clone '{"name":"main","as":"main-speaker"}'`, then in `~/.config/herdr-app/layouts/main-speaker.json` add `{"id":"speaker","type":"block","size":{"px":26},"content":{"mod":"speaker"}}` after the `status` block. Without that, only the inbox opened by its key works, and nothing announces a waiting request. Click it to open the inbox, enter speaker's URL, bottle's control URL and, when bottle runs on another Herdr machine (such as `wsl`), that machine's name under Settings (kept in Herdr's shared state, not in a file), and Save (Enter in any field saves too). Speaker's URL can be a tailnet address that skips a reverse proxy's login, such as `http://nuc.tailnet.ts.net:9110`. Then sign in with the owner password once per Herdr start (**Sign in** or Enter). **Open in browser** always goes to speaker's `PUBLIC_URL`, which the sign-in returns, because the browser UI refuses sign-ins from other addresses; until the mod has signed in, those buttons are dimmed. For debugging, the mod rewrites `~/.config/herdr-app/speaker.log` with its last 300 calls to speaker, bottle and programs: address, status or exit code, and the error line, never a password, token or response body. The token stays in the mod's memory, never on disk, and saving a different speaker URL drops it. The bar polls every 10 seconds ("speaker · 2 waiting (oldest 4m)", in the blocked colour from 5 minutes) and posts a toast for each new request; clicking the toast opens the inbox, which also polls every 10 seconds while it is open. Each card shows the agent, the items with any warning, the reason, a duration choice, **Approve as asked**, **Deny** and **Open in browser**. Below the cards are bottle's open agents (**Stop**; click a name to focus its terminal, click "waiting for approval" to highlight its request card), the last five finished agents (click one to open its archive folder in a new tab), a **Start an agent** section (an optional prompt and extra folders, then one button per model on each template; it runs `bottle run -d` in a terminal of the bottle space, so a slow cold start or an error stays visible), a short Active list with **Revoke**, and Settings. For a key, add `"global": { "alt-s": "mod.open:speaker" }` to `~/.config/herdr-app/keys.json`; it opens the inbox as an overlay (so does the command palette).
{.ai}

`herdr/mods/speaker` is the default mod. `herdr/mods/speaker-lite` is a trimmed variant kept for reference (about 100 lines: the bar, toasts, sign-in, and approve, deny or open each request; it reads the full mod's saved settings). It has no bottle agents, jump-to-terminal, Start an agent or Revoke, so it is not installed by default.
{.ai}

<!-- author: ai -->

## Docker and home-server deployment

<sub>AI-written</sub>

Run these from `speaker/`. The included Compose file builds the image, binds port 3000 to host loopback, and keeps state in a named volume. `mise run init speaker` is for running without Docker. It creates the store in a host directory, which Compose does not use. In Docker, you set the owner password on the first visit to `/admin`.
{.ai}

```sh
cp .env.example .env
chmod 600 .env
# Edit .env: set PUBLIC_URL before starting, then open /admin to set the owner password.
docker compose config --quiet
docker compose up --build -d
docker compose logs --tail=100 speaker
```

The image builds from the repository root (the pnpm workspace) and installs the newest release of each dependency. For exactly the tested set in `pnpm-lock.yaml`, build with `docker compose build --build-arg LOCKED=1`.

For local access, use `PUBLIC_URL=http://localhost:3000` and open `http://localhost:3000/admin`. Behind a reverse proxy, set `PUBLIC_URL` to the exact URL you open in the browser, including `https://` and any nonstandard port, for example `https://speaker.example.com`. After you change environment settings, recreate the container with `docker compose up -d --force-recreate`. A plain restart does not reload them.
{.ai}

- Bring your own proxy: it forwards to speaker and serves HTTPS. Raise its timeout above 120 s, because speaker holds requests for up to 120 s. The sample binds loopback, so a containerized proxy needs a shared Docker network or another explicit route. The public example configures no proxy or external login service.
- Browser saves use same-origin Fetch Metadata, so HTTPS termination at a proxy does not cause false cross-origin rejections. Clients without that header must send an Origin matching `PUBLIC_URL` for form submissions. Speaker blocks cross-origin browser form and JSON writes. Do not disable CSRF checks or add wildcard origins.
- Run one replica. `/data` persists services, groups, sandbox hosts, the encrypted store, and the log (`audit.jsonl`, append-only; rotate or delete it by hand). Agents, grants, and requests live in memory. A restart ends them, and agents enroll and ask again.
- Keep the data volume outside the agents' filesystem access. Keys are encrypted at rest, so a copied volume or backup reveals none. Keep the owner password safe: without it, nobody can read the keys, and you re-enter every key.
- The admin page uses speaker's own sign-in (a session cookie). Agent API routes use bearer tokens. If you add external login middleware, apply it to `/admin` and its child paths so agents can still use their tokens.

<!-- author: ai -->

## SSH and folders

<sub>AI-written</sub>

Agents run commands on your hosts and use your folders through a jump server inside speaker's container. Speaker listens on `SSH_PORT` only while an SSH or over-SSH folder grant is active. It hands each connection to a stock, non-root `sshd -i` with a new host key each time it starts. The relay (`relay.ts`) is each session's forced command. `SSH_PORT` is required. [DESIGN.md](DESIGN.md#ssh-and-shares-how-speaker-controls-them) explains how the relay controls sessions and folders.

- Targets (Setup): an alias, a host, a port, and the account speaker uses there. Adding a target pins its host key (`ssh-keyscan`), refuses `root` unless you confirm, warns when `sudo -n true` works, and probes the target's `sftp-server`. Setup shows speaker's public key and the line to add to that account's `authorized_keys`: `from="<speaker's address>",restrict ssh-ed25519 AAAA… speaker`. Add the line first. You can edit the address list per target.
- Shares (Setup): a name, a target, and an absolute path; every share arrives over SSH. A folder on speaker's own machine is a share on a target for that machine: `127.0.0.1` (or, with speaker in Docker, the host's address), with `sshd` and `sftp-server` running there and Setup's `authorized_keys` line added. Prefer a limited account for it, and grant only `folder:` items there: an `ssh:` grant on that target runs commands as that account. Cards show the account (and any sudo warning) for `ssh:<target>`. For `folder:<share>[:rw]` they show the share and whether it is read-only or read-write.
- Agents send one throwaway public key (`sshKey`) and ask for `ssh:<target>` or `folder:<share>[:rw]`. Speaker refuses an unknown name with 400 (`There is no folder named <share> that you can use.`, never listing real names) and creates no card; an item that exists but cannot be delivered is answered `denied` at once and logged. After approval, `GET /_speaker/catalog` lists complete command lines (with `-p`, `IdentitiesOnly`, `BatchMode`, and the jump server's host key): `ssh … <command>` for commands, and `sshfs`, `scp`, and `sftp` for folders. The login name in them is the account speaker runs as.
- For an `ssh:` grant, `scp` and `sftp` paths are `<target>/<absolute path on the target>`. Speaker refuses `rsync`, legacy `scp -O`, and commands on a folder grant, with a pointer to `sftp`.
- The Active page lists open sessions with **End**. Ending a grant, revoking it, or restarting speaker ends its sessions.
- Container: the image has `openssh-server` and `openssh-client`, and `compose.yaml` publishes `SSH_PORT`. The SSH port does not go through a web reverse proxy; open it separately. Speaker's SSH key lives encrypted in the store, and in clear only in memory inside `ssh-agent`. The jump server's files (public keys, its per-start host key, the ssh-agent socket) sit in a private temporary directory.

<!-- author: ai -->

## Browser sites

<sub>AI-written</sub>

A browser site is a website the owner signs in to by hand, for agents to use without seeing the login. Setup holds each site's name, start URL and the domains it may reach; list every domain the sign-in page loads from (CDNs too), since requests to any other are blocked. **Open** (with a lifetime of 1h, 8h or 1d) starts a headless Chromium for it and shows a live view where the owner clicks and types the login; pasting works for passwords. An agent asks for `browser:<site>` (ask on use, like a service) and sends allowlisted commands to `POST /_speaker/browser/<site>`: snapshot, click, fill, type, press, scroll, wait, open (only the site's domains), back, forward, reload, get, screenshot. Agents never get cookies, storage, JavaScript evaluation, uploads, downloads or the debugging port, and the log records each command without its arguments. Nothing persists: a login ends when the owner closes the site, its lifetime runs out, its setup changes, or speaker stops.
{.ai}

- Chromium runs as its own OS user behind `browser-broker.ts`, a small HTTP server on 127.0.0.1 that runs agent-browser for speaker. Speaker makes every check; the broker only holds the bearer token. Speaker needs `BROWSER_BROKER_URL` and `BROWSER_BROKER_TOKEN` (32 characters or more); without them Setup still lists sites, and opening one names the fix.
- Docker: the image has Chromium and starts the broker as `browser` and speaker as `node`, with a token made at each start unless `.env` sets one. `compose.yaml` adds `init`, the `SETUID` and `SETGID` capabilities the start script needs, and `chrome-seccomp.json` (Docker's default profile plus `clone`, `unshare` and `setns`, so Chromium keeps its own sandbox). Chromium adds about 740 MB to the image.
- Laptop: run the broker as a separate user, for example `sudo -u <browser user> env BROWSER_BROKER_PORT=3100 BROWSER_BROKER_TOKEN=<token> AGENT_BROWSER_EXECUTABLE_PATH=<chromium> node browser-broker.ts`, and give speaker `BROWSER_BROKER_URL=http://127.0.0.1:3100` and the same token. Speaker connects to the live view's stream port on 127.0.0.1, so the broker runs on speaker's machine. On a laptop any local process can reach Chromium's debugging and stream ports on 127.0.0.1, so a logged-in session is open to every program on the machine: when other agents share it, run speaker and the broker in the container.

<!-- author: ai -->

## Agent access

<sub>AI-written</sub>

Give agents the setup guide at `https://your-speaker-host/_speaker/help`. Speaker serves it without authentication so a new agent can bootstrap. It is one document: a top part that fits one screen (the call form, how to wait, where things are), then sections for setup (sh and PowerShell, a token kept in a curl header file, nothing to install), what an agent can ask for, asking, folders and SSH, secrets, remote MCP servers and errors. `/` serves the same document, also without a token. Services, rules, and groups stay behind auth, at `GET /_speaker/catalog`, which also lists every secret by name and state (never folders or SSH targets). Commands in these pages use the address the caller used to reach speaker. Keep `/admin` protected.
{.ai}

- Every agent error is JSON with `error` and a `message`, and carries a `next` step where one exists. Where an approval is needed, it also carries a `tell_user` line with the approval link.
- Registering a sandbox host again (same name, same address) leaves the old entry until you approve the new one; approving removes the old entry and its agents. Host cards show address and registration time, so stale entries are easy to spot.
- An extension's sites end with it: revoking or expiring `ext:<id>` ends the sites it brought, unless the agent asked for them itself.
- An agent works only from the address it enrolled from, and a sandbox host only from the address it registered from: the socket address. Behind a reverse proxy, set `TRUSTED_PROXY` to the proxy's IP, or to a name such as its Docker service name (`traefik`), which speaker looks up again every 30 seconds so it follows the container. Speaker then takes the last `X-Forwarded-For` entry from it and ignores that header from every other sender.
- Only you extend access. Extend on a grant adds the span you originally granted.
- If you deny the same item to the same agent three times within 15 minutes, speaker answers further requests as denied without asking you, until 15 minutes after the third denial.

<!-- author: ai -->

## Proxy boundary

<sub>AI-written</sub>

Speaker keeps each request on the configured upstream origin and inside its base path. Before it injects the service credential, it strips caller credentials, cookies, proxy identity, and hop-by-hop headers. It streams responses and returns upstream redirects without following them. It checks read or full access on each call. It does not authorize individual paths or request bodies.
{.ai}

An agent with direct upstream credentials or a local vault mount can bypass speaker. If speaker must control all access, remove those routes. Revocation blocks later proxy calls. It cannot undo completed operations, and it cannot guarantee cancellation of a request already forwarded.
{.ai}
