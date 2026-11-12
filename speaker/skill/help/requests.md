## Items

An item is one thing you can be granted, written as a string.

| Item | Means |
| --- | --- |
| `<service>.read` | read from a service (GET, HEAD, OPTIONS, and any POST paths the owner marked as reads; for an MCP service, listing and read-only tools) |
| `<service>.full` | read, and change things |
| `site:<host>`, `site:*.<domain>` | network access from a sandbox; `*.` covers subdomains only, not the bare domain |
| `secret:<NAME>` | a secret a sandbox uses without seeing it |
| `folder:<share>`, `folder:<share>:rw` | a folder from the sandbox host |
| `mcp:<id>`, `ext:<id>` | an MCP server or Pi extension from the sandbox host's list |
| `group:<name>` | every item in a group the owner defined |

`site:`, `secret:`, `folder:`, `mcp:` and `ext:` work only in a sandbox. Some services are open to read: use one only when the owner told you its name; it needs no request.

## Asking

`POST /_speaker/requests` with `{"want":["<item>", ...],"reason":"<one sentence>","duration":"2h"}`. Durations: `30m`, `1h`, `2h` (default), `1d`, `30d`. Ask for the minimum the task needs. If you need three or more items from one group in `/me`, ask for the group; otherwise ask for exactly those items.

Add `Speaker-Wait: 60` (at most 120, and `--max-time` a little above it) to hold the reply until the owner decides. The reply is `{"granted":[...],"denied":[...],"expiresAt":"..."}` per item: work with what was granted and do not ask again for what was denied. Repeating the call joins your pending request. A request not decided in 2 hours expires.

A service call without access files a request for exactly that service's `.read` (GET, HEAD, OPTIONS) or `.full` (other methods): add `Speaker-Wait: 60` and `Speaker-Reason: <one sentence>`.

## Errors

Every error is JSON with `error`, and where useful `next` (the exact thing to do) and `tell_user` (tell the person; it has the approval link).

| `error` | Do |
| --- | --- |
| `enroll` | run the setup again with a new token |
| `approval_required` | repeat the call with `Speaker-Wait: 60`, and tell the user |
| `denied` | stop; tell the user. If `retry_after` (a time) is present, do nothing before then |
| `invalid` | fix the input; the reply lists what is accepted |
| `rate_limited` | wait, then retry |
