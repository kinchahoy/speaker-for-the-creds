<!-- author: ai -->

# speaker

<sub>AI-written</sub>

Speaker holds your keys. Agents enroll and ask for items, and you approve each request from a phone page. Sandbox hosts such as bottle-school apply the sandbox grants.
{.ai}

[DESIGN.md](DESIGN.md) has the details; [USECASES.md](USECASES.md) walks through the flows.
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

The other flags are `--port`, `--proxy-port`, `--ssh-port`, `--public-url`, `--trusted-proxy`, `--start`, `--no-start`, `--env-path`, and `--force`. On a separate sandbox machine, run `mise run init bottle-school` afterward.
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

Speaker keeps these values encrypted on its data volume, decrypts them in memory after you sign in, and injects them only when it forwards a granted request. Agents receive a speaker token, never the upstream credential. The upstream API receives the real credential and the request data. If you set `NTFY_TOKEN`, speaker sends it to the notification service.
{.ai}

<!-- author: ai -->

## Keys and sign-in

<sub>AI-written</sub>

All service keys, secrets, and speaker's SSH key live in one file, `DATA_DIR/store.json`. A random data key seals each secret (AES-256-GCM). A key derived from the owner password (scrypt) wraps the data key. Unwrapping the data key is the password check, so speaker stores no password hash. Clear values exist only in memory after sign-in.
{.ai}

- `mise run init speaker` sets the owner password. Without it, the first visit to `/admin` does. Sign-in uses a session cookie (HttpOnly, SameSite=Strict, Secure over HTTPS) and is rate limited: sign-in allows 5 failed attempts per 15 minutes. Plain HTTP from another machine works, but the sign-in page warns that the password crosses the network unencrypted.
- In scripts, form posts to `/admin` (sign-in, approvals) need an `Origin` header matching the URL, such as `Origin: http://192.168.1.10:3000`. A successful sign-in answers `303` with the session cookie to send on later posts. Do not retry a failed sign-in blindly: after 5 failures speaker refuses for 15 minutes.
- When a store exists, speaker starts locked. Agent and sandbox-host calls answer `503` `locked` with a `tell_user` line. `/admin` shows only sign-in. If ntfy is set, one push asks you to sign in. Signing in unlocks.
- Setup lists Secrets: a name, a value (write-only), the allowed hosts, and the environment variable the agent sees. Speaker inserts them through its HTTPS proxy (see Secrets proxy).
- Change the password in Setup. This re-wraps the data key. If you forget it, delete `store.json`: speaker resets, and you re-enter every key.
- Upgrading: when you set the password, speaker imports plaintext key files from earlier versions (`DATA_DIR/secrets/`) into the store and deletes them.

<!-- author: ai -->

## Secrets proxy

<sub>AI-written</sub>

Set `PROXY_PORT` to turn on speaker's HTTPS proxy. It is off when unset. Publish the port next to `PORT`.
{.ai}

An agent holding `secret:<NAME>` sends HTTPS through the proxy with `CONNECT`. It authenticates with its speaker token as the proxy password: `http://agent:<token>@<speaker>:<PROXY_PORT>`. curl, `gh`, and `git` send it as Basic credentials.
{.ai}

For a host the secret's Setup entry allows, speaker terminates TLS with its own certificate authority. (`*.domain` covers subdomains only.) It replaces the agent's placeholder with the real value in the `Authorization` header only, including inside HTTP Basic credentials, which is how `git` sends it. Then it forwards the request to the real host over TLS.
{.ai}

Every other host gets `403` and a one-line message. This is not a general proxy. Speaker checks grants on every request, so a revoke or expiry answers `403` at once, even in an open tunnel.
{.ai}

