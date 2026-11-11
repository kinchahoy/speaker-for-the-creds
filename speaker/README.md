<!-- author: ai -->

# speaker

<sub>AI-written</sub>

speaker-for-the-creds is the approval and credential service. Agents enroll, request capabilities, and
the owner approves each request from a phone page. Enforcers such as bottle-school apply its sandbox leases.
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

## How it works

<sub>AI-written</sub>

- Identities:
  - An enforcer registers with `POST /_speaker/enforcers`. The owner approves it in `/admin`.
  - A big agent enrolls a session with `POST /_speaker/sessions`. The owner approves it with a duration.
  - An enforcer creates one subject per task with `POST /_speaker/subjects` and receives its token.
  - The two unauthenticated enrollment routes share a budget of 20 calls per 15 minutes and then return `429`.
- Requests, sessions, and enforcers move through explicit state tables in [lifecycle.ts](lifecycle.ts). A request is
  `pending`, then `approved`, `denied`, or `expired`; an approval later ends as `expired`, `revoked`, or `superseded`.
- Capabilities have a kind: `credential`, `secret`, `site`, `folder`, `mcp`, or `extension` (a sandbox's
  catalog Pi extension, such as `pi-web-access`).
  - A session may request only `credential`.
  - A subject may request `credential` plus its enforcer's kinds. Other kinds return `400 unsupported_kind`.
  - An enforcer declares its kinds when it registers, and they do not change afterwards. To add a kind, register
    the enforcer again, approve the new registration, and revoke the old one in `/admin`.
- Requests name one capability or one bundle. The owner approves with a duration and speaker creates one lease
  per member. Only the owner may choose `permanent`.
- Speaker keeps permanent leases on disk and temporary leases in memory.
- Speaker enforces `credential` leases in its proxy. Enforcers apply the other kinds from the
  `/_speaker/enforcers/ws` snapshots, and `/admin` shows each lease as granted or active.

<!-- author: ai -->

## Providers

<sub>AI-written</sub>

The provider prefix replaces the configured API base:
{.ai}

```text
/obsidian/vault/note.md  → https://notes.example.com/api/vault/note.md
/karakeep/bookmarks     → https://bookmarks.example.com/api/v1/bookmarks
```

- Edit a provider in `/admin` and enter its key. Saved keys are never shown again. For Basic auth, enter
  `username:password`.
- Each provider has a read and a write policy: `approval`, `always`, or `deny`. `deny` overrides leases.
- `always` lets an approved session use the provider without a request for at most 90 days after the session's approval; after that the rule acts as `approval`. The session approval card lists the providers it can read this way.
- `GET /_speaker/providers/<name>/guide` serves every provider a short generated guide for the caller (how to call it, current read/write access and expiry in UTC), followed by the provider's own markdown `guide` when it has one.
- Auth type `path` stores a secret URL segment, such as a webhook id, and inserts it after the base URL (`/hook/x` → `<baseUrl>/<secret>/x`). Logs record only the agent-facing path.
- Tick "MCP server" for a streamable-HTTP MCP provider. Speaker classifies each POST: protocol housekeeping, tool listing and tools annotated `readOnlyHint: true` are reads; any other tool call is a write, and approval cards mark destructive tools. "Refresh tools" lists the tools and shows how they classify.
- `PUBLIC_PROVIDERS=1` lets `GET /_speaker/providers` answer without a token (names, auth type and policy only). It is off by default.
- The `demo` provider allows reads and requires a lease for writes. `/demo/check` answers
  `"credential":"accepted"` without exposing the fake key.

A blocked call returns `403 approval_required` with a `requestId`. Speaker creates the request for the calling
session or subject. The caller may add a reason with `POST /_speaker/requests` for the same capability.
{.ai}

<!-- author: ai -->

## Who receives provider credentials

<sub>AI-written</sub>

| Provider auth type | Stored by | Receives the real credential |
| --- | --- | --- |
| Bearer | Speaker in `/data/secrets` | The configured upstream API, in `Authorization: Bearer …` |
| Basic | Speaker in `/data/secrets` as `username:password` | The configured upstream API, encoded in `Authorization: Basic …` |
| Custom header | Speaker in `/data/secrets`; the header name is provider configuration | The configured upstream API, in that header |

Speaker keeps these values on its host-side data volume and injects them only when forwarding an approved
provider request. It strips the agent's authorization and cookie headers first. Agents receive a Speaker
session or subject token, not the upstream credential. The upstream API still receives the real credential
and the request data. `ADMIN_PASSWORD` is only for Speaker's owner UI; `NTFY_TOKEN`, if configured, is sent
to the configured notification service.
{.ai}

<!-- author: ai -->

## Bundles

<sub>AI-written</sub>

Define bundles in `DATA_DIR/bundles.json` as `{ "<name>": { "description": "<one line>", "members": [{ "kind", "ref" }] } }`.
The description is optional, and the older bare form `{ "<name>": [{ "kind", "ref" }] }` still loads. Copy
[bundles.example.json](bundles.example.json) to start. Restart speaker after editing the file by hand; the `/admin`
Bundles page edits it live and writes the described form.
A request names the bundle and the owner approves all members at once. A caller may request a bundle only if it may request every member kind. `GET /_speaker/bundles` lists those bundles for the caller as `{ "<name>": { "description", "members" } }`.
{.ai}

<!-- author: ai -->

## Phone notifications

<sub>AI-written</sub>

```dotenv
PUBLIC_URL=https://speaker.example.com
NTFY_URL=https://your-ntfy-server.example
NTFY_TOPIC=speaker-approvals
NTFY_TOKEN=your-publish-token
```

- Speaker sends one ntfy push for each new enforcer, session, and request. Pushes carry labels and a link to
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
- Run one replica. Configuration, secrets, identities, and permanent leases persist in `/data`. A restart ends temporary leases and pending requests.
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

Agents follow the SSH section of [the skill](skill/SKILL.md): `GET /_speaker/ssh/hosts`, `POST /_speaker/ssh` with `{host, user, publicKey, reason, duration}`, poll `GET /_speaker/requests/<id>`, then save `certificate` next to the key.

<!-- author: ai -->

## Agent access

<sub>AI-written</sub>

Give agents the public setup guide at `https://your-speaker-host/skill.md`; it is served without authentication
so a new agent can bootstrap. It explains session enrollment, provider guides, and approval requests. Keep
`/admin` protected and give the agent its Speaker token through its credential settings.
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

Speaker keeps each request on the configured upstream origin and inside its base path. It strips caller credentials, cookies, proxy identity, and hop-by-hop headers before injecting the provider credential. Speaker streams responses and returns upstream redirects without following them. The proxy checks read/write approval on each call; it does not authorize individual paths or request bodies.
{.ai}

An agent with direct upstream credentials or a local vault mount can bypass speaker. The owner must remove those routes when speaker must control all access. Revocation blocks subsequent proxy calls; it cannot undo completed operations or guarantee cancellation of a forwarded request.
{.ai}
