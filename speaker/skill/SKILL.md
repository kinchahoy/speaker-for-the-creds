---
name: access-and-creds
version: 3
description: "Get owner-approved access through speaker: homelab APIs and HTTP MCP servers, plus sites, secrets, folders and MCP servers inside a sandbox. Use when a task needs a credential or API key you lack, or a call returns 401 or 403."
---

# Access and credentials

Speaker holds the real keys and the owner approves each grant. Never ask for or use an upstream key or the admin API, and keep your speaker token out of output, notes and command lines.

- Full instructions, including setup: `$SPEAKER_URL/_speaker/help`. In a sandbox (`BOTTLE_SCHOOL=1`) you are already enrolled: skip setup.
- No header file yet, or an `enroll` error: run the setup in the help (copy-paste sh or PowerShell, nothing to install).
- `GET $SPEAKER_URL/_speaker/me` shows where you stand: what you hold, what you may ask for, your requests.
- Call `$SPEAKER_URL/<service>/<path>` with `curl -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header"`. Service names come from the owner or `/me`; `GET $SPEAKER_URL/_speaker/help/<service>` has its notes.
- Without access, add `-H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>' --max-time 70`: speaker asks the owner and answers once decided. Without `Speaker-Wait` it answers at once.
- Every error has a `next` field: do exactly that, and pass on `tell_user`. Stop on `denied`; never reach a denied service another way.
