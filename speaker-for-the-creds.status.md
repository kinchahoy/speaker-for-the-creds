---
project: speaker-for-the-creds
topic: Agents & security
state: paused
updated: 2026-11-14T14:00
repo: ~/code/workshop/speaker-for-the-creds
tags: [workshop, status]
---

# speaker-for-the-creds status

Newest first. Frontmatter `state`/`updated` mirror the newest entry.

## 2026-11-14 14:00 · paused

**Next**
- Herdr integration is planned in `plan.md` (approvals as a Herdr app mod over a new owner JSON API; bottle tasks as attach terminals under herdr-core). Nothing built. First step: the four spikes in its "Order of work".
- NAS deploy and the SSH certificate test below are still open.

**Open**
- The seven questions at the end of `plan.md` (blocked vs working for pending requests, who creates the tab, A0 stopgap, TUI effort, where the mod lives, bottle vs bottle-school).

## 2026-11-08 03:15 · blocked

**Next**
- Deploy on the NAS (needs SSH access, tomorrow): 9-step checklist in WORKSHOP-PLAN.md.
- One real approve-and-ssh test with a time-boxed certificate; check the `ssh_certificate_issued` audit line.

**Open**
- Should SSH certs be revocable early (key revocation list), or is a short TTL enough?
- SSH is off unless SSH_PORT is set: keep optional or require it?
- Enrollment rate limit: shared budget (current) or per address?
- List issued certificates on the admin page?
- Commit or gitignore `.vscode/`?
