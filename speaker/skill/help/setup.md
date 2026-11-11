# Setup for a direct session

Run once per session; skip it while the header file still works. In a sandbox you are already enrolled.

sh (Linux, macOS, Git Bash):

```sh
d="${XDG_STATE_HOME:-$HOME/.local/state}/speaker"; mkdir -p "$d"; chmod 700 "$d"; umask 077
t=$(openssl rand -hex 32); [ ${#t} = 64 ] && printf 'Authorization: Bearer %s\n' "$t" > "$d/header"
h=$(printf %s "$t" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1); unset t
curl -s "$SPEAKER_URL/_speaker/sessions" -H 'content-type: application/json' \
  -d '{"label":"<task>","llmName":"<model>","harness":"<agent app>","tokenHash":"'"$h"'","duration":"1h"}'
```

Then call with `curl -H @"$d/header" ...`.

PowerShell:

```powershell
$d = "$HOME\.local\state\speaker"; New-Item -ItemType Directory -Force $d | Out-Null
icacls $d /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$t = -join ($b | % { $_.ToString('x2') }); Set-Content "$d\header" "Authorization: Bearer $t"
$h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | % { $_.ToString('x2') }); $t = $null
Invoke-RestMethod -Method Post "$env:SPEAKER_URL/_speaker/sessions" -ContentType application/json `
  -Body (@{label='<task>'; llmName='<model>'; harness='<agent app>'; tokenHash=$h; duration='1h'} | ConvertTo-Json)
```

Then call with `curl.exe -H "@$d\header" ...`.

The reply's `next` waits for the owner (`?wait=60`; repeat while `pending`). To get the first access in the same approval, add `"request":{"capability":{"kind":"credential","ref":"<provider>.read"},"reason":"<one sentence>","duration":"15m"}` to the body.
