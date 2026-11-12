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

## Status

All six phases are merged into main and pass their tests. An end-to-end run on one Linux machine (speaker and bottle-school together, a real VM, no real model) passed: sign-in and the locked state; a direct agent following `/_speaker/help` verbatim (held call approved through a card, SSH command, `scp`, `sftp` inside a read-only share with escapes refused, a secret through the proxy with real `curl`); and from inside a VM: speaker reachable, a site blocked until its card was approved, a dummy secret arriving at the upstream while appearing nowhere in the VM, bottle-school's config, environment or logs, revoke stopping both within seconds, a read-only folder mounted at `/input/<share>` and removed on revoke, and a task's agent ending with the task. Bugs found then were fixed on main (guest build pin, zombie Pi restarts, prompted hosted-model tasks, VM-mounted folders needing an SSH key, the jump server outliving speaker).

After the build, a refactor (no route or response changes) split `server.ts` into `core.ts`, `api.ts`, `admin.ts` and `server.ts` (see DESIGN.md, Code), made the jump server speaker's own listener handing each connection to `sshd -i`, and rebuilt the admin UI on Pico CSS and htmx (DESIGN.md, The owner's side). The Phase 2 and 3 notes below on page layout predate that rebuild.

Not yet verified: `sshfs`, the PowerShell setup steps, a hosted model with a real key (the stored OpenRouter key on this machine is a 9-character stub), real model work by Pi, and `gh`/`git` against GitHub.

## Redeploying speaker and bottle-school together

Both must move at once; the API, admin sign-in and secret handling changed.

