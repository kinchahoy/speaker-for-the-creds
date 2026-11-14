---
name: access-and-creds
version: 7
description: "Get owner-approved access through speaker: homelab APIs (Obsidian, Home Assistant, ...), SSH hosts, folders, and secrets such as GitHub tokens. Use when a task needs access, a credential, API key, token, SSH or `gh` you lack, or a call returns 401 or 403."
---

# Speaker

Speaker holds the owner's keys and makes calls for you. The owner approves each use from a phone, so you never need an upstream key. Never ask for one, and never print your speaker token.

In a bottle sandbox, use the `request_capability` tool instead of this page.

- Call a service: `curl -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header" $SPEAKER_URL/<service>/<path>`
- No header file, or error `enroll`: read "Set up" below. It takes four commands, once.
- No access yet: repeat the call with `-H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>' --max-time 70`. Speaker asks the owner and answers when they decide. Without `Speaker-Wait` it answers at once, so you would never see the decision.
- Every error has `next`. Do exactly that, and tell the user what `tell_user` says. On `denied`, stop: asking again only annoys the owner.
- What you may ask for, and where you stand: `GET $SPEAKER_URL/_speaker/catalog`.
- One service's usage and your state for it: `GET $SPEAKER_URL/_speaker/help/<service>`.

Sections below, in the order you will need them: Set up, What you can ask for, Asking, Folders and SSH, Secrets, Remote MCP servers, Errors. Read only the one you need.

## Set up

Do this once per user and machine. Skip it if the header file works. The token stays in a file on your machine, and speaker keeps only its hash.

Fill in `label` and `agent`. Speaker shows both to the owner as your claims, so the owner can tell agents apart. `want` may be empty.

- `label`: the task in at most 8 words, as the user would say it
- `agent`: `<model> · <app> on <machine>`, for example `Opus 5.5 · Claude Code on PrimeX`. Write `unknown` for any part you do not know.

sh (Linux, macOS, Git Bash). Run each step in the same shell:

1. `d="${XDG_STATE_HOME:-$HOME/.local/state}/speaker"; mkdir -p "$d"; chmod 700 "$d"; umask 077`
2. `t=$(openssl rand -hex 32); printf 'Authorization: Bearer %s\n' "$t" > "$d/header"`
3. `h=$(printf %s "$t" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1); unset t`
4. `curl -s $SPEAKER_URL/_speaker/agents -H 'content-type: application/json' -d '{"label":"<label>","agent":"<agent>","tokenHash":"'"$h"'","want":[]}'`

From now on call with `curl -H @"$d/header" ...`.

PowerShell:

1. `$d = "$HOME\.local\state\speaker"; New-Item -ItemType Directory -Force $d | Out-Null; icacls $d /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null`
2. `$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $t = -join ($b | % { $_.ToString('x2') }); Set-Content "$d\header" "Authorization: Bearer $t"`
3. `$h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | % { $_.ToString('x2') }); $t = $null`
4. `Invoke-RestMethod -Method Post $env:SPEAKER_URL/_speaker/agents -ContentType application/json -Body (@{label='<label>'; agent='<agent>'; tokenHash=$h; want=@()} | ConvertTo-Json)`

From now on call with `curl.exe -H "@$d\header" ...`.

Your token works only from the address you enrolled from, so a leaked token is useless elsewhere. From another address, set up again with a new token.

## What you can ask for

`GET $SPEAKER_URL/_speaker/catalog` lists everything you may ask for, each with your state: granted (until a time), `ask` (not granted yet), or `never` (the owner blocks it). It lists services, secrets, and groups, plus your grants, SSH commands and requests. Its `text` field is the same list in plain English.

Two kinds are deliberately not listed: folders and SSH targets. Anyone who can reach speaker can enroll, so speaker does not hand out the names of the owner's machines. Use the exact name your task or the owner gave you. A name speaker does not know is refused with 400 and nothing reaches the owner.

## Asking

To use a service, call it with `Speaker-Wait: 60` and speaker asks the owner for you. To ask for several things at once, `POST $SPEAKER_URL/_speaker/requests` with the header `Speaker-Wait: 60` and this body:

`{"want":["<item>","<item>"],"reason":"<one sentence>","duration":"2h"}`

Items: `<service>.read` (read), `<service>.full` (read and change), `ssh:<target>`, `folder:<share>` (`folder:<share>:rw` to change files), `secret:<NAME>`, `group:<name>`.

Ask for the minimum the task needs, because the owner reads every item. If you need three or more items from one group in the catalog, ask for the group: the owner then makes one decision. Otherwise ask for exactly those items, even if a group contains them.

Durations: `30m`, `1h`, `2h` (default), `1d`, `30d`.

The reply lists `granted` and `denied`. Work with what was granted. Do not ask again for what was denied. Each POST is its own request. Posting exactly the same items while that request is still pending joins it, which is how you keep waiting: repeat the call with `Speaker-Wait: 60`.

## Folders and SSH

Make a throwaway key once, with `ssh-keygen -t ed25519 -N '' -f "$d/ssh_key"`, and send `"sshKey":"<contents of ssh_key.pub>"` with your first request. Speaker uses it to tell you apart from other agents. Then ask for `ssh:<target>` or `folder:<share>`, with names from the user or your task.

After approval, the catalog lists complete command lines under `ssh`. Run its `knownHosts.save` command once, with `<known_hosts>` replaced by `"$d/known_hosts"`; this pins speaker's host key so nothing prompts. Then copy the command lines and fill in `<key>` (the path of `ssh_key`), `<known_hosts>` (`"$d/known_hosts"`), `<command>`, `<file>`, `<path>`, `<mountpoint>`.

- Commands: use the `ssh` line. There is no terminal. For a script, end the line with `'sh -s' <<'EOF'`.
- Folders: try `sshfs` first and work inside the mountpoint. If `sshfs` is not installed, use `sftp` or `scp` (fine for a few files). Paths start with the share name. Speaker refuses `rsync` and `scp -O`.
- When a grant ends, the session stops. Read the catalog again.

## Secrets

Ask for `secret:<NAME>`, with a name from the catalog. After approval, the catalog shows it under `secrets` with `environment` (a placeholder, not the token, plus `HTTPS_PROXY` and `SSL_CERT_FILE`), the allowed hosts, and the one-time `certificate` and `git` commands. Run those once. Then set the variables only on the command that needs them, so the placeholder goes nowhere else:

`GH_TOKEN=<placeholder> HTTPS_PROXY=<value> SSL_CERT_FILE=<value> gh pr list`

In `HTTPS_PROXY`, replace `<token>` with the part after `Bearer ` in your header file. Speaker refuses other hosts, and swaps the placeholder for the real token only on the allowed ones.

## Remote MCP servers

A service in the catalog with `mcp: true` is a remote MCP server. Ask for `<service>.read`, then point your MCP client at `$SPEAKER_URL/<service>` with the `Authorization` header from your header file.

## Errors

- `enroll`: your token is missing or unknown. Read "Set up" and enroll again.
- `approval_required`: the owner has not decided yet. Repeat with `Speaker-Wait: 60`.
- `denied`: stop. Tell the user.
- `invalid`: fix the input. The message says what is accepted and `next` says where to look.
- `rate_limited`: wait and retry.

Always do `next`, and tell the user what `tell_user` says.
