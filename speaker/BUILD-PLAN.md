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
| 5 | bottle-school | Identity fields; templates with `want`, `label`, duration; folder delivery by VM mount; secrets received from speaker; drop grants after 30 s without speaker | 1, 2 |
| 6 | Skill and help | Core skill and one `/help` page rewritten for the final flow | 1–5 |

Phases 2 and 3 both reshape `server.ts` and run one after the other; 4 and 5 can run in parallel.

## Planned after the core build

- Speaker inserts sandbox secrets itself, so the sandbox host never holds them (see DESIGN.md).

## To explore later

- One WebSocket per agent instead of most routes (DESIGN.md).
- A slimmer VM runtime if every folder goes over SSH (DESIGN.md).
