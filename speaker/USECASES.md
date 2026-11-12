<!-- author: ai -->

# Speaker: use cases

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab credentials, hosts and folders without holding keys. The owner approves from a phone. This document lists the scenarios speaker has to serve well, walks each one through the design, and ends with the points that are still open.

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
1. The owner's prompt says speaker's address. The agent fetches `/skill.md`, then `/_speaker/help`, and follows the setup steps: create a random token, save it in a user-only header file, and enroll with `POST /_speaker/agents` using the token's SHA-256, its label (`Update the PrimeX homelab notes`), its identity (`Opus 5.5 · Claude Code on PrimeX`) and a first request (`obsidian.read`, reason, duration), with `Speaker-Wait`.
2. Speaker holds the reply and files a request. The owner's phone gets a push with a link. The card shows the label, agent string, source address, token fingerprint, the reason, a duration picker preset to what the agent asked, and the item `obsidian.read`.
3. The owner taps Approve. The enrollment reply lists `obsidian.read` under `granted`.
4. The agent calls `curl -H @<header file> $SPEAKER_URL/obsidian/...`. Speaker checks the grant, adds the real key, forwards the call and returns the reply.
5. The agent now needs to change a note. It sends `PUT $SPEAKER_URL/obsidian/...` with `Speaker-Wait: 90` and `Speaker-Reason: Save the updated notes`. Speaker files a request for `obsidian.full` and holds the call. The card has a slightly different colour because `.full` can change things.
6. The owner approves. Speaker forwards the held call and the agent gets the result in the same call.

Variation: if the owner marked a service's reads open (for example "are the lights on"), an enrolled agent reads it with no card, but only if the owner has told it the service name. Open services never appear in `/me`.

**For a weak agent.** Setup must be copy-pasteable with no choices. The first call after enrollment must work with the exact text in `/help`. Every non-success reply must carry `next` as a literal command. The agent needs the exact service name from the owner's prompt. A hold must be short enough for its tool timeout.

### 2. Run commands on a homelab host

**Who and where.** Claude Code on a workstation, told "check disk space on `nas`".

**What the owner wants.** The agent runs commands on `nas` as a limited account for a short time. The owner sees the account name and, afterwards, every command that ran.

**Flow.**
1. The agent (already enrolled) generates a throwaway SSH key and posts `{"want":["ssh:nas"],"sshKey":"ssh-ed25519 …","reason":"…","duration":"30m"}` to `/_speaker/requests`, with `Speaker-Wait`. An agent sends its SSH key once, so later requests omit it. Speaker holds the reply.
2. Speaker checks that `nas` exists and can be delivered to this agent. The name comes only from the owner's prompt; a request for an unknown target is answered `denied` at once and appears in the Log, with no card.
3. The card shows the account the commands will run as (for example `agent`), a warning if speaker found passwordless sudo on that account when the target was added, and the colour used for `ssh:` items. The owner approves for 30 minutes.
4. Speaker starts its SSH port (it listens only while an SSH or folder grant is active), writes one key line for the agent, and returns `granted`. The agent calls `GET /_speaker/me` and copies the ready-made command, including the port, the pinned host key and `-o IdentitiesOnly=yes -o BatchMode=yes`.
5. The agent runs `ssh … s@speaker nas 'df -h'`. Speaker's relay runs the command on `nas` as the agent account and returns output and exit code. The Log records the exact command.
6. At 30 minutes, or on Revoke, the session ends and the key line is removed.

**For a weak agent.** It must copy the command from `/me` and change only the command text. It must know there is no terminal: no prompts, no editors, no `sudo` password. When SSH stops working it must have a way to find out why.

### 3. Fetch or deliver files on another machine

**Who and where.** Claude Code on a MacBook or workstation, told to "copy the latest scan from the `scans` share" or "put the report in `reports`".

**What the owner wants.** The agent touches one folder only, read-only unless a write was approved. The owner never has to think about where the share lives.

