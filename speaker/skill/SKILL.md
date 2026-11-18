---
name: access-and-creds
version: 9
description: "Get owner-approved access through speaker: homelab APIs (Obsidian, Home Assistant, ...), SSH hosts, folders, and secrets such as GitHub tokens. Use when a task needs access, a credential, API key, token, SSH or `gh` you lack, or a call returns 401 or 403."
---

# Speaker

Speaker holds the owner's keys and makes calls for you. The owner approves each use. Never ask for an upstream key, and never print your token. (In a bottle sandbox use the `speaker` command and `request_capability`, not this page.)

Enrol once per machine (label: the task in at most 8 words; agent: `<model> · <app> on <machine>`):
`curl -s $SPEAKER_URL/_speaker/enroll.sh | sh -s -- "<label>" "<model · app on machine>"`

Call a service (quote the URL; add the wait header only to ask the owner and hold the call until they decide):
`curl -s -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header" -H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>' --max-time 70 "$SPEAKER_URL/<service>/<path>"`

The three common errors (JSON with `error`, `message`, `next`; do what `next` says, tell the user what `tell_user` says):
- `enroll`: no header file or unknown token. Enrol again.
- `approval_required`: the owner has not decided. Repeat with `Speaker-Wait: 60`.
- `denied`: stop. Asking again only annoys the owner.

A 404 with `Speaker-Upstream: <service>` is the service's own: a wrong path. `Speaker-Upstream-Path` shows the path speaker called; `Speaker-Note` has the owner's note for the service.

More: `GET $SPEAKER_URL/_speaker/help/<service>` (usage and your state), `GET $SPEAKER_URL/_speaker/catalog` (everything you may ask for, and your grants).

---

Reference. Read only the part you need.

## Set up (by hand)

The script above does this: `d="${XDG_STATE_HOME:-$HOME/.local/state}/speaker"`, make it mode 700; `t=$(openssl rand -hex 32)`; write `Authorization: Bearer $t` to `$d/header` (mode 600); POST `{"label","agent","tokenHash":sha256($t),"want":[]}` to `$SPEAKER_URL/_speaker/agents`. On Windows do the same in PowerShell and call with `curl.exe -H "@$d\header"`. The token never leaves your machine, and works only from the address you enrolled from.

## Asking

A service call with `Speaker-Wait: 60` asks the owner for you. For several items, `POST $SPEAKER_URL/_speaker/requests` with `Speaker-Wait: 60` and `{"want":["<item>"],"reason":"<one sentence>","duration":"2h"}`. Items: `<service>.read`, `<service>.full` (also change), `ssh:<target>`, `folder:<share>` (`:rw` to change files), `secret:<NAME>`, `group:<name>` (when you need three or more of its items). Durations: `30m`, `1h`, `2h`, `1d`, `30d`. Ask for the minimum. Posting the same items again joins the pending request. Folders and SSH targets are not listed: use the exact name from your task.

## Folders and SSH

Make a throwaway key once (`ssh-keygen -t ed25519 -N '' -f "$d/ssh_key"`) and send `"sshKey":"<ssh_key.pub>"` with your first request. After approval the catalog lists complete command lines under `ssh`: run its `knownHosts.save` once (with `<known_hosts>` as `"$d/known_hosts"`), then fill in `<key>`, `<known_hosts>`, `<command>`, `<file>`, `<path>`, `<mountpoint>`. Commands have no terminal (end a script with `'sh -s' <<'EOF'`). Folders: `sshfs`, else `sftp` or `scp` (not `rsync`, not `scp -O`). When a grant ends, the session stops.

## Secrets

Ask for `secret:<NAME>`. The catalog then shows `environment` (a placeholder, `HTTPS_PROXY`, `SSL_CERT_FILE`), the allowed hosts and the one-time `certificate` and `git` commands. Run those once, replace `<token>` in `HTTPS_PROXY` with the part of your header file after `Bearer `, and set the variables only on the command that needs them: `GH_TOKEN=<placeholder> HTTPS_PROXY=<value> SSL_CERT_FILE=<value> gh pr list`. Speaker swaps in the real token only for the allowed hosts. A secret marked `release` is read with `GET /_speaker/secrets/<NAME>`; do not store or repeat it.

## Remote MCP servers

A catalog service with `mcp: true`: ask for `<service>.read`, then point your MCP client at `$SPEAKER_URL/<service>` with your header file's `Authorization`.

## Other errors

`invalid`: fix the input (`next` says where to look). `not_found`: no such route or service. `rate_limited`: wait. `locked`: the owner has not signed in; tell the user. `no_key`: the service has no key; tell the user.
