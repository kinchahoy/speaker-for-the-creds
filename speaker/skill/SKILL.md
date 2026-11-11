---
name: access-and-creds
description: "Get owner-approved access through speaker: authenticated homelab APIs and HTTP MCP servers (for example Obsidian notes), plus network sites, secrets, folders, and MCP servers inside a sandbox. Use when a task needs a service you have no credential for, or a call returns 403."
---

# Access and credentials

This skill gets you access you do not have, through the owner's speaker service. Speaker holds the real credentials. The owner approves every grant. You never see an upstream key, so never ask for one and never use the admin API. Keep your speaker token out of output, notes, and files.

You may already hold a lease, or you may not. Do not assume either way: make the call, and request access on a 403.

## Where you run

- `BOTTLE_SCHOOL=1`: a sandbox. You are already enrolled, `SPEAKER_URL` and `SPEAKER_TOKEN` are set, and you may request any kind in the table below. Use the `request_capability` tool for requests.
- Otherwise: a direct session. Enroll once (below). You may request only `credential`.

Send `Authorization: Bearer <token>` on every call. Use `$SPEAKER_TOKEN` when it is set (sandboxes); otherwise the file `${XDG_STATE_HOME:-$HOME/.local/state}/speaker/token`. Read it inside the shell or HTTP client; do not paste it into arguments.

### Quickstart (direct session)

With `dir=${XDG_STATE_HOME:-$HOME/.local/state}/speaker` and `S=$SPEAKER_URL`, three calls get one approved read:

1. `mkdir -p -m 700 "$dir" && openssl rand -hex 32 > "$dir/token" && chmod 600 "$dir/token"`, then `hash=$(printf %s "$(cat "$dir/token")" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)`. Skip this when the file exists and its session is still approved.
2. `POST $S/_speaker/sessions` with `{"label":"<task>","llmName":"<provider and model>","harness":"<your agent app, e.g. Claude Code>","tokenHash":"<hash>","duration":"1h","request":{"capability":{"kind":"credential","ref":"<provider>.read"},"reason":"<one sentence>","duration":"15m"}}`. The `request` is optional; with it, one owner approval covers the session and that access. Tell the user to approve the returned `id` at `/admin`.
3. `GET $S/_speaker/sessions/<id>?wait=60` returns as soon as the owner decides (or after 60 seconds; call again while `pending`). On `denied` or a past `expiresAt`, enroll again.

Then call the provider (below). If you do not know the provider name, list providers after approval: `GET $S/_speaker/providers` needs your approved token unless the owner made the list public.

## Use a service

1. `GET $SPEAKER_URL/_speaker/providers` lists providers (`obsidian`, `karakeep`, ...) with their policy. A `401` means enroll first.
2. Read `GET /_speaker/providers/<name>/guide` before the first call. Every provider has one: how to call it, whether you can read and write right now and until when (UTC), then the owner's notes on its endpoints when there are any.
3. Call `$SPEAKER_URL/<provider>/<path>`. The provider's base URL already includes its API prefix. Speaker adds the credential.
4. GET, HEAD, and OPTIONS need `<provider>.read`. Every other method needs `<provider>.write`. For an MCP provider, listing tools and read-only tools count as read; other tool calls count as write.
5. Policies: `always` means no request is needed (for up to 90 days after your session's approval); `approval` means request it on a 403; `deny` means never, so do not request it.

## Request access

On `403` with `approval_required`:

1. The 403 already filed a request (`requestId`). To add your reason, `POST $SPEAKER_URL/_speaker/requests` with `{"capability":{"kind":"<kind>","ref":"<ref>"},"reason":"<one sentence>","duration":"15m"}`; it updates the same request. Use the shortest duration that fits: `15m`, `30m`, `1h`, `1d`, `7d`, `30d`, `90d`.
2. Tell the user the request needs approval at `/admin`.
3. `GET /_speaker/requests/<id>?wait=60` returns when the owner decides; once `approved` it includes `expiresAt` (UTC, `null` = no expiry). Retry the call once. Stop on `denied` or `expired`.
4. Ask once per capability. `GET /_speaker/requests` lists your own requests and their status. Do not loop, and do not reach a denied destination another way.

| Kind | `ref` | Example |
| --- | --- | --- |
| `credential` | `<provider>.read` or `<provider>.write` | `obsidian.read` |
| `site` | `<host>` or `*.<domain>` | `pypi.org` |
| `secret` | `<NAME>@<host>[,<host>]` | `GITHUB_TOKEN@api.github.com` |
| `folder` | `<share>` or `<share>:rw` | `photos:rw` |
| `mcp` | `<catalog id>` | `context7` |

Only `credential` works in a direct session. `site`, `secret`, `folder`, and `mcp` work in a sandbox.

### Bundles

A bundle is a named set of capabilities the owner approves in one decision. `GET /_speaker/bundles` lists those you may request, with their members. When a task needs several of them, request `{"bundle":"<name>","reason":"...","duration":"1h"}` instead of one call per member. A bundle with any member you cannot request is not listed.

## Example: read a note in Obsidian

1. `GET /obsidian/<path from its guide>` returns `403 approval_required`.
2. Request `{"kind":"credential","ref":"obsidian.read"}` with reason "read the meeting note", duration `15m`.
3. After approval, repeat the GET. Request `obsidian.write` only when you must change a note, and check the result of a write before repeating it.
