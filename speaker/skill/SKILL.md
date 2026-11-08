---
name: access-and-creds
description: Get owner-approved access through speaker: authenticated homelab APIs and HTTP MCP servers (for example Obsidian notes), plus short-lived SSH certificates for homelab hosts, and network sites, secrets, folders, and MCP servers inside a sandbox. Use when a task needs a service you have no credential for, or a call returns 403.
---

# Access and credentials

This skill gets you access you do not have, through the owner's speaker service. Speaker holds the real credentials. The owner approves every grant. You never see an upstream key, so never ask for one and never use the admin API. Keep your speaker token out of output, notes, and files.

You may already hold a lease, or you may not. Do not assume either way: make the call, and request access on a 403.

## Where you run

- `BOTTLE_SCHOOL=1`: a sandbox. You are already enrolled, `SPEAKER_URL` and `SPEAKER_TOKEN` are set, and you may request any kind in the table below. Use the `request_capability` tool for requests.
- Otherwise: a direct session. Enroll once (below). You may request only `credential`.

Send `Authorization: Bearer <token>` on every call. The token is `$SPEAKER_TOKEN` or the file `${XDG_STATE_HOME:-$HOME/.local/state}/speaker/token`. Read it inside the shell or HTTP client; do not paste it into arguments.

### Enroll (direct session only)

1. `mkdir -p -m 700 "$dir" && openssl rand -hex 32 > "$dir/token" && chmod 600 "$dir/token"`, with `dir=${XDG_STATE_HOME:-$HOME/.local/state}/speaker`. Skip steps 1 to 3 when the file exists and its session is still approved.
2. `tokenHash` is the token's SHA-256 as bare hex: `printf %s "$(cat "$dir/token")" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1` (`shasum` is what macOS has).
3. `POST $SPEAKER_URL/_speaker/sessions` with `{"label":"<task>","llmName":"<your provider and model>","tokenHash":"<hash>","duration":"1h"}`. Give the user the returned `id` and ask them to approve it at `/admin`.
4. Poll `GET /_speaker/sessions/<id>` until `status` is `approved`. On `denied` or a past `expiresAt`, enroll again.

## Use a service

1. `GET $SPEAKER_URL/_speaker/providers` lists providers (`obsidian`, `karakeep`, ...) with their policy and `hasGuide`.
2. If `hasGuide` is true, read `GET /_speaker/providers/<name>/guide` for that provider's endpoints.
3. Call `$SPEAKER_URL/<provider>/<path>`. The provider's base URL already includes its API prefix. Speaker adds the credential.
4. GET, HEAD, and OPTIONS need `<provider>.read`. Every other method needs `<provider>.write`.

## Request access

On `403` with `approval_required`:

1. `POST $SPEAKER_URL/_speaker/requests` with `{"capability":{"kind":"<kind>","ref":"<ref>"},"reason":"<one sentence>","duration":"15m"}`. Use the shortest duration that fits: `15m`, `30m`, `1h`, `1d`, `7d`, `30d`.
2. Tell the user the request needs approval at `/admin`.
3. Poll `GET /_speaker/requests/<id>` every 10 to 30 seconds until `approved`, then retry the call once. Stop on `denied` or `expired`.
4. Ask once per capability. Do not loop, and do not reach a denied destination another way.

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

## SSH to a homelab host

Speaker can sign a short-lived SSH certificate for your own throwaway key. Never ask for a password or a long-lived key.

1. `GET /_speaker/ssh/hosts` lists host aliases, the login users each accepts, and `maxDuration`.
2. Run this with `host`, `user`, `reason` and `duration` set (shortest that fits, at most `maxDuration`). It needs `curl` and `jq`.

```sh
dir="${XDG_STATE_HOME:-$HOME/.local/state}/speaker/ssh"; mkdir -p -m 700 "$dir"
key="$dir/$host-$(date +%s)"; ssh-keygen -q -t ed25519 -N '' -C speaker-agent -f "$key"
auth="Authorization: Bearer ${SPEAKER_TOKEN:-$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/speaker/token")}"
id=$(jq -n --arg host "$host" --arg user "$user" --arg reason "$reason" --arg duration "$duration" \
  --rawfile publicKey "$key.pub" '{$host,$user,$reason,$duration,$publicKey}' |
  curl -fsS -H "$auth" -H 'content-type: application/json' -d @- "$SPEAKER_URL/_speaker/ssh" | jq -r .id)
echo "Ask the owner to approve request $id at $SPEAKER_URL/admin"
while r=$(curl -fsS -H "$auth" "$SPEAKER_URL/_speaker/requests/$id") && [ "$(jq -r .status <<<"$r")" = pending ]; do sleep 15; done
[ "$(jq -r .status <<<"$r")" = approved ] || { echo "request $(jq -r .status <<<"$r")"; exit 1; }
jq -r .certificate <<<"$r" > "$key-cert.pub"
echo "Valid until $(jq -r .expiresAt <<<"$r"):"
echo "ssh -i $key -o CertificateFile=$key-cert.pub -o IdentitiesOnly=yes -p $(jq -r .ssh.port <<<"$r") $(jq -r '.ssh.user + "@" + .ssh.hostname' <<<"$r")"
```

3. Run commands with that `ssh` line. When it expires, the host refuses the certificate; request again only if the task still needs it. Add `"agentForwarding":true`, `"portForwarding":true` or `"sourceAddress":"<cidr>"` to the request body only when the task needs them.

## Example: read a note in Obsidian

1. `GET /obsidian/<path from its guide>` returns `403 approval_required`.
2. Request `{"kind":"credential","ref":"obsidian.read"}` with reason "read the meeting note", duration `15m`.
3. After approval, repeat the GET. Request `obsidian.write` only when you must change a note, and check the result of a write before repeating it.