1. **speaker settings** (`speaker/.env`): remove `ADMIN_USER` and `ADMIN_PASSWORD`; set `TRUSTED_PROXY` to the reverse proxy's address; set `PROXY_PORT` (secrets proxy) and `SSH_PORT` (jump server) and publish both (they do not go through the web proxy).
2. **Start speaker and open `/admin`:** set the owner password. Existing plaintext key files are imported into the encrypted store and deleted. From then on, after every restart, sign in to unlock.
3. **Secrets:** re-enter each secret from bottle-school's old `secrets.env` in speaker's Setup (name, value, allowed hosts, variable name), then delete `secrets.env`; bottle-school refuses to start while it exists.
4. **bottle-school:** rerun `mise run init bottle-school --force` (templates and catalog changed format; it registers the host again and learns speaker's `PROXY_PORT`), approve it in `/admin`, and remove the old one.
5. **SSH targets:** in Setup, add each target and put the shown line into the chosen account's `authorized_keys`.
6. **Guest image:** rebuild `pi-v5-guest`, then restart bottle-school.
7. **Agents:** direct agents enroll again by following `$SPEAKER_URL/_speaker/help`.

## To explore later

- One WebSocket per agent instead of most routes (DESIGN.md).
- A slimmer VM runtime if every folder goes over SSH (DESIGN.md).

## Decisions taken during the build

Calls made where the design left room; each can be revisited.

**Phase 1 (core model)**
- A request's `granted` and `denied` list concrete items: groups are expanded when the request is made.
- A request for an item whose rule is `never` is denied at once, without a card; open reads are answered without a grant.
- The same token enrolled again from a different address is refused (`invalid`); the agent runs setup again.
- Agents with no grant and no call for 7 days are dropped; decided and expired requests are kept for 24 hours.
- Removing a sandbox host ends its agents.
- `/_speaker/help/<service>` needs an agent token; `/_speaker/help` is public.

**Phase 2 (keys and sign-in)**
- Locked means "a store exists and nobody has signed in since start"; before the first password is set, agent calls are not locked.
- The whole vault (service keys, secrets with their hosts and variable names, speaker's SSH key and certificate authority) is one encrypted blob; only service settings stay in plain JSON.
- Sessions last 12 hours; sign-in allows 5 failed attempts per address per 15 minutes; there is no sign-out button.
- Secrets and the password form live at the bottom of the Services page.

**Phase 3 (cards and admin)**
- Cards read group names and descriptions from the current groups at render time; a group deleted since the request shows its items as loose items.
- Approve with none of the shown items still pending answers 409.
- Grants and agents are one Active section; time left is shown per grant.

**Phase 4 (SSH and folders)**
- The login name in agents' SSH commands is the account speaker runs as (`node` in the image), not `s`: a non-root `sshd` can only log in its own user.
- No maintained library parses SFTP from a plain stream, so `speaker/sftp.ts` is a small parser for the SFTP v3 packets clients use; the target's own `sftp-server -d <path> [-R]` does the file work.
- Command lines pin the jump server's host key through a `known_hosts` file the agent saves once from `/me` (`knownHosts`), so nothing prompts; older `sshfs` rejects `KnownHostsCommand`.
- On an `ssh:` grant, `scp`/`sftp` paths are `<target>/<absolute path>` with no folder limit; a share with the same name as a target takes precedence.
- Refusal messages reach `ssh` command sessions; in `sftp`/`scp` sessions a refusal shows as "permission denied" and in the Log. Path operations are logged; reads and writes on open files are not logged one by one.
- The jump server's runtime files live in a private temporary directory (public keys, the ssh-agent socket, its per-start host key); speaker's private key goes straight into `ssh-agent`.
- An `ssh:` or `folder:` request without an `sshKey` is refused (400); `compose.yaml` publishes `SSH_PORT` 2222 by default.
- Not yet verified on a real machine: `sshfs` (not installed where it was built), expiry through `expiry-time`, the passwordless-sudo warning.

**Phase 5a (secrets proxy)**
- The proxy listens on `PROXY_PORT`; clients authenticate with their agent token as the proxy password; the user name is ignored.
- Allowed hosts match by name; any port in `CONNECT` is accepted.
- Only the `Authorization` header is rewritten; other headers and bodies pass as sent.
- Certificates: ECDSA P-256 with `@peculiar/x509`; the authority's key is in the vault and its certificate is served at `/_speaker/proxy/ca.pem`.
- `secret:` is offered to direct agents only when `PROXY_PORT` is set.
- A `secret:` request for a name not in Setup still makes a card, marked "not set up".

**Phase 5b (bottle-school)**
- Secret route: for a secret's hosts, bottle-school's egress proxy (and its model door, for hosted providers) opens the upstream connection as a `CONNECT` tunnel to speaker's proxy, authenticated as the task's agent; speaker inserts the value. If the proxy is unconfigured, locked or unreachable, the request is refused, never sent directly.
- The guest gets no `HTTPS_PROXY` and no extra certificate; Pi reads the placeholder from `/me` and sets the variable on the one command that needs it (DESIGN.md's worked example now says so).
- `secrets.env` and `BROKER_SECRET_*` are gone; bottle-school refuses to start while either is still present. Hosted model keys are speaker secrets too.
- `catalog.json` holds only MCP servers that run inside the VM; remote ones are speaker services (keyless Context7 and Parallel Search ship as examples). Pi calls them at `$SPEAKER_URL/<service>`.
- Templates: `want`, `label`, `duration` (shipped templates use `group:<id>` for 1 day); an old `bundle` key fails loudly.
- A sandbox-only grant shows as `applying` until bottle-school reports it in force; held calls wait for it, except `mcp:` and `ext:`, which need Pi idle.
- bottle-school reports its shares on every connection and drops all grants after 30 seconds without speaker.
- `config.json` gains `speaker.proxyPort`, which must equal speaker's `PROXY_PORT`.
- Not yet verified in a real VM: `gh`/`git` through the secret route, hosted-model keys, Pi with the new instructions.

**Phase 6 (skill and help)**
- The core skill is about 250 tokens and is served at `/` and `/skill.md`; the one help page (`skill/help.md`, about 1,350 tokens) replaces the per-topic pages.
- Held calls use `Speaker-Wait: 60` with curl's `--max-time 70`.
- The help page keeps the agent's throwaway SSH key at `$d/ssh_key`, next to the header file, and assumes its sh steps run in one shell.
- Remote MCP services appear in `/me` with `mcp: true`; the MCP client points at `$SPEAKER_URL/<service>` with the header file's `Authorization`.
