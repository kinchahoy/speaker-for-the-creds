# Speaker help

Use only names the user gave you or that `GET $SPEAKER_URL/_speaker/me` shows. Never ask for upstream keys.

## In a sandbox

Read this section and the item list in section 3. Skip the rest.

You are already enrolled: `SPEAKER_URL` and `SPEAKER_TOKEN` are set. Send `Authorization: Bearer $SPEAKER_TOKEN`. Ask for items with the `request_capability` tool. It waits and returns the decision. The sandbox then applies each granted item. Retry what was blocked; `applying` in `/me` means not yet. For a secret, set only the placeholder variable from `/me` on the command. You need no proxy or certificate setup. `mcp:<id>` and `ext:<id>` start inside the sandbox, from its host's list.

## 1. Set up

Do this once per user and machine. Skip it if the header file works. In a sandbox, you are already enrolled.

Fill in `label` and `agent`. Speaker shows both to the owner as your claims. `want` may be empty.

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

Your token works only from the address you enrolled from. From another address, set up again with a new token.

## 2. Check where you stand

`GET $SPEAKER_URL/_speaker/me` shows your services, grants, secrets, SSH commands, the groups you may ask for, and your requests. `GET $SPEAKER_URL/_speaker/help/<service>` gives that service's usage and your state for it.

## 3. Ask for access

To use a service, call it with `Speaker-Wait: 60` (see the core skill). Speaker asks the owner for you. To ask for several things at once, `POST $SPEAKER_URL/_speaker/requests` with the header `Speaker-Wait: 60` and this body:

`{"want":["<item>","<item>"],"reason":"<one sentence>","duration":"2h"}`

Items: `<service>.read` (read), `<service>.full` (read and change), `ssh:<target>`, `folder:<share>` (`folder:<share>:rw` to change files), `secret:<NAME>`, `site:<host>`, `group:<name>`. `site:` works only in a sandbox.

Ask for the minimum the task needs. If you need three or more items from one group in `/me`, ask for the group: the owner makes one decision. Otherwise ask for exactly those items, even if a group contains them.

Durations: `30m`, `1h`, `2h` (default), `1d`, `30d`.

The reply lists `granted` and `denied`. Work with what was granted. Do not ask again for what was denied. Repeating the call joins your pending request.

## 4. SSH and folders

Target and share names come only from the user or your task. Make a throwaway key once, with `ssh-keygen -t ed25519 -N '' -f "$d/ssh_key"`, and send `"sshKey":"<contents of ssh_key.pub>"` with your first request. Then ask for `ssh:<target>` or `folder:<share>`.

After approval, `/me` lists complete command lines under `ssh`. Run its `knownHosts.save` command once, with `<known_hosts>` replaced by `"$d/known_hosts"`. Then copy the command lines and fill in `<key>` (the path of `ssh_key`), `<known_hosts>` (`"$d/known_hosts"`), `<command>`, `<file>`, `<path>`, `<mountpoint>`.

- Commands: use the `ssh` line. There is no terminal. For a script, end the line with `'sh -s' <<'EOF'`.
- Folders: try `sshfs` first and work inside the mountpoint. If `sshfs` is not installed, use `sftp` or `scp` (fine for a few files). Paths start with the share name. Speaker refuses `rsync` and `scp -O`.
- When a grant ends, the session stops. Read `/me` again.

## 5. Secrets (`gh`, `git`)

Ask for `secret:<NAME>`. After approval, `/me` lists it under `secrets`: `environment` (a placeholder, not the token, plus `HTTPS_PROXY` and `SSL_CERT_FILE`), the allowed hosts, and the one-time `certificate` and `git` commands. Run those once. Then set the variables only on the command that needs them:

`GH_TOKEN=<placeholder> HTTPS_PROXY=<value> SSL_CERT_FILE=<value> gh pr list`

In `HTTPS_PROXY`, replace `<token>` with the part after `Bearer ` in your header file. Speaker refuses other hosts.

## 6. Remote MCP servers

A service in `/me` with `mcp: true` is a remote MCP server. Ask for `<service>.read`, then point your MCP client at `$SPEAKER_URL/<service>` with the `Authorization` header from your header file.

## Errors

- `enroll`: set up again.
- `approval_required`: repeat with `Speaker-Wait: 60`.
- `denied`: stop.
- `invalid`: fix the input. The reply says what is accepted.
- `rate_limited`: wait and retry.

Always do `next`, and tell the user what `tell_user` says.
