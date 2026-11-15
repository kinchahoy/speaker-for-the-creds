---
project: speaker-for-the-creds
topic: Agents & security
state: paused
updated: 2026-11-14T17:30
repo: ~/code/workshop/speaker-for-the-creds
tags: [workshop, status]
---

# speaker-for-the-creds status

Newest first. Frontmatter `state`/`updated` mirror the newest entry.

## 2026-11-14 17:30 · paused

**Next**
- plan.md steps 0 to 4 are built and committed on `main` (tags `pre-cuts-2026-11-14`, `pre-workspace-2026-11-14`, `pre-typed-client-2026-11-14`). Non-test source is 8,752 → 8,003 lines.
- Try Herdr chunk 1 for real: run one bottle task on a host with `hc` and check it shows as a tab and closes on archive; link `herdr/mods/speaker` into the Herdr app with a `config.json` and check a new card toasts.
- One real VM task after the dependency float (microsandbox 0.7.14 → 0.7.15, undici 6 → 8); no test boots a guest.
- Step 5 (approve inside Herdr) waits until the browser hop annoys.

**Open**
- Speaker's share `delivery` setting (`vm` / `ssh` / `both`) is still in Setup. A `vm` share is now unreachable; dropping the setting would make `vm`-only shares deliverable over SSH (share containment), so it waits for the owner.
- `bottle init --skip-register` writes placeholder proxy and SSH ports from `config.example.json` until `register` replaces them. Fail fast instead?
- Herdr names the bottle space after its first terminal's folder; there is no label for a space name, so it needs one rename by hand.
- `speaker/test/jump.test.ts` hangs on this machine: `Host *` in `~/.ssh/config` sets `ControlMaster auto` / `ControlPersist 30m`, and the mux master holds the test open. Fix in the generated ssh lines (`-o ControlMaster=no`) or in the ssh config?
- Settled: SSH_PORT and PROXY_PORT are now required.

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
