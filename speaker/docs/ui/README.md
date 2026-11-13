# Admin UI screenshots: before and after restoring the old look

- Old UI: `old/`, commit `893bc78` (tag `pre-gondolin-removal`)
- New UI: `new/`, the old hand-written stylesheet and layout restored on the htmx markup (Pico removed), captured from the branch that follows `8ecd6f2`
- Captured: 2026-11-13 (new/ re-captured with Playwright; PROXY_PORT set so the secret request seeds)

Both sets were captured from a fresh data dir per version, seeded with the same owner password, service `demo`, secret `GITHUB_TOKEN`, group `demo`, two pending requests and one approved request (`demo.read`), at 1280×900 and 390×844 with light colour scheme (Inbox also dark).

- `signin-desktop.png` / `signin-phone.png`: sign-in page before signing in
- `inbox-desktop.png` / `inbox-phone.png`: Inbox with two pending cards
- `inbox-desktop-dark.png`: Inbox in dark colour scheme (desktop)
- `active-desktop.png` / `active-phone.png`: Active with one grant
- `setup-desktop.png` / `setup-phone.png`: Setup (services section)
- `log-desktop.png` / `log-phone.png`: Log