**Flow.**
1. The agent requests `folder:scans` (or `folder:reports:rw`) with a reason, and with its throwaway key if it has not sent one yet. A direct agent gets folders over SSH, if the share allows it; otherwise the item is answered `denied`. The card says "over SSH", the share, and read-only or read-write.
2. The owner approves. `/me` shows the `scp` and `sftp` lines for this grant first, then `sshfs`. Every path in them starts with the share name.
3. The agent copies the file with `scp -P <port> -i <key> s@speaker:scans/latest.pdf .`. The relay checks that the path stays inside the share, refuses writes on a read-only grant, and logs the file operation.
4. If the agent tries `rsync`, `scp -O` or a command on the grant, it gets a refusal that says to use `sftp`.

**For a weak agent.** The commands in `/me` must work as printed on the agent's operating system, and must be non-interactive (`sftp` in batch mode). It must be told to prefer `scp` for a few files and to ask for an `ssh:` grant instead when it needs `grep -r` or `find` on the remote side.

### 4. Access ends while the agent is working

**Who and where.** Any direct agent, partway through a longer task.

**What the owner wants.** A grant that runs out, is denied, is revoked, or is lost in a restart should be calm for everyone. The agent stops or asks again, tells the user what happened, and does not pester.

**Flow, expiry.**
1. A service call with an ended grant returns `approval_required` with a `next` that repeats the call with `Speaker-Wait`. The agent repeats it; the owner sees a new card; if approved, the call goes through. For SSH and folders, the agent posts a new request.
2. The owner may instead tap Extend ("Extend 1h") before the end. The agent notices nothing and keeps going.

**Flow, denial.**
1. The owner unticks an item and taps Approve. The agent gets `denied` for it and is told to stop and tell the user.
2. If the agent asks for the same item again anyway, it gets another card, up to three denials. After the third, it gets `denied` with `retry_after` 15 minutes later and no card until then.

**Flow, revoke.**
1. The owner taps Revoke agent. The token and all grants end at once; open SSH sessions close.
2. The agent's next call fails with `enroll`.

**Flow, restart.**
1. Speaker restarts and is locked. The owner gets a push, signs in, and the keys unlock. While locked, calls return `locked` with a `tell_user` line.
2. After unlock, the agent's token is unknown, so it gets `enroll` and runs setup again with its first request. The owner approves everything again.

**For a weak agent.** Each failure needs a single unambiguous next step, and the agent must never treat `denied` as something to retry. It must also relay `tell_user` to the human.

---

## Sandboxed agents

A sandboxed agent that needs a homelab service, SSH or a folder uses the same flows as scenarios 1 to 3, with three differences. It does no setup, because the sandbox host creates its agent and hands it a token. Its source address is the sandbox host's, and its token is bound to that address. And its network route to speaker (HTTP and the SSH port) must work from inside the VM.

### 5. Start a task from a template

**Who and where.** The owner starts "Research and summarise X" from a bottle-school template. Pi runs in a new micro-VM on the sandbox host.

**What the owner wants.** One card that shows the task, its label and what it starts with, one tap, and a VM that is ready.

**Flow.**
1. The owner starts the task. The sandbox host creates a sandboxed agent for it with the template's label, the agent string `Opus 5.5 · Pi on bottle-school`, and the template's `want` list (for example `group:research`, `mcp:search`, `folder:notes`), and receives the agent's token.
2. Speaker files the first request. The card shows the label, the agent string, the source address (the sandbox host's), the sandbox host and task id (speaker's own knowledge), and the items.
3. The owner approves on the phone. Speaker sends each grant over the sandbox host's WebSocket; the host applies them inside the VM and reports which grants are in force.
4. Pi works with what was granted. If the owner is slow, Pi's calls wait as `Speaker-Wait` allows, then answer with what to do next.
5. When the task ends, the sandbox host deletes the agent (`DELETE /_speaker/hosts/agents/<id>`), and every grant ends.

**For a weak agent.** Pi must find itself already set up: the speaker address and token are in place, and its first instructions say what it has and what it may ask for. It must not need to enroll.

### 6. The task needs something new mid-way (websites, tools)

**Who and where.** Pi in a running VM; the task turns out to need `example.org` or a PDF-reading extension.

**What the owner wants.** The agent asks for the smallest thing that works, with a reason. The owner sees exactly which sites or tools, and can say yes to some and no to others.

