---
name: speaker
description: Enroll this session with the user's speaker credential service, then request approved access to homelab APIs or HTTP MCP servers.
---

# speaker access

Use speaker only when the task needs a homelab service. Keep tokens out of output, notes, and generated files.

## Enroll once per session

1. Check for `${XDG_STATE_HOME:-$HOME/.local/state}/speaker/token`. If it exists, skip to step 5.
2. Generate a token: `mkdir -p -m 700 "$dir" && openssl rand -hex 32 > "$dir/token" && chmod 600 "$dir/token"`.
3. Compute `tokenHash` as the token's SHA-256 (`printf %s "$(cat "$dir/token")" | sha256sum`).
4. `POST $SPEAKER_URL/_speaker/sessions` with `{"label":"<project or task>","tokenHash":"<hash>","duration":"1h"}`. Give the user the returned `id` and ask them to approve it in `/admin`.
5. Poll `GET /_speaker/sessions/<id>` until `status` is `approved`. Stop on `denied` or an `expiresAt` in the past, and enroll again.

Send `Authorization: Bearer <token>` on every other call. Read the token from the file inside the HTTP client or shell; do not paste its value into command arguments.

## Use

- `GET /_speaker/providers` lists services, their policy, and `hasGuide`.
- Read `GET /_speaker/providers/<name>/guide` only when the task needs that service.
- Call `/<provider>/<path>`. The provider's base URL already includes its API prefix.
- GET, HEAD, and OPTIONS use `<provider>.read`. Other methods use `<provider>.write`.

## Request access

On `403` with `approval_required`, or before first use:

1. `POST /_speaker/requests` with `{"capability":{"kind":"credential","ref":"<provider>.read"},"reason":"<why>","duration":"15m"}`. Choose the shortest duration the task needs (`15m`, `30m`, `1h`, `1d`, `7d`, `30d`). A session may request only `credential`.
2. Tell the user the request needs approval at `/admin`.
3. Poll `GET /_speaker/requests/<id>` at a modest interval until `approved`, then retry the call. Stop on `denied` or `expired`.

Do not retry writes after a timeout without checking the outcome. Never use the admin API or ask for an upstream key.
