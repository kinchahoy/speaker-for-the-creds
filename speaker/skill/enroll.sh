#!/bin/sh
# Enrols this agent: the token is made here and never sent, only its hash.
# Usage: curl -s $SPEAKER_URL/_speaker/enroll.sh | sh -s -- "<label>" "<model · app on machine>"
set -eu
[ $# -ge 1 ] || { echo 'usage: sh -s -- "<label>" "<model · app on machine>"' >&2; exit 2; }
umask 077
d="${XDG_STATE_HOME:-$HOME/.local/state}/speaker"
mkdir -p "$d"; chmod 700 "$d"
t=$(openssl rand -hex 32)
printf 'Authorization: Bearer %s\n' "$t" > "$d/header"
h=$(printf %s "$t" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)
esc() { printf %s "$1" | tr -d '"\\\n'; }
curl -sS $SPEAKER_URL/_speaker/agents -H 'content-type: application/json' \
  -d "{\"label\":\"$(esc "$1")\",\"agent\":\"$(esc "${2:-unknown}")\",\"tokenHash\":\"$h\",\"want\":[]}"
echo; echo "Header file: $d/header (call with curl -H @$d/header)"
