<!-- author: ai -->

# speaker

<sub>AI-written</sub>

speaker-for-the-creds is the approval and credential service. Agents enroll, ask for items, and
the owner approves each request from a phone page. Sandbox hosts such as bottle-school apply its sandbox grants.
{.ai}

<!-- author: ai -->

## Run locally

<sub>AI-written</sub>

```sh
mise trust && mise install
cp .env.example .env   # set ADMIN_PASSWORD
chmod 600 .env
mise run install
mise run speaker
```

Open `http://localhost:3000/admin` and sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.
{.ai}

<!-- author: ai -->
<!-- author: ai -->

## How it works

<sub>AI-written</sub>

The design is in [DESIGN.md](DESIGN.md); [USECASES.md](USECASES.md) walks the flows.

- Who asks:
  - An agent enrolls itself with `POST /_speaker/agents` (its token's hash, a label, its identity and, optionally, a first request). It needs no approval of its own; it can do nothing but read open services until the owner grants something.
  - A sandbox host registers with `POST /_speaker/hosts`; the owner approves it in `/admin`. It then creates one agent per task with `POST /_speaker/hosts/agents`, which returns the agent's token, bound to the sandbox host's address.
  - The two unauthenticated routes share a budget of 20 calls per 15 minutes and then answer `rate_limited` (429).
- What is asked: an item is a string: `<service>.read`, `<service>.full`, `site:<host>`, `secret:<NAME>`, `folder:<share>[:rw]`, `mcp:<id>`, `ext:<id>` or `group:<name>`. A request is `{"want":[…],"reason":"…","duration":"2h"}` (durations `30m`, `1h`, `2h`, `1d`, `30d`).
  - Direct agents may ask for service items and groups whose items are all service items. A sandboxed agent may also ask for the item kinds its sandbox host declared at registration.
- What is decided: the owner approves the items on the request when acting (the approve call may list a subset; the rest are denied). Each granted item becomes one grant, replacing an earlier grant of the same item. The answer is per item: `{"granted":[…],"denied":[…],"expiresAt":…}`. Only the owner picks "until revoked".
- Requests, grants and sandbox hosts move through explicit state tables in [lifecycle.ts](lifecycle.ts). A request is `pending`, then `decided` (or `expired` after 2 hours); a grant is `active`, then `expired` or `revoked`.
- State: services (with rules, notes and POST read paths), groups and sandbox hosts are stored in `DATA_DIR`, with the existing key files in `DATA_DIR/secrets`. Agents, grants, requests and usage counters live in memory only: after a restart agents enroll and ask again. The log goes to standard output and into an in-memory buffer that the admin Log page shows.
- Speaker enforces service items in its proxy. Sandbox hosts apply the other kinds from the `/_speaker/hosts/ws` snapshots, and `/admin` shows each such grant as granted or active.
- Waiting: the `Speaker-Wait: <seconds>` header (at most 120) on a service call, `POST /_speaker/requests` or `POST /_speaker/agents` holds the call until the owner decides. Without it every call answers at once. Any reverse proxy must allow requests that long.
- Errors are JSON with `error` (`enroll`, `approval_required`, `denied`, `invalid`, `rate_limited`), and where useful `next` and `tell_user`. `GET /_speaker/me` shows an agent where it stands.

<!-- author: ai -->

## Services

<sub>AI-written</sub>

The service name replaces the configured API base:
{.ai}

```text
/obsidian/vault/note.md  → https://notes.example.com/api/vault/note.md
/karakeep/bookmarks     → https://bookmarks.example.com/api/v1/bookmarks
```

- Edit a service in `/admin` and enter its key. Saved keys are never shown again. For Basic auth, enter
  `username:password`.
- Each service has a read rule and a write rule. Read is `ask` (default), `open` or `never`; write is `ask` or `never`. `open` lets any enrolled agent read without a grant or a card; open services are never listed to agents, and anyone who can reach speaker can enroll, so use it only for harmless state. `never` is answered `denied` at once.
- `<service>.read` covers GET, HEAD and OPTIONS, plus POST to the read paths listed on the service (for example a search endpoint). `<service>.full` covers everything, and includes read.
- `GET /_speaker/help/<service>` gives an agent the service's notes and its own current state.
- Auth type `path` stores a secret URL segment, such as a webhook id, and inserts it after the base URL (`/hook/x` → `<baseUrl>/<secret>/x`). Logs record only the agent-facing path.
- Tick "MCP server" for a streamable-HTTP MCP service. Speaker classifies each POST: protocol housekeeping, tool listing and tools annotated `readOnlyHint: true` are reads; any other tool call needs full, and approval cards mark destructive tools. "Refresh tools" lists the tools and shows how they classify.
- The `demo` service allows open reads and requires a grant for writes. `/demo/check` answers
  `"credential":"accepted"` without exposing the fake key.

A call without access answers `approval_required` with the request's id; with `Speaker-Wait` it waits for the owner's decision and is forwarded once granted. The call files a request for exactly that service's `.read` or `.full`.
{.ai}

<!-- author: ai -->

## Who receives service credentials

<sub>AI-written</sub>

| Service auth type | Stored by | Receives the real credential |
| --- | --- | --- |
| Bearer | Speaker in `/data/secrets` | The configured upstream API, in `Authorization: Bearer …` |
| Basic | Speaker in `/data/secrets` as `username:password` | The configured upstream API, encoded in `Authorization: Basic …` |
| Custom header | Speaker in `/data/secrets`; the header name is service configuration | The configured upstream API, in that header |

Speaker keeps these values on its host-side data volume and injects them only when forwarding a granted
service request. It strips the agent's authorization and cookie headers first. Agents receive a Speaker
token, not the upstream credential. The upstream API still receives the real credential
and the request data. `ADMIN_PASSWORD` is only for Speaker's owner UI; `NTFY_TOKEN`, if configured, is sent
to the configured notification service.
{.ai}

<!-- author: ai -->

## Groups

<sub>AI-written</sub>

Define groups in `DATA_DIR/groups.json` as `{ "<name>": { "description": "<one line>", "items": ["<item>", …] } }`. The description is optional. Copy
[groups.example.json](groups.example.json) to start. Restart speaker after editing the file by hand; the `/admin`
Groups page edits it live. A group may hold any items except other groups.
A request names the group and the owner approves it with the group's items. An agent is offered (in `GET /_speaker/me`) and may request a group only if it may request every item in it, so direct agents never see groups with `site:`, `secret:`, `mcp:` or `ext:` items.
{.ai}


## Phone notifications

<sub>AI-written</sub>

```dotenv
PUBLIC_URL=https://speaker.example.com
NTFY_URL=https://your-ntfy-server.example
NTFY_TOPIC=speaker-approvals
NTFY_TOKEN=your-publish-token
```

- Speaker sends one ntfy push for each new sandbox host and request. Pushes carry labels and a link to
  `/admin`, with no keys and no approval authority.
- Set `NTFY_URL` and `NTFY_TOPIC` together. The token is optional.
- `/admin` refreshes every 5 seconds while visible. Pending requests expire after 15 minutes.
- Self-hosted ntfy needs its [upstream push relay](https://docs.ntfy.sh/config/#ios-instant-notifications)
  for instant iOS delivery.

<!-- author: ai -->

## Docker / home-server deployment

<sub>AI-written</sub>

Run from `speaker/`. The included Compose file builds the image, binds port 3000 to host loopback, and stores state in a named volume.
{.ai}

```sh
cp .env.example .env
chmod 600 .env
# Edit .env: set ADMIN_PASSWORD and PUBLIC_URL before starting.
docker compose config --quiet
docker compose up --build -d
docker compose logs --tail=100 speaker
```

For local access, use `PUBLIC_URL=http://localhost:3000` and open `http://localhost:3000/admin`. For a reverse proxy, set `PUBLIC_URL` to the exact URL you open in the browser, including `https://` and any nonstandard port. For example, `https://speaker.example.com`. Recreate the container after changing environment settings with `docker compose up -d --force-recreate`; a plain restart does not reload them.
{.ai}

- Configure your own proxy to forward to speaker and serve HTTPS. The sample binds loopback; a containerized proxy needs a shared Docker network or another explicitly configured route. The public example does not configure a proxy or external login service.
- Browser saves use same-origin Fetch Metadata, so HTTPS termination at a proxy does not cause false cross-origin rejections. Clients without that header must send an Origin matching PUBLIC_URL for form submissions. Cross-origin browser form and JSON writes remain blocked; do not disable CSRF checks or add wildcard origins.
- Run one replica. Services, groups, sandbox hosts and key files persist in `/data`. Agents, grants and requests live in memory: a restart ends all of them and agents enroll and ask again.
- Keep the data volume outside the agents' filesystem access. Secret files are owner-only, not encrypted. Back up that volume.
- The admin page uses speaker's own Basic authentication. Agent API routes use bearer tokens. If you add external login middleware, apply it to `/admin` and its child paths so agents can still use their API tokens.

<!-- author: ai -->

## SSH certificates

_AI-drafted_

Speaker can act as an SSH user certificate authority, replacing hand-made ControlMaster sockets. An agent makes a throwaway keypair and asks for `user@host` for a short time. The owner approves it in `/admin` like any request. Speaker then signs an OpenSSH user certificate with OpenSSH's own `ssh-keygen -s`, so the agent connects with plain `ssh` until the certificate expires. The private key never leaves the agent; the CA key never leaves speaker.

- Each certificate carries one principal, `<user>@<host alias>`, so a certificate for one host does not open another. It is valid from one minute before approval until the approved duration ends, and never longer than `SSH_MAX_DURATION` (default `1h`).
- Certificates permit a PTY only. Agent and port forwarding are added only when the request asks and the owner approves it. A request may pin `sourceAddress` (comma-separated addresses or CIDR blocks).
- Speaker cannot revoke an issued certificate early; keep durations short. Each issuance is logged as `ssh_certificate_issued` with principal, key fingerprint, options and expiry.

Enable it with a CA keypair, a host list, and `SSH_CA_KEY`. Speaker refuses to start if the key or `ssh-hosts.json` is missing, unreadable, or too permissive for `ssh-keygen`.

```sh
mise run ssh-ca                       # writes speaker/data/ssh_ca and prints the public key
# Docker: docker compose run --rm speaker ssh-keygen -q -t ed25519 -N '' -C speaker-ssh-ca -f /data/ssh_ca
```

```json
// DATA_DIR/ssh-hosts.json: alias -> host and the login users an agent may ask for
{ "nas": { "hostname": "nas.lan", "port": 22, "users": ["raist"] } }
```

One-time setup on each target host. The principals file names which certificate principals may log in as that user; normal `authorized_keys` logins keep working.

```sh
curl -fsS https://speaker.example.com/_speaker/ssh/ca.pub | sudo tee /etc/ssh/speaker_user_ca.pub
sudo install -d -m 755 /etc/ssh/auth_principals
echo 'raist@nas' | sudo tee /etc/ssh/auth_principals/raist
printf '%s\n' 'TrustedUserCAKeys /etc/ssh/speaker_user_ca.pub' \
  'AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u' | sudo tee /etc/ssh/sshd_config.d/50-speaker-ca.conf
sudo sshd -t && sudo systemctl reload ssh   # the unit is sshd on some distributions
```

Agents follow the SSH section of [the skill](skill/SKILL.md): `GET /_speaker/ssh/hosts`, `POST /_speaker/ssh` with `{host, user, publicKey, reason, duration}`, with the `Speaker-Wait` header; the reply carries the `certificate` once you approve (it also appears in `GET /_speaker/me`).

<!-- author: ai -->

## Agent access

<sub>AI-written</sub>

Give agents the public setup guide at `https://your-speaker-host/skill.md`; it is served without authentication
so a new agent can bootstrap. It is short: inline sh and PowerShell setup (a token kept in a curl header file,
nothing to install), the call form, and `/_speaker/help` (one page, served without a token) for the rest. `/` says the same in three lines; services, rules and groups
stay behind auth. Commands in these pages use the address the caller used to reach speaker. Keep `/admin` protected.
{.ai}

- A call sent with `Speaker-Wait: 60` (and `Speaker-Reason`) waits for your decision and is forwarded once granted.
- Every agent error carries a `next` step, and where an approval is needed a `tell_user` line with the approval link.
- An agent works only from the address it enrolled from: the socket address. Behind a reverse proxy, set
  `TRUSTED_PROXY` to the proxy's IP; speaker then takes the last `X-Forwarded-For` entry from it and ignores that
  header from every other sender.
- Only you extend access: Extend on a grant adds the span you originally granted.
- A request denied three times (same agent, same item) within 15 minutes is answered as denied without asking
  you again until 15 minutes after the third denial.
{.ai}

<!-- author: ai -->

## Checks

<sub>AI-written</sub>

```sh
mise run check
mise run test
```

<!-- author: ai -->

## Proxy boundary

<sub>AI-written</sub>

Speaker keeps each request on the configured upstream origin and inside its base path. It strips caller credentials, cookies, proxy identity, and hop-by-hop headers before injecting the service credential. Speaker streams responses and returns upstream redirects without following them. The proxy checks read or full access on each call; it does not authorize individual paths or request bodies.
{.ai}

An agent with direct upstream credentials or a local vault mount can bypass speaker. The owner must remove those routes when speaker must control all access. Revocation blocks subsequent proxy calls; it cannot undo completed operations or guarantee cancellation of a forwarded request.
{.ai}