- Speaker makes the certificate authority at first need, keeps it in the encrypted store, and serves it at `GET /_speaker/proxy/ca.pem`. It makes leaf certificates per host and caches them in memory. Agents trust the authority for the proxy only.
- Each agent gets one random placeholder per secret, held in memory. For each secret grant, `GET /_speaker/me` shows the variable with its placeholder, `HTTPS_PROXY`, where to fetch the certificate, `SSL_CERT_FILE` for `gh` (`GIT_SSL_CAINFO` or `http.sslCAInfo` for `git`), the allowed hosts, and the `gh auth setup-git` hint.
- Set those variables on the one command that needs them, not on the whole shell. The proxy refuses every other host.
- The log records agent, host, method, path (no query), and status. It never records the token or bodies.
- `site:` items stay sandbox-only. Direct agents can use `secret:` items when `PROXY_PORT` is set.

<!-- author: ai -->

## Groups

<sub>AI-written</sub>

Define groups in `DATA_DIR/groups.json`:
{.ai}

```json
{ "<name>": { "description": "<one line>", "items": ["<item>", "…"] } }
```

The description is optional. A group may hold any items except other groups. Copy [groups.example.json](groups.example.json) to start. The `/admin` Groups page edits the file live. If you edit it by hand, restart speaker.
{.ai}

A request names the group, and you approve it with the group's items. `GET /_speaker/me` offers an agent a group, and the agent may request it, only if the agent may request every item in it. So direct agents never see groups with `site:`, `mcp:`, or `ext:` items, or with `secret:` items unless `PROXY_PORT` is set.
{.ai}

## Phone notifications

<sub>AI-written</sub>

```dotenv
PUBLIC_URL=https://speaker.example.com
NTFY_URL=https://your-ntfy-server.example
NTFY_TOPIC=speaker-approvals
NTFY_TOKEN=your-publish-token
```

