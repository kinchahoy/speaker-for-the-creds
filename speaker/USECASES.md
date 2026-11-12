<!-- author: ai -->

# Speaker: use cases

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab credentials, hosts and folders without holding keys. The owner approves from a phone. This document lists the scenarios speaker has to serve well, walks each one through the design, and ends with the gaps that walk found.

There are two kinds of agent, and they need different things.

- **Direct agents** (Claude Code on a workstation or laptop) already have their own internet, files and tools. They come to speaker only for what needs the owner's credentials or hosts: homelab services, SSH to homelab hosts, and folders on other machines. They never need `site:`, `secret:`, `mcp:` or `ext:`.
- **Sandboxed agents** (Pi inside a bottle-school VM) start with nothing. Besides the three things above, they need websites, injected secrets, MCP servers, extensions and folder mounts.

Eight scenarios cover real use: four for direct agents, four for sandboxed agents. A ninth, about where speaker runs, matters to the owner only. Several things were left out on purpose: a direct agent asking for websites (never needed), a sandboxed agent using a homelab service or SSH (the same as scenarios 1 to 3, with the differences noted under "Sandboxed agents"), and unattended or scheduled tasks (every task starts with an owner tap, by design).

"Weak agent" below means a small model that follows steps literally, copies commands exactly, and does not improvise around errors.

---

## Direct agents

### 1. Use a homelab service (read, then full)

**Who and where.** Claude Code on the owner's laptop, asked to "update the PrimeX homelab notes in Obsidian". Speaker is on the home server.

**What the owner wants.** To see one card on the phone saying what the agent wants and why, tap once, and have the agent finish. Reads should be cheap; writes should be visible.

**Flow.**
1. The owner's prompt says speaker's address. The agent fetches `/skill.md`, then `/_speaker/help`, and follows the setup steps: create a random token, save it in a user-only header file, enroll with the token's hash, its label (`Update the PrimeX homelab notes`), its identity (`Opus 5.5 · Claude Code on PrimeX`) and a first request (`obsidian.read`, reason, duration).
2. Speaker holds the reply and files a request. The owner's phone gets a push with a link. The card shows the label, agent string, source address, token fingerprint, the reason, a duration picker preset to what the agent asked, and the item `obsidian.read`.
3. The owner taps Approve. The enrollment call returns `granted`.
4. The agent calls `GET $SPEAKER_URL/obsidian/...` with the header file. Speaker checks the grant, adds the real key, forwards the call and returns the reply.
5. The agent now needs to change a note. It sends `PUT $SPEAKER_URL/obsidian/...` with `Speaker-Wait: 90` and `Speaker-Reason: Save the updated notes`. Speaker files a request for `obsidian.full` and holds the call. The card has a slightly different colour because it can change things.
6. The owner approves. Speaker forwards the held call and the agent gets the result in the same call.

Variation: if the owner marked a service's reads open (for example "are the lights on"), an enrolled agent reads it with no card, but only if the owner told it the service name.

**For a weak agent.** Setup must be copy-pasteable with no choices. The first call after enrollment must work with the exact text in `/help`. Every non-success reply must carry `next` as a literal command. The agent needs the exact service name from the owner's prompt. A hold must be short enough for its tool timeout.

**Gaps met here.** 1, 2, 3, 4, 5, 6.

### 2. Run commands on a homelab host

**Who and where.** Claude Code on a workstation, told "check disk space on `nas`".

**What the owner wants.** The agent runs commands on `nas` as a limited account for a short time. The owner sees the account name and, afterwards, every command that ran.

