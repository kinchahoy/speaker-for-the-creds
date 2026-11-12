---
name: access-and-creds
version: 4
description: "Get owner-approved access through speaker: homelab APIs (Obsidian, Home Assistant, ...), SSH, folders, secrets and sites. Use when a task needs a credential, API key, token, secret, SSH or `gh` access you lack, or a call returns 401 or 403."
---

# Speaker

Speaker holds the owner's keys; the owner approves each use from a phone. Never ask for or use an upstream key, and never print your speaker token.

- Call: `curl -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header" $SPEAKER_URL/<service>/<path>`
- No header file, or error `enroll`: follow the setup in `$SPEAKER_URL/_speaker/help`. In a sandbox you are already enrolled.
- No access yet: repeat the call with `-H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>' --max-time 70`.
- Every error has `next`: do exactly that. Tell the user what `tell_user` says. On `denied`, stop.
- Everything else (requests, SSH, folders, secrets, `/me`): `$SPEAKER_URL/_speaker/help`.
