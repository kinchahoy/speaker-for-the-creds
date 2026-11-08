---
project: speaker-for-the-creds
topic: Agents & security
state: blocked
updated: 2026-11-08T03:15
repo: ~/code/workshop/speaker-for-the-creds
tags: [workshop, checkpoint]
---

# Checkpoints

Newest first. Frontmatter `state`/`updated` mirror the newest entry.

## 2026-11-08 03:15 · blocked

**Next**
- Deploy on the NAS (needs SSH access, tomorrow): 9-step checklist in WORKSHOP-PLAN.md.
- One real approve-and-ssh test with a time-boxed certificate; check the `ssh_certificate_issued` audit line.

**Open**
- Should SSH certs be revocable early (key revocation list), or is a short TTL enough?
- SSH is off unless SSH_CA_KEY is set: keep optional or require it?
- Enrollment rate limit: shared budget (current) or per address?
- List issued certificates on the admin page?
- Commit or gitignore `.vscode/`?