**Flow.**
1. The agent (already enrolled) generates a throwaway SSH key and posts `{"want":["ssh:nas"],"sshKeys":{"ssh:nas":"ssh-ed25519 …"},"reason":"…","duration":"30m"}` to `/_speaker/requests`. Speaker holds the reply.
2. Speaker checks that `nas` exists and can be delivered to this agent. The name comes only from the owner's prompt; a typo is answered `denied` at once and appears in the Log, with no card.
3. The card shows the account the commands will run as (for example `agent`), a warning if that account has passwordless sudo, and the write-style colour. The owner approves for 30 minutes.
4. Speaker opens its SSH port, writes one key line for this grant, and returns `granted`. The agent calls `GET /_speaker/me` and copies the ready-made command, including the port, the pinned host key and `-o IdentitiesOnly=yes -o BatchMode=yes`.
5. The agent runs `ssh … s@speaker 'df -h'`. Speaker's relay runs the command on `nas` with speaker's own key and returns output and exit code. The Log records the exact command.
6. At 30 minutes, or on Revoke, the session ends and the key line is removed.

**For a weak agent.** It must copy the command from `/me` and change only the command text. It must know there is no terminal: no prompts, no editors, no `sudo` password. When SSH stops working it must have a way to find out why.

**Gaps met here.** 7, 8, 9, 10, 11.

### 3. Fetch or deliver files on another machine

**Who and where.** Claude Code on a MacBook or workstation, told to "copy the latest scan from the `scans` share" or "put the report in `reports`".

**What the owner wants.** The agent touches one folder only, read-only unless a write was approved. The owner never has to think about where the share lives.

**Flow.**
1. The agent requests `folder:scans` (or `folder:reports:rw`) with a throwaway key and a reason. The share's delivery for a direct agent is always over SSH. The card says "over SSH", the share, and read-only or read-write.
2. The owner approves. `/me` shows the exact `scp`, `sftp` and `sshfs` lines for this grant, with paths relative to the share.
3. The agent copies the file with `scp -P <port> -i <key> s@speaker:latest.pdf .`. The relay checks that the path stays inside the share, refuses writes on a read-only grant, and logs the file operation.
4. If the agent tries `rsync`, `scp -O` or a shell command on the grant, it gets a refusal that says to use `sftp`.

**For a weak agent.** The commands in `/me` must work as printed on the agent's operating system, and must be non-interactive (`sftp` in batch mode). It must be told to prefer `scp` for a few files and to ask for an `ssh:` grant instead when it needs `grep -r` or `find` on the remote side.

**Gaps met here.** 12.

### 4. Access ends while the agent is working

**Who and where.** Any direct agent, partway through a longer task.

**What the owner wants.** A grant that runs out, is denied, is revoked, or is lost in a restart should be calm for everyone. The agent stops or asks again, tells the user what happened, and does not pester.

**Flow, expiry.**
1. A service call with an ended grant returns `approval_required` with a `next` that repeats the call with `Speaker-Wait`. The agent repeats it; the owner sees a new card; if approved, the call goes through. For SSH and folders, the agent posts a new request.
2. The owner may instead tap Extend ("Extend 1h") before the end. The agent notices nothing and keeps going.

**Flow, denial.**
1. The owner unticks an item and taps Approve. The agent gets `denied` for it and is told to stop and tell the user.
2. A looping agent that asks again produces another card, up to three times; then it gets `retry_after` 15 minutes and no card.

**Flow, revoke.**
1. The owner taps Revoke agent. The token and all grants end at once; open SSH sessions close.
2. The agent's next call fails.

**Flow, restart.**
1. Speaker restarts and is locked. The owner gets a push, signs in, and the keys unlock. While locked, calls return `locked` with a `tell_user` line.
2. After unlock, the agent's token is unknown, so it gets `enroll` and runs setup again with its first request. The owner approves everything again.

**For a weak agent.** Each failure needs a single unambiguous next step, and the agent must never treat `denied` as something to retry. It must also relay `tell_user` to the human.

**Gaps met here.** 13, 14, 15, 16.

---

## Sandboxed agents

A sandboxed agent that needs a homelab service, SSH or a folder uses the same flows as scenarios 1 to 3, with three differences. It does no setup, because the sandbox host creates its agent and hands it a token. Its source address is the sandbox host, which speaker authenticates itself. And its network route to speaker (HTTP and the SSH port) must work from inside the VM.

### 5. Start a task from a template

