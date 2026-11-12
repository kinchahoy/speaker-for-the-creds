---
name: access-and-creds
version: 6
description: "Get owner-approved access through speaker: homelab APIs (Obsidian, Home Assistant, ...), SSH hosts, folders, websites, and secrets such as GitHub tokens. Use when a task needs access, a credential, API key, token, SSH or `gh` you lack, or a call returns 401 or 403."
---

# Speaker

Speaker holds the owner's keys. The owner approves each use from a phone. Never ask for or use an upstream key. Never print your speaker token.

## In a sandbox (`BOTTLE_SCHOOL=1`)

You are already enrolled. To get anything you need, call the `request_capability` tool once, listing every item:

- website: `site:<host>`. Once granted, fetch it.
- shared folder: `folder:<share>`; add `:rw` to write. Once granted, it is at `/input/<share>`.
- secret: `secret:<NAME>`. Once granted, `$SPEAKER_URL/_speaker/me` gives the placeholder variable. Set it on the one command that needs it.
- homelab API or remote MCP server: `<service>.read` or `<service>.full`. Call `$SPEAKER_URL/<service>/<path>` with `Authorization: Bearer $SPEAKER_TOKEN`.
- MCP server or extension from this sandbox's catalog: `mcp:<id>`, `ext:<id>`

The tool waits for the owner and reports what was granted. Use what was granted. Do not ask again for what was denied.

## Elsewhere (for example, Claude Code on a workstation)

- Call: `curl -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header" $SPEAKER_URL/<service>/<path>`
- No header file, or error `enroll`: follow the setup in `$SPEAKER_URL/_speaker/help`.
- No access yet: repeat the call with `-H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>' --max-time 70`.
- Every error has `next`. Do exactly that, and tell the user what `tell_user` says. On `denied`, stop.
- For everything else (requests, SSH, folders, secrets, `/me`), read `$SPEAKER_URL/_speaker/help`.
