# Admin UI screenshots: before and after restoring the old look

- Old UI: `old/`, commit `893bc78` (tag `pre-gondolin-removal`)
- New UI: `new/`, the old layout on Open Props tokens and Lucide icons, captured from the branch that follows `ad77df5`
- Captured: 2026-11-13 (new/ re-captured with Playwright, full page; the server runs with PORT, PROXY_PORT and PUBLIC_URL set so the secret request seeds, and `services.example.json` with demo `read` set to `ask`)

Both sets were captured from a fresh data dir per version, seeded with the same owner password, service `demo`, secret `GITHUB_TOKEN`, group `demo`, two pending requests and one approved request (`demo.read`), at 1280×900 and 390×844 with light colour scheme (Inbox also dark).

- `signin-desktop.png` / `signin-phone.png`: sign-in page before signing in
- `inbox-desktop.png` / `inbox-phone.png`: Inbox with two pending cards
- `inbox-desktop-dark.png`: Inbox in dark colour scheme (desktop)
- `active-desktop.png` / `active-phone.png`: Active with one grant
- `setup-desktop.png` / `setup-phone.png`: Setup (services section)
- `log-desktop.png` / `log-phone.png`: Log
