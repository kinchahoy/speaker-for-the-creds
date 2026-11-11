# Capability kinds

| Kind | `ref` | Example |
| --- | --- | --- |
| `credential` | `<provider>.read` or `<provider>.write` | `obsidian.read` |
| `site` | `<host>` or `*.<domain>` | `pypi.org` |
| `secret` | `<NAME>@<host>[,<host>]` | `GITHUB_TOKEN@api.github.com` |
| `folder` | `<share>` or `<share>:rw` | `photos:rw` |
| `mcp` | `<catalog id>` | `context7` |
| `extension` | `<catalog extension id>` | `pi-web-access` |

Only `credential` works in a direct session; the rest work in a sandbox.

For a provider, GET, HEAD and OPTIONS need `<provider>.read`; other methods need `<provider>.write`. For an MCP provider, listing tools and read-only tools count as read; other tool calls count as write.

Policies: `always` needs no request (for up to 90 days after your session's approval), `approval` is asked for on use, `deny` is never granted, so do not request it.
