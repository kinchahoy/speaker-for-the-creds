---
name: access-and-creds
version: 5
description: "Get owner-approved access through speaker: homelab APIs (Obsidian, Home Assistant, ...), SSH hosts, folders, websites, and secrets such as GitHub tokens. Use when a task needs access, a credential, API key, token, SSH or `gh` you lack, or a call returns 401 or 403."
---

# Speaker

Speaker holds the owner's keys; the owner approves each use from a phone. Never ask for or use an upstream key, and never print your speaker token.

## In a sandbox (`BOTTLE_SCHOOL=1`)

You are already enrolled. Ask for anything you need with the `request_capability` tool, in one call listing every item:

- websites: `site:<host>`; once granted, just fetch them
- shared folders: `folder:<share>` (add `:rw` to write); once granted they are at `/input/<share>`
- secrets: `secret:<NAME>`; once granted, `$SPEAKER_URL/_speaker/me` gives the placeholder variable to set on the one command that needs it
- homelab APIs and remote MCP servers: `<service>.read` or `<service>.full`; call `$SPEAKER_URL/<service>/<path>` with `Authorization: Bearer $SPEAKER_TOKEN`
- MCP servers and extensions from this sandbox's catalog: `mcp:<id>`, `ext:<id>`

The tool waits for the owner and says what was granted. Use what was granted; do not ask again for what was denied.

## Elsewhere (for example Claude Code on a workstation)

- Call: `curl -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header" $SPEAKER_URL/<service>/<path>`
- No header file, or error `enroll`: follow the setup in `$SPEAKER_URL/_speaker/help`.
- No access yet: repeat the call with `-H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>' --max-time 70`.
- Every error has `next`: do exactly that. Tell the user what `tell_user` says. On `denied`, stop.
- Everything else (requests, SSH, folders, secrets, `/me`): `$SPEAKER_URL/_speaker/help`.