**Who and where.** The owner starts "Research and summarise X" from a bottle-school template. Pi runs in a new micro-VM on the sandbox host.

**What the owner wants.** One card that shows the task, its label and what it starts with, one tap, and a VM that is ready.

**Flow.**
1. The owner starts the task. The sandbox host creates a sandboxed agent for it with the template's label, `Opus 5.5 · Pi on bottle-school` and the template's `want` list (for example `group:research`, `mcp:search`, `folder:notes`), and gets a token.
2. Speaker files the first request. The card shows the label, the agent string, the source address (the sandbox host), the sandbox host and task id (speaker's own knowledge), and the items.
3. The owner approves on the phone. Speaker sends each grant over the sandbox host's WebSocket; the host applies them inside the VM and reports back.
4. Pi works with what was granted. If the owner is slow, Pi's calls say approval is pending.
5. When the task ends, the sandbox host deletes the agent, and every grant ends.

**For a weak agent.** Pi must find itself already set up: the speaker address and token are in place, and its first instructions say what it has and what it may ask for. It must not need to enroll.

**Gaps met here.** 17, 18, 19, 20, 21.

### 6. The task needs something new mid-way (websites, tools)

**Who and where.** Pi in a running VM; the task turns out to need `example.org` or a PDF-reading extension.

**What the owner wants.** The agent asks for the smallest thing that works, with a reason. The owner sees exactly which sites or tools, and can say yes to some and no to others.

**Flow.**
1. Pi tries `curl https://example.org` and is blocked by the sandbox's network filter. The block message should say what to do.
2. Pi posts `{"want":["site:example.org"],"reason":"Read the paper the task is about","duration":"1h"}` with `Speaker-Wait`. If it needs three or more items from one group, it asks for the group instead.
3. The card lists the sites; wildcard sites and a group show as one row each. The owner approves, or unticks a site.
4. Speaker tells the sandbox host; the host opens the route; Pi retries and succeeds. A denied site is final for this task.
5. For an extension or MCP server, the same steps apply with `ext:<id>` or `mcp:<id>`; after approval Pi is told how to start using it.

**For a weak agent.** The blocked-site message must contain the exact request to send. The agent must be told that pages pull in other hosts, and that it should ask for the host it saw blocked, not a guess.

**Gaps met here.** 22, 23, 24, 25.

### 7. Use a secret without ever seeing it

**Who and where.** Pi in a VM, told to "open a pull request on my repo".

**What the owner wants.** Pi can call GitHub as the owner. The token never enters the VM and works only against the hosts the owner bound it to.

**Flow.**
1. The owner set up `GITHUB_TOKEN` once in Setup, bound to `api.github.com` and `github.com`.
2. Pi requests `secret:GITHUB_TOKEN`, reason "push the fix branch". The card should show the secret's name and the hosts it will be sent to.
3. The owner approves for 1 hour. The sandbox host starts adding the token to Pi's requests to those hosts.
4. Pi calls the GitHub API or `git push`. The request leaves the VM with the real token added outside it.
5. At the end of the grant the injection stops.

**For a weak agent.** Pi needs one literal instruction for what to type to use the secret (for example which variable or header to reference). It must never be asked to paste a token anywhere.

**Gaps met here.** 26, 27.

### 8. Work on a folder from inside the VM

**Who and where.** Pi in a VM, told to "fix the tests in `myproject`", a folder on the sandbox host (or on another machine).

**What the owner wants.** The agent edits that folder only, read-write only if approved, and the folder disappears from the VM when the grant ends.

**Flow.**
1. Pi requests `folder:myproject:rw` with the reason.
2. Speaker picks the delivery. If the sandbox host holds the folder and the share allows it, the card says "VM mount" and Pi gets a normal directory. Otherwise the card says "over SSH" and Pi must run `sshfs` through speaker, which needs FUSE in the VM.
3. The owner approves. Pi edits files and runs the tests.
4. At the end, or on Revoke, the mount is removed (or the `sshfs` mount stops working with a message).

**Owner note.** A read-write share that is a code repository lets the agent change files that run later on the owner's machine (hooks, scripts). The owner should treat `:rw` on a repository with the same care as `ssh:`.

**For a weak agent.** Where the folder appears must be stated plainly. If it came over SSH, the agent must be told that `git status` and `grep -r` are slow and that copying the working set locally is the better move.

**Gaps met here.** 28.

---

## Owner and operations

### 9. Where speaker runs: a home server or one MacBook

**Who and where.** The owner, deciding where the single speaker container lives.

**What the owner wants.** Either a home server behind a reverse proxy (agents and phone reach it by one HTTPS address), or everything on a single MacBook: speaker, Claude Code, bottle-school, and the owner's own browser.

**Flow, home server.**
1. The proxy forwards HTTP to speaker with `TRUSTED_PROXY` set, and allows holds of 120 seconds. Speaker reads the agent's address from the last `X-Forwarded-For` entry.
2. Agents use the public HTTPS address. The phone follows approval links to the same address. SSH goes straight to speaker's SSH port, not through the proxy.

**Flow, one MacBook.**
1. Speaker runs in a local container. Direct agents use `http://localhost`. The owner signs in to `/admin` in a browser on the same machine over plain HTTP, and the sign-in page says so. Cards can be approved at the laptop or on the phone if the phone can reach the laptop.
2. Sandbox VMs reach speaker through the laptop's own network address, not `localhost`.

**For a weak agent.** It must be given one working address and see only commands that work from where it runs.

**Gaps met here.** 29, 30, 31.

---

## Gaps found in the design

1. **Setup and Requesting access.** A direct agent must put its first request in the enrollment call, but names (groups, services) are only visible after enrolling; allow enrollment with an empty `want`, or have `/skill.md` say that when no names were given, the agent enrolls empty and reads `/me`.
2. **Service rules and Knowing where it stands.** It is unclear whether `/me` lists open services, which "are not listed to agents"; say that `/me` never lists them and that the owner's prompt is the only source.
3. **Items.** `<service>.read` covers only GET, HEAD and OPTIONS, but many real APIs (for example Obsidian's search) use POST for harmless queries, which would need `.full`; let Setup mark specific POST paths per service as reads.
4. **Waiting for the owner and Requesting access.** A service call without access files a request for one item, which contradicts the advice to ask for a group when three or more items are needed; state that call-triggered requests ask for the single item implied by the method, and that agents should post to `/requests` first for several.
5. **Waiting for the owner.** The maximum hold of 120 seconds plus a `--max-time` margin exceeds the common 120-second tool timeout of agent shells; make the default in `/help` 60 and show the shell-timeout caveat.
6. **Setup and Security model.** It is not said whether an agent keeps one token for all tasks (stale label, grants shared across tasks) or makes a new one per task, nor what happens when a laptop's address changes (`enroll`, grants lost); tell agents to make a new token per task, and have the card flag "same agent string, new address".
7. **Requesting access and Items.** A request for a group with `ssh:` or `folder:` members cannot carry their throwaway keys because the member names are hidden from the agent; let one key per request apply to every SSH and folder member, or have `/me` show "needs a key" slots.
8. **Items.** "Groups it may use in full" is undefined; say it means every member is deliverable to that kind of agent, and say what happens to a group that mixes kinds.
9. **Principle 4 and Using SSH.** An expired or missing SSH grant gives a bare connection refusal or "permission denied", with no `next`; make the SSH instructions say to call `/me` after any SSH failure, and show a login banner where the protocol allows.
10. **Using SSH and folders over SSH.** It is not stated whether an `ssh:` grant allows `scp` or the `sftp` subsystem; state the rule explicitly and the message given when refused.
11. **Targets.** `from="<speaker's address>"` depends on the address the target sees, which differs behind container networking, a tailnet sidecar, or a roaming laptop; have Setup show the address detected during the first test connection and allow several.
12. **Using SSH and folders over SSH, Principle 6.** `sshfs` on macOS needs macFUSE, so "nothing to install" fails for direct agents on a Mac; have `/me` print `scp` and batch `sftp` lines first and offer `sshfs` only when it is installed.
13. **Errors.** There is no code for a request that expired after 2 hours with no answer; add `expired` with a `next` to ask again.
14. **Denials and Errors.** The design says agents are not told asking again is possible, yet gives `retry_after`, and a looping agent produces up to three more cards; after any denial, answer repeats of the same item with `denied` and no card for 15 minutes, and drop the third-denial rule.
15. **Lifecycles and Errors.** After Revoke agent, the agent gets `enroll`, runs setup again and can file new requests at once; keep the revoked token's hash in memory and answer it `denied` with "stop".
16. **Durations and Lifecycles.** `30d` and "until revoked" cannot outlive a restart, which ends every grant; remove them or make the card say "ends at the next restart".
17. **Sandbox hosts.** How a sandbox host proves itself on the WebSocket and on agent creation after approval (a credential issued at approval) is not defined; issue a host secret at approval.
18. **Sandbox hosts.** How the token, the speaker URL and the core instructions reach Pi in the VM is not described, nor that the VM must always reach speaker's HTTP and SSH ports, nor whether the task waits for its first decision; define these as baseline.
19. **Sandbox hosts.** Templates carry `want` and `label` but no duration, and tasks can outlast a 2-hour default; add `duration` to templates. Related and undecided: whether sandbox secrets are stored in speaker or in the sandbox host changes who injects them in scenario 7.
20. **Names and Requesting access.** Where agents learn secret, `mcp:`, `ext:` and share names is unspecified; say they come from the task prompt, the template, or groups shown in `/me`, and let the sandbox host tell its agents what its catalog offers. (If `mcp:` and `ext:` merge into one add-on item, this applies to that item; credentialed remote MCP servers reached as speaker services follow scenario 1.)
21. **Lifecycles (Restart) and Sandbox hosts.** After a restart, speaker's memory of sandbox agents is gone; define that the sandbox host re-creates its running agents and re-sends their first requests as one card.
22. **Sandbox hosts.** The reply a blocked site gets inside the VM comes from the sandbox host, not speaker, so principle 4 does not reach it; require a block message with the exact request to make.
23. **Items.** It is unclear whether `site:*.example.org` includes `example.org` itself; state it.
24. **Sandbox hosts.** An approval can reach speaker before the sandbox host has applied it, so an immediate retry fails; have the decision reply wait for the host's "in force" report.
25. **Items and Sandbox hosts.** What happens in the VM after `mcp:` or `ext:` is granted (restart, reload, a new tool list) is not described; say how Pi is told and whether it must reload.
26. **Items (`secret:`) and Setup.** How an agent uses a secret (variable name, header, scheme) and how it is injected into the request are not stated; add the injection form to the secret's Setup entry and show the exact usage in `/me`.
27. **Items (`secret:`) and The owner's side.** It is unclear whether a secret also needs a `site:` grant for its hosts, and the card spec does not show bound hosts or tint `secret:` items; say a secret allows only its bound hosts and show them in the card with the write colour.
28. **How a folder grant reaches the agent.** How speaker learns which sandbox host holds a share, where the VM mount appears, and that the guest image must carry FUSE for `sshfs` are not covered; have the host register its shares, and `/me` give the mount path.
29. **Deployment and How an agent works.** One public URL is used in every command, but on one MacBook direct agents use `localhost` and VMs need the laptop's address; let speaker answer with the URL that matches the caller's route, or accept two configured addresses.
30. **Deployment and Security model.** On one machine, container networking can make all local clients share one source address, so token binding does not separate a direct agent from the sandbox host, and an agent running as the owner can reach the owner's files and Docker; state what the single-laptop shape protects (accidents and audit, not a hostile agent) and recommend keeping keys only in speaker.
31. **Deployment.** The reverse-proxy shape does not mention that the SSH port bypasses the proxy, or how a phone away from home reaches the approval link; add both to the proxy and tailnet notes.
