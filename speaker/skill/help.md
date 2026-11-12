# Speaker help

Use only names the user gave you, or ones `GET $SPEAKER_URL/_speaker/me` shows. Never ask for upstream keys.

## 1. Set up (once per user and machine; skip if the header file works; in a sandbox you are already enrolled)

Fill in `label` (the task in at most 8 words, as the user would say it) and `agent` (`<model> · <app> on <machine>`, for example `Opus 5.5 · Claude Code on PrimeX`; write `unknown` for any part you do not know). Both are shown to the owner as your claims. `want` may be empty.

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

Your token works only from the address you enrolled from; elsewhere, set up again with a new token.

## 2. Look at where you stand

`GET $SPEAKER_URL/_speaker/me` shows your services, grants, secrets, SSH commands, the groups you may ask for, and your requests. `GET $SPEAKER_URL/_speaker/help/<service>` gives that service's usage and your state for it.

## 3. Ask for access

To use a service, call it with `Speaker-Wait: 60` (see the core skill); speaker asks for you. To ask for several things at once, `POST $SPEAKER_URL/_speaker/requests` with header `Speaker-Wait: 60` and body

`{"want":["<item>","<item>"],"reason":"<one sentence>","duration":"2h"}`

- Items: `<service>.read` (read), `<service>.full` (read and change), `ssh:<target>`, `folder:<share>` (`folder:<share>:rw` to change files), `secret:<NAME>`, `site:<host>`, `group:<name>`. `site:` works only in a sandbox.
- Ask for the minimum the task needs. If you need three or more items from one group in `/me`, ask for the group (one decision for the owner); otherwise ask for exactly those items, even when a group contains them.
- Durations: `30m`, `1h`, `2h` (default), `1d`, `30d`.
- The reply lists `granted` and `denied`. Work with what was granted; do not ask again for what was denied. Repeating the call joins your pending request.

## 4. SSH and folders

Target and share names come only from the user. Once, make a throwaway key with `ssh-keygen -t ed25519 -N '' -f "$d/ssh_key"` and send `"sshKey":"<contents of ssh_key.pub>"` with your first request. Then ask for `ssh:<target>` or `folder:<share>`.

After approval, `/me` lists complete command lines under `ssh`. Once, run its `knownHosts.save` command with `<known_hosts>` replaced by `"$d/known_hosts"`. Then copy the command lines and fill in `<key>` (the path of `ssh_key`), `<known_hosts>` (`"$d/known_hosts"`), `<command>`, `<file>`, `<path>`, `<mountpoint>`.

- Commands: the `ssh` line. There is no terminal. For a script, end the line with `'sh -s' <<'EOF'`.
- Folders: use `sshfs` first and work inside the mountpoint; if `sshfs` is not installed, use `sftp` or `scp` (fine for a few files). Paths start with the share name. `rsync` and `scp -O` are refused.
- When a grant ends the session stops: read `/me` again.

## 5. Secrets (`gh`, `git`)

Ask for `secret:<NAME>`. After approval `/me` lists it under `secrets`: `environment` (a placeholder, not the token, plus `HTTPS_PROXY` and `SSL_CERT_FILE`), the allowed hosts, and the one-time `certificate` and `git` commands. Run those once, then set the variables only on the command that needs them:

`GH_TOKEN=<placeholder> HTTPS_PROXY=<value> SSL_CERT_FILE=<value> gh pr list`

In `HTTPS_PROXY`, replace `<token>` with the part after `Bearer ` in your header file. Other hosts are refused.

## 6. Remote MCP servers

A service in `/me` with `mcp: true` is a remote MCP server. Ask for `<service>.read`, then point your MCP client at `$SPEAKER_URL/<service>` with the `Authorization` header from your header file.

## 7. In a sandbox

You are already enrolled: `SPEAKER_URL` and `SPEAKER_TOKEN` are set; send `Authorization: Bearer $SPEAKER_TOKEN`. Use the `request_capability` tool to ask for items; it waits and returns the decision. The sandbox applies a granted item: retry what was blocked (`applying` in `/me` means not yet). For a secret, set only the placeholder variable from `/me` on the command; no proxy or certificate setup is needed. `mcp:<id>` and `ext:<id>` start inside the sandbox from its host's list.

## Errors

`enroll`: set up again. `approval_required`: repeat with `Speaker-Wait: 60`. `denied`: stop. `invalid`: fix the input; the reply says what is accepted. `rate_limited`: wait and retry. Always do `next` and tell the user `tell_user`.
