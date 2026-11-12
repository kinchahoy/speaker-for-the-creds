## SSH to a host (certificate)

Speaker can sign a short-lived SSH certificate for your own throwaway key. Never ask for a password or a long-lived key.

1. `GET /_speaker/ssh/hosts` lists host aliases, the login users each accepts, and `maxDuration`.
2. Run this with `host`, `user`, `reason` and `duration` set (shortest that fits, at most `maxDuration`). It needs `curl` and `jq`, and waits for the owner for up to 60 seconds.

```sh
dir="${XDG_STATE_HOME:-$HOME/.local/state}/speaker/ssh"; mkdir -p "$dir"; chmod 700 "$dir"
key="$dir/$host-$(date +%s)"; ssh-keygen -q -t ed25519 -N '' -C speaker-agent -f "$key"
hdr="${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header"
[ -n "$SPEAKER_TOKEN" ] && { hdr="$dir/header"; printf 'Authorization: Bearer %s\n' "$SPEAKER_TOKEN" > "$hdr"; }
r=$(jq -n --arg host "$host" --arg user "$user" --arg reason "$reason" --arg duration "$duration" \
  --rawfile publicKey "$key.pub" '{$host,$user,$reason,$duration,$publicKey}' |
  curl -sS --max-time 70 -H @"$hdr" -H 'Speaker-Wait: 60' -H 'content-type: application/json' -d @- "$SPEAKER_URL/_speaker/ssh")
[ "$(jq -r .status <<<"$r")" = decided ] && [ "$(jq -r '.granted | length' <<<"$r")" = 1 ] ||
  { echo "not granted yet: $(jq -r '.next // .error' <<<"$r"); ask the user: $(jq -r '.tell_user // empty' <<<"$r")"; exit 1; }
jq -r .certificate <<<"$r" > "$key-cert.pub"
echo "Valid until $(jq -r .expiresAt <<<"$r"):"
echo "ssh -i $key -o CertificateFile=$key-cert.pub -o IdentitiesOnly=yes -p $(jq -r .ssh.port <<<"$r") $(jq -r '.ssh.user + "@" + .ssh.hostname' <<<"$r")"
```

3. Run commands with that `ssh` line. When it expires, the host refuses the certificate; request again only if the task still needs it. If the script stopped at "not granted yet", run it again to wait more. Add `"agentForwarding":true`, `"portForwarding":true` or `"sourceAddress":"<cidr>"` to the request body only when the task needs them.
