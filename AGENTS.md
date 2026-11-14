# AGENTS.md

<sub>AI-written</sub>

Project rules for speaker-for-the-creds, on top of the owner's global rules. "The owner" is the human who runs this project.

- **Dependencies:** latest by default with a lockfile available, updated only on request.
- **Size:** fewest lines of custom code is a high priority. Prefer a well-kept library over custom code when it makes the total smaller. Watch for dead code, and remove it only with the owner's approval.
- **Features:** the owner is open to simplifying a feature to cut code, but never remove or narrow one without asking; some expensive features are worth keeping.
- **Security:** do not weaken a boundary without specifically checking with the owner: grants, token binding, secret handling, audit logging, same-origin checks, share containment.
- **One full UI (a preference, not a hard rule):** the web `/admin` is the complete frontend today. A second one (terminal UI, native panel) costs a lot of custom code, so raise it with the owner before starting one.
- **Herdr:** "Herdr" means the Herdr app (`herdr-app` plus `hc`), not the older `herdr` terminal app. Its mod documentation is in `~/.config/herdr-app/AGENTS.md`.
- **Deployment:** it must stay easy for others to deploy, on one laptop or several boxes, with minimal setup on remote machines.
- **Words:** the sandbox package is called bottle everywhere. In docs, write "the owner" for the human and name the agent meant; avoid "you" and "I".
