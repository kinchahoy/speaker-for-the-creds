# Speaker

Speaker lets you use the owner's services without holding their keys. Ask for what the task needs; the owner approves from a phone. Use only names the owner gave you, or ones `GET /_speaker/me` shows.

## Setup (direct agents, once per user and machine)

Skip it while the header file still works. In a sandbox you are already enrolled.

sh (Linux, macOS, Git Bash):

```sh
d="${XDG_STATE_HOME:-$HOME/.local/state}/speaker"; mkdir -p "$d"; chmod 700 "$d"; umask 077
t=$(openssl rand -hex 32); [ ${#t} = 64 ] && printf 'Authorization: Bearer %s\n' "$t" > "$d/header"
h=$(printf %s "$t" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1); unset t
curl -s "$SPEAKER_URL/_speaker/agents" -H 'content-type: application/json' \
  -d '{"label":"<the task in at most 8 words>","agent":"<model> · <app> on <machine>","tokenHash":"'"$h"'","want":[]}'
```

Then call with `curl -H @"$d/header" ...`.

PowerShell:

```powershell
$d = "$HOME\.local\state\speaker"; New-Item -ItemType Directory -Force $d | Out-Null
icacls $d /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$t = -join ($b | % { $_.ToString('x2') }); Set-Content "$d\header" "Authorization: Bearer $t"
$h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | % { $_.ToString('x2') }); $t = $null
Invoke-RestMethod -Method Post "$env:SPEAKER_URL/_speaker/agents" -ContentType application/json `
  -Body (@{label='<the task in at most 8 words>'; agent='<model> · <app> on <machine>'; tokenHash=$h; want=@()} | ConvertTo-Json)
```

Then call with `curl.exe -H "@$d\header" ...`.

- `agent`: write `unknown` for any part you do not know. Speaker adds your address; `label` and `agent` are shown to the owner as your claims.
- Enrolling with an empty `want` is fine: read `/me`, then ask. To ask in the same call, put the items in `want` and add `"reason":"<one sentence>","duration":"2h"`; add the header `Speaker-Wait: 60` to wait for the owner's decision.
- Enrolling the same token again returns the same agent. Your token works only from the address you enrolled from; elsewhere, enroll again with a new token.