- Speaker sends one ntfy push for each new sandbox host and request. A push carries labels and a link to `/admin`. It holds no keys and gives no approval authority.
- Set `NTFY_URL` and `NTFY_TOPIC` together. The token is optional.
- The Inbox and Active panels in `/admin` refresh every 5 seconds. Pending requests expire after 2 hours.
- Self-hosted ntfy needs its [upstream push relay](https://docs.ntfy.sh/config/#ios-instant-notifications) for instant iOS delivery.

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

For local access, use `PUBLIC_URL=http://localhost:3000` and open `http://localhost:3000/admin`. Behind a reverse proxy, set `PUBLIC_URL` to the exact URL you open in the browser, including `https://` and any nonstandard port, for example `https://speaker.example.com`. After you change environment settings, recreate the container with `docker compose up -d --force-recreate`. A plain restart does not reload them.
{.ai}

- Bring your own proxy: it forwards to speaker and serves HTTPS. Raise its timeout above 120 s, because speaker holds requests for up to 120 s. The sample binds loopback, so a containerized proxy needs a shared Docker network or another explicit route. The public example configures no proxy or external login service.
- Browser saves use same-origin Fetch Metadata, so HTTPS termination at a proxy does not cause false cross-origin rejections. Clients without that header must send an Origin matching `PUBLIC_URL` for form submissions. Speaker blocks cross-origin browser form and JSON writes. Do not disable CSRF checks or add wildcard origins.
- Run one replica. `/data` persists services, groups, sandbox hosts, and the encrypted store. Agents, grants, and requests live in memory. A restart ends them, and agents enroll and ask again.
- Keep the data volume outside the agents' filesystem access. Keys are encrypted at rest, so a copied volume or backup reveals none. Keep the owner password safe: without it, nobody can read the keys, and you re-enter every key.
- The admin page uses speaker's own sign-in (a session cookie). Agent API routes use bearer tokens. If you add external login middleware, apply it to `/admin` and its child paths so agents can still use their tokens.

<!-- author: ai -->

## SSH and folders

<sub>AI-written</sub>

Agents run commands on your hosts and use your folders through a jump server inside speaker's container. Speaker listens on `SSH_PORT` only while an SSH or over-SSH folder grant is active. It hands each connection to a stock, non-root `sshd -i` with a new host key each time it starts. The relay (`relay.ts`) is each session's forced command. Set `SSH_PORT` to turn this on. Without it, speaker answers `ssh:` and `folder:` items with `denied`. [DESIGN.md](DESIGN.md#ssh-and-shares-how-speaker-controls-them) explains how the relay controls sessions and folders.

- Targets (Setup): an alias, a host, a port, and the account speaker uses there. Adding a target pins its host key (`ssh-keyscan`), refuses `root` unless you confirm, warns when `sudo -n true` works, and probes the target's `sftp-server`. Setup shows speaker's public key and the line to add to that account's `authorized_keys`: `from="<speaker's address>",restrict ssh-ed25519 AAAA… speaker`. Add the line first. You can edit the address list per target.
- Shares (Setup): a name, a target, an absolute path, and how to deliver it (`VM mount`, `over SSH`, or both). Cards show the account (and any sudo warning) for `ssh:<target>`. For `folder:<share>[:rw]` they show the share, whether it is read-only or read-write, and the delivery.
- Agents send one throwaway public key (`sshKey`) and ask for `ssh:<target>` or `folder:<share>[:rw]`. Speaker answers unknown names, and items it cannot deliver, with `denied` at once and logs them. After approval, `GET /_speaker/me` lists complete command lines (with `-p`, `IdentitiesOnly`, `BatchMode`, and the jump server's host key): `ssh … <command>` for commands, and `sshfs`, `scp`, and `sftp` for folders. The login name in them is the account speaker runs as.
- For an `ssh:` grant, `scp` and `sftp` paths are `<target>/<absolute path on the target>`. Speaker refuses `rsync`, legacy `scp -O`, and commands on a folder grant, with a pointer to `sftp`.
- The Active page lists open sessions with **End**. Ending a grant, revoking it, or restarting speaker ends its sessions.
- Container: the image has `openssh-server` and `openssh-client`, and `compose.yaml` publishes `SSH_PORT` (default 2222). The SSH port does not go through a web reverse proxy; open it separately. Speaker's SSH key lives encrypted in the store, and in clear only in memory inside `ssh-agent`. The jump server's files (public keys, its per-start host key, the ssh-agent socket) sit in a private temporary directory.

<!-- author: ai -->

## Agent access

<sub>AI-written</sub>

Give agents the setup guide at `https://your-speaker-host/skill.md`. Speaker serves it without authentication so a new agent can bootstrap. It is short: the call form, and a pointer to `/_speaker/help` for everything else, including the sh and PowerShell setup (a token kept in a curl header file, nothing to install). `/_speaker/help` is one page, also served without a token. `/` serves the same skill to agents. Services, rules, and groups stay behind auth. Commands in these pages use the address the caller used to reach speaker. Keep `/admin` protected.
{.ai}

- Every agent error carries a `next` step. Where an approval is needed, it also carries a `tell_user` line with the approval link.
- An agent works only from the address it enrolled from: the socket address. Behind a reverse proxy, set `TRUSTED_PROXY` to the proxy's IP. Speaker then takes the last `X-Forwarded-For` entry from it and ignores that header from every other sender.
- Only you extend access. Extend on a grant adds the span you originally granted.
- If you deny the same item to the same agent three times within 15 minutes, speaker answers further requests as denied without asking you, until 15 minutes after the third denial.

<!-- author: ai -->

## Proxy boundary

<sub>AI-written</sub>

Speaker keeps each request on the configured upstream origin and inside its base path. Before it injects the service credential, it strips caller credentials, cookies, proxy identity, and hop-by-hop headers. It streams responses and returns upstream redirects without following them. It checks read or full access on each call. It does not authorize individual paths or request bodies.
{.ai}

An agent with direct upstream credentials or a local vault mount can bypass speaker. If speaker must control all access, remove those routes. Revocation blocks later proxy calls. It cannot undo completed operations, and it cannot guarantee cancellation of a request already forwarded.
{.ai}