**Flow.**
1. Pi tries `curl https://example.org` and is blocked by the sandbox's network filter. The block message should say what to do.
2. Pi posts `{"want":["site:example.org"],"reason":"Read the paper the task is about","duration":"1h"}` to `/_speaker/requests`, with `Speaker-Wait`. If it needs three or more items from one group, it asks for the group instead.
3. The card lists items outside any group separately and highlighted, and each group as one row. The owner approves, or unticks a site.
4. Speaker tells the sandbox host; the host opens the route; Pi retries and succeeds. A denied site gets `denied`, and Pi is told to stop.
5. For an extension or MCP server, the same steps apply with `ext:<id>` or `mcp:<id>`. How Pi is then told to use it is an open point.

**For a weak agent.** The blocked-site message must contain the exact request to send. The agent must be told that pages pull in other hosts, and that it should ask for the host it saw blocked, not a guess.

### 7. Use a secret without ever seeing it

**Who and where.** Pi in a VM, told to "open a pull request on my repo".

**What the owner wants.** Pi can call GitHub as the owner. The token never enters the VM and works only against the hosts the owner bound it to.

**Flow.**
1. The owner set up `GITHUB_TOKEN` once in Setup, with `api.github.com` and `github.com` as its allowed hosts.
2. Pi requests `secret:GITHUB_TOKEN`, reason "push the fix branch". The card should show the secret's name and the hosts it will be sent to.
3. The owner approves for 1 hour. Speaker hands the value and its allowed hosts to the sandbox host, which adds the token to Pi's requests to those hosts.
4. Pi calls the GitHub API or runs `git push`. The request leaves the VM with the real token added outside it.
5. At the end of the grant, the sandbox host stops adding the token.

**For a weak agent.** Pi needs one literal instruction for what to type to use the secret (for example which variable or header to reference). It must never be asked to paste a token anywhere.

### 8. Work on a folder from inside the VM

**Who and where.** Pi in a VM, told to "fix the tests in `myproject`", a folder on the sandbox host (or on another machine).

**What the owner wants.** The agent edits that folder only, read-write only if approved, and the folder disappears from the VM when the grant ends.

**Flow.**
1. Pi requests `folder:myproject:rw` with the reason.
2. Speaker picks the delivery. If the sandbox host holds the folder and the share allows VM mounts, the card says "VM mount" and Pi gets a normal directory. Otherwise, if the share allows SSH, the card says "over SSH" and Pi mounts the folder with `sshfs` through speaker, which needs FUSE in the VM. If neither applies, the request is answered `denied`.
3. The owner approves. Pi edits files and runs the tests.
4. At the end, or on Revoke, the mount is removed (over SSH, the `sshfs` mount stops working and the message gives the unmount command).

**Owner note.** A read-write share that is a code repository lets the agent change files that run later on the owner's machine (hooks, scripts). The owner should treat `:rw` on a repository with the same care as `ssh:`.

**For a weak agent.** Where the folder appears must be stated plainly. If it came over SSH, the agent must be told that `git status` and `grep -r` are slow and that copying the working set locally is the better move.

---

## Owner and operations

### 9. Where speaker runs: a home server or one MacBook

**Who and where.** The owner, deciding where the single speaker container lives.

**What the owner wants.** Either a home server behind a reverse proxy (agents and phone reach it by one HTTPS address), or everything on a single MacBook: speaker, Claude Code, bottle-school, and the owner's own browser.

**Flow, home server.**
1. The proxy forwards HTTP to speaker with `TRUSTED_PROXY` set, and allows holds of 120 seconds. Speaker reads the agent's address from the last `X-Forwarded-For` entry.
2. Agents use the public HTTPS address. The phone follows approval links to the same address. SSH goes straight to speaker's SSH port, not through the proxy.

**Flow, one MacBook.**
1. Speaker runs in a local container. Direct agents use `http://localhost`. The owner signs in to `/admin` in a browser on the same machine over plain HTTP, and the sign-in page notes when the password would cross the network unencrypted. Cards can be approved at the laptop or on the phone if the phone can reach the laptop.
2. Sandbox VMs reach speaker through the laptop's own network address, not `localhost`.

**For a weak agent.** It must be given one working address and see only commands that work from where it runs.

---

## Open points

None: the design answers every point these scenarios raised (see "Rules in detail" in DESIGN.md).
