<sub>AI-written</sub>

# Admin UI screenshots, 2026-11-15

Captured 2026-11-15 from speaker at git commit `e3bc0d078ebb8bce5f87c13017828ad2f6a5588b` (branch main, read from `.git/refs/heads/main`). Full-page PNGs, light colour scheme unless the name says dark.

- `signin-desktop.png`: sign-in page before signing in (1280×900)
- `inbox-desktop.png`: Inbox with two pending cards, claude-notes (demo.read) and codex-deploy (secret:GITHUB_TOKEN) (1280×900)
- `inbox-desktop-dark.png`: the same Inbox in dark colour scheme (1280×900)
- `inbox-phone.png`: the same Inbox at phone width (390×844)
- `active-desktop.png`: Active with one grant (pi-research, demo.read) and two enrolled agents without grants (1280×900)
- `setup-services-desktop.png`: Setup, Services section with the service list and the Secrets, Groups and SSH targets sections below (1280×900)
- `setup-service-edit-desktop.png`: Setup with the demo service open for editing; the Credential field is blank and the list shows "Credential: configured" (1280×900)
- `setup-secrets-groups-desktop.png`: the Secrets and Groups panels, cropped from `#setup-secrets` to `#groups` (1280×900 wide)
- `log-desktop.png`: Log with 15 entries, newest first (1280×900)
- `setup-phone.png`: Setup, Services section at phone width (390×844)

Seed: a fresh data directory, owner password set through the first-run form, service `demo` (from `services.example.json`, bearer credential set, read and write both `ask`), secret `GITHUB_TOKEN` (hosts api.github.com and github.com), group `demo` (demo.read and site:github.com), two pending requests (claude-notes for demo.read, codex-deploy for secret:GITHUB_TOKEN), and one approved request (pi-research, demo.read, approved for 2h). The other services in the Setup list come from the starter `services.example.json`. The credentials and the owner password were throwaway values; none is real.
