---
name: task-workflow
description: Complete the owner task, request approved capabilities, and use network and homelab APIs inside the sandbox.
---

<!-- author: ai -->

# Task workflow

1. Read the whole task before you act. Note the deliverable, its format, and any stated limits.
2. Write a short plan of three to six steps.
3. Do the work in `/work`. `/input` is read-only. `/output` is permanent.
4. Put every deliverable in `/output`.
5. Test the deliverable the way its user will use it. Fix failures before you continue.
6. Record assumptions, and anything you could not finish, in `/output/NOTES.md`.
7. Write `/output/DONE` only when the whole task is complete and verified. Its one line says what was delivered.

Do not write `/output/DONE` for partial work. When you are blocked, say so in `/output/NOTES.md` and in your final reply.
{.ai}

When a step needs a site, secret, folder, MCP server, or homelab credential you lack, follow Requesting a capability and request a lease. Then continue with other work while you wait.
{.ai}

# Requesting a capability

Use this when an HTTP request returns 403, or when a tool or folder you need is missing. A 403 also appears after a lease expires.
{.ai}

1. Confirm the cause. A denied HTTP request returns 403.
2. Call `request_capability` once for each missing capability.
   - `kind` and `ref`: the capability, in the format below.
   - `bundle`: a bundle name, in place of `kind` and `ref`.
   - `reason`: one sentence on what the request unblocks.
   - `duration`: `15m`, `30m`, `1h`, `1d`, `7d`, or `30d`. Ask for the shortest that fits the task.
3. The tool waits up to 30 minutes for the owner and returns one result:
   - `The owner approved ... Retry now.`: retry the blocked step once.
   - `The owner denied ...`: continue without it, or record in `/output/NOTES.md` what is blocked.
   - `... expired undecided` or `has not decided yet`: continue other work. Do not ask again for the same capability.
4. Do not retry in a loop.

| Kind | `ref` format | Example |
| --- | --- | --- |
| `site` | `<host>` or `*.<domain>` | `pypi.org` |
| `secret` | `<NAME>@<host>[,<host>]` | `GITHUB_TOKEN@api.github.com` |
| `folder` | `<share>` (read-only) or `<share>:rw` | `photos:rw` |
| `mcp` | `<catalog id>` | `context7` |
| `credential` | `<provider>.read` or `<provider>.write` | `paperless.read` |

A request grants nothing until the owner approves it. Do not reach the same destination by another route.
{.ai}

## Getting a missing tool

Prefer a package registry to a binary download. One `site` lease covers many versioned packages.
{.ai}

1. Python and many CLI tools: `uv add <package>`. Needs `pypi.org,files.pythonhosted.org`; see Network access.
2. JavaScript and TypeScript tools: `pnpm add <package>`. Needs `registry.npmjs.org`.
3. When no registry package exists, request the download host. GitHub release downloads need `github.com` and `release-assets.githubusercontent.com`.

# Network access

Request each host with `request_capability`, `kind: site`, `ref: <host>`. Request every host in a row of the table, one call per host. The owner may approve a named bundle in one step; ask for the bundle when one exists.
{.ai}

| Need | Hosts to request |
| --- | --- |
| Python packages (`uv add`) | `pypi.org`, `files.pythonhosted.org` |
| npm packages (`pnpm add`) | `registry.npmjs.org` |
| Clone a GitHub repository over HTTPS | `github.com`, `codeload.github.com` |
| Raw files from GitHub | `raw.githubusercontent.com` |
| GitHub release downloads | `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` |
| Hugging Face models and datasets | `huggingface.co`, `cdn-lfs.huggingface.co`, `cas-bridge.xethub.hf.co` |
| Rust crates (`cargo`) | `crates.io`, `index.crates.io`, `static.crates.io` |
| Go modules | `proxy.golang.org`, `sum.golang.org` |

- For any other site, request the exact hostnames the tool contacts. A 403 response names a blocked request; check redirects too.
- Request only what the task needs. A leased site expires; a later 403 can mean the lease ended, so request it again.

## Homelab APIs

Homelab APIs go through speaker. They use `kind: credential`, `ref: <provider>.read` or `<provider>.write`.
{.ai}

- Call `$SPEAKER_URL/<provider>/<path>` with the header `Authorization: Bearer $SPEAKER_TOKEN`.
- Speaker adds the provider's real credential. You never see it.
- A call without a lease returns `403 approval_required` and a `requestId`. Request the credential, then retry.
- `GET $SPEAKER_URL/_speaker/providers` lists providers. `GET $SPEAKER_URL/_speaker/providers/<name>/guide` returns a provider's guide.
