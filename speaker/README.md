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
- Capabilities have a kind: `credential`, `secret`, `site`, `folder`, or `mcp`.
  - A session may request only `credential`.
  - A subject may request `credential` plus its enforcer's kinds. Other kinds return `400 unsupported_kind`.
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
- A provider may carry a markdown `guide`. `GET /_speaker/providers/<name>/guide` serves it to sessions and subjects.
- The `demo` provider allows reads and requires a lease for writes. `/demo/check` answers
  `"credential":"accepted"` without exposing the fake key.

A blocked call returns `403 approval_required` with a `requestId`. Speaker creates the request for the calling
session or subject. The caller may add a reason with `POST /_speaker/requests` for the same capability.
{.ai}

<!-- author: ai -->

## Bundles

<sub>AI-written</sub>

Define bundles in `DATA_DIR/bundles.json` as `{ "<name>": [{ "kind", "ref" }] }`. Copy
[bundles.example.json](bundles.example.json) to start. Restart speaker after editing it.
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

## Agent access

<sub>AI-written</sub>

Install [skill/SKILL.md](skill/SKILL.md) in projects that need these services. The skill enrolls a session,
reads provider guides on demand, and requests access.
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
