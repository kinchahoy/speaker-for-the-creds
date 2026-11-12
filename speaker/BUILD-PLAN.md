<!-- author: ai -->

# Speaker: build plan

<sub>AI-written</sub>

How the design in [DESIGN.md](DESIGN.md) gets built. The design is the specification; [USECASES.md](USECASES.md) walks the main flows. Each phase is built by a subagent on its own branch, reviewed and tested before it is merged into main.

## Rules for every phase

- Glue maintained libraries and standard tools together; keep custom code small.
- Make the main path work well; fail fast with a clear message; add edge-case handling only when a real need shows up.
- `mise run format`, `mise run check` and `mise run test` pass for both packages before a merge.
- Commit messages say what changed and why; no AI attribution.
- Only the owner's go merges a phase into main.

## Phases

| # | Phase | Contents | Depends on |
| --- | --- | --- | --- |
| 1 | Core model | New names everywhere; items as strings with `want` lists; per-item decisions; memory-only state; open / ask / never; `.full`; POST read paths; `Speaker-Wait` up to 120 s; `/me`; error codes; three denials per item; bottle-school's speaker client moved to the new API | — |
| 2 | Keys and sign-in | One encrypted store (service keys, sandbox secrets, speaker's SSH key); unlock at sign-in; password form; `locked` state and push; sandbox secrets move from bottle-school into speaker | 1 |
| 3 | Cards and admin | Checkbox per group, member and item; groups as rows; tint for powerful items; Extend and Revoke; End for SSH sessions; Log as an in-memory buffer | 1 |
| 4 | SSH and folders | Jump server (stock OpenSSH) and relay; one key per agent; targets and shares in Setup; folder limits on file transfer; `scp`, `sftp`, `sshfs`; replaces the SSH certificate feature | 1, 2 |
| 5a | Secrets proxy | Speaker's HTTPS proxy that inserts secrets, for direct agents (`gh` through speaker) and sandbox hosts; `secret:` for any agent; services without a key (remote MCP servers) | 1, 2 |
| 5b | bottle-school | Templates with `want`, `label`, duration; secret-host traffic sent to speaker's proxy and `secrets.env` retired; remote MCP servers reached as speaker services; report shares it holds; a grant counts once in force; drop grants after 30 s without speaker | 5a |
| 6 | Skill and help | Core skill and one `/help` page rewritten for the final flow | 1–5 |

Phases 4 and 5a run in parallel; 5b follows 5a; 6 comes last.

## To explore later

- One WebSocket per agent instead of most routes (DESIGN.md).
- A slimmer VM runtime if every folder goes over SSH (DESIGN.md).
