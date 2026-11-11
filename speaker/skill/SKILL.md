---
name: access-and-creds
version: 2
description: "Get owner-approved access through speaker: homelab APIs and HTTP MCP servers (Obsidian notes, Karakeep, Home Assistant), plus sites, secrets, folders and MCP servers inside a sandbox. Use when a task needs a credential or API key you lack, or a call returns 401 or 403."
---

# Access and credentials

Speaker holds the real keys and the owner approves each grant. Never ask for or use an upstream key or the admin API, and keep your speaker token out of output, notes and command lines.

- In a sandbox (`BOTTLE_SCHOOL=1`) you are already enrolled: read `$SPEAKER_URL/_speaker/help/sandbox` and skip setup.
- No header file yet, or a 401 whose `next` says enroll: run the setup in `$SPEAKER_URL/_speaker/help/setup` (copy-paste sh or PowerShell, nothing to install).
- Call `$SPEAKER_URL/<provider>/<path>` with `curl -H @"${XDG_STATE_HOME:-$HOME/.local/state}/speaker/header"`. Read `GET /_speaker/providers/<name>/guide` before the first call to a provider; `GET /_speaker/providers` lists them.
- Without access, add `-H 'Speaker-Wait: 60' -H 'Speaker-Reason: <one sentence>'`: speaker asks the owner and answers the call once approved. Tell the user to approve at `$SPEAKER_URL/admin`.
- Any 401 or 403 has a `next` field: do exactly that, and pass on `tell_user`. Stop on `denied`; never reach a denied service another way.
- SSH to a homelab host: `/_speaker/help/ssh` (a short-lived certificate for your own key).
- More: `/_speaker/help/requests` (asking and extending), `/_speaker/help/kinds`, `/_speaker/help/bundles`.
