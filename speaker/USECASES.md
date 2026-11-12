<!-- author: ai -->

# Speaker: use cases

<sub>AI-written</sub>

Speaker lets AI agents use the owner's homelab credentials, hosts and folders without holding keys. The owner approves from a phone. This document lists the scenarios speaker has to serve well, walks each one through the design, and ends with the points that are still open.

There are two kinds of agent, and they need different things.

- **Direct agents** (Claude Code on a workstation or laptop) already have their own internet, files and tools. They come to speaker only for what needs the owner's credentials or hosts: homelab services, SSH to homelab hosts, and folders on other machines. They likely never need `site:` or `ext:`.  `secret:`, `mcp:` may be used, but less often.

- **Sandboxed agents** (Pi inside a bottle-school VM) start with nothing. Besides the three things above, they need websites, injected secrets, MCP servers, extensions and folder mounts.

Eight scenarios cover real use: four for direct agents, four for sandboxed agents. A ninth, about where speaker runs, matters to the owner only. Several things were left out on purpose: a direct agent asking for websites (never needed), a sandboxed agent using a homelab service or SSH (the same as scenarios 1 to 3, with the differences noted under "Sandboxed agents"), and unattended or scheduled tasks (every task starts with an owner tap, by design).

"Weak agent" below means a small model that follows steps literally, copies commands exactly, and does not improvise around errors.

---

## Common to all agents

### 1. Use a homelab service (read, then full)

**Who and where.** Claude Code on the owner's laptop, or Qwen inside bottle-school container is asked to "update the PrimeX homelab notes in Obsidian". The speaker-for-the-creds service runs on a different server on the network.

**What the owner wants.** To see one card on the phone saying what the agent wants and why, tap once, and have the agent finish.

Variation: if the owner marked a service's reads open (for example "are the lights on"), an enrolled agent reads it with no card, but only if the owner has told it the service name. Open services won't be listed along with other services in catalog like interactions.

### 2. Run commands via ssh on a homelab host

**Who and where.** Claude Code on a workstation, told "check disk space on `nas` (a different server)".

**What the owner wants.** The agent runs commands on `nas` as a limited account for a short time. The owner sees the account name and every command that runs is logged. 

1. The agent (already enrolled) generates a throwaway SSH key and posts `{"want":["ssh:nas"],"sshKey":"ssh-ed25519 …","reason":"…","duration":"30m"}` to `/_speaker/requests`, with `Speaker-Wait`. An agent sends its SSH key once, so later requests omit it. Speaker holds the reply.
2. Speaker checks that `nas` exists and can be delivered to this agent. The name comes only from the owner's prompt; a request for an unknown target is answered `denied` at once and appears in the Log, with no card.
3. The card shows the account the commands will run as (for example `agent`), a warning if speaker found passwordless sudo on that account when the target was added, and the colour used for `ssh:` items. The owner approves for 30 minutes.
4. Speaker starts its SSH port (it listens only while an SSH or folder grant is active), writes one key line for the agent, and returns `granted`. The agent calls `GET /_speaker/me` and copies the ready-made command, including the port, the pinned host key and `-o IdentitiesOnly=yes -o BatchMode=yes`.
5. The agent runs `ssh … s@speaker nas 'df -h'`. Speaker's relay runs the command on `nas` as the agent account and returns output and exit code. The Log records the exact command.
6. At 30 minutes, or on Revoke, the session ends and the key line is removed.

### 3. Fetch or deliver files on another machine

**Who and where.** Claude Code on a MacBook or workstation or Qwen in bottle-school, told to "copy the latest scan from the `scans` share" or "put the report in `reports`".

**What the owner wants.** The agent touches one folder only, read-only unless a write was approved. The owner never has to think about where the share lives.

**Flow.**
1. The agent requests `folder:scans` (or `folder:reports:rw`) with a reason, and with its throwaway key if it has not sent one yet. A direct agent gets folders over SSH, if the share allows it; otherwise the item is answered `denied`. The card says "over SSH", the share, and read-only or read-write.
2. The owner approves. `/me` shows the `scp` and `sftp` lines for this grant first, then `sshfs`. Every path in them starts with the share name.
3. The client uses sftp or sshfs to do the work required. 

## Sandboxed agents primarily

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

### 6. The task needs something new mid-way (websites, tools)

**Who and where.** Pi in a running VM; the task turns out to need `example.org` or a PDF-reading extension.

**What the owner wants.** The agent asks for the smallest thing that works, with a reason. The owner sees exactly which sites or tools, and can say yes to some and no to others.

**Flow.**
1. Pi tries `curl https://example.org` and is blocked by the sandbox's network filter. The block message should say what to do.
2. Pi posts `{"want":["site:example.org"],"reason":"Read the paper the task is about","duration":"1h"}` to `/_speaker/requests`, with `Speaker-Wait`. If it needs three or more items from one group, it asks for the group instead.
3. The card lists items outside any group separately and highlighted, and each group as one row. The owner approves, or unticks a site.
4. Speaker tells the sandbox host; the host opens the route; Pi retries and succeeds. A denied site gets `denied`, and Pi is told to stop.
5. For an extension or MCP server, the same steps apply with `ext:<id>` or `mcp:<id>`. How Pi is then told to use it is an open point.

### 7. Use a secret without ever seeing it

**Who and where.** Pi in a VM, told to "open a pull request on my repo".

**What the owner wants.** Pi can call GitHub as the owner. The token never enters the VM or the sandbox host and works only against the hosts the owner bound it to by speaker-for-the-creds proxying the request.

### 8. Work on a folder from inside the VM

**Who and where.** Pi in a VM, told to "fix the tests in `myproject`", a folder on the sandbox host (or on another machine).

**What the owner wants.** The agent edits that folder only, read-write only if approved, and the folder disappears from the VM when the grant ends.

**Flow.**
1. Pi requests `folder:myproject:rw` with the reason.
2. Speaker picks the delivery. If the sandbox host holds the folder and the share allows VM mounts, the card says "VM mount" and Pi gets a normal directory. Otherwise, if the share allows SSH, the card says "over SSH" and Pi mounts the folder with `sshfs` through speaker, which needs FUSE in the VM. If neither applies, the request is answered `denied`.
3. The owner approves. Pi edits files and runs the tests.
4. At the end, or on Revoke, the mount is removed (over SSH, the `sshfs` mount stops working and the message gives the unmount command).

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
