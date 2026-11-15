<!-- author: ai -->

# One real end-to-end pass

<sub>AI-written</sub>

A guide for a subagent that checks speaker, bottle and Herdr once against real endpoints on this machine. The owner is at `/admin` the whole time, approving or denying cards as they appear. The subagent drives everything else, changes no code, and reports what passed and what failed.
{.ai}

## Rules for the subagent

- Change no code and no tests. A failure is a finding: record the exact error, the log lines, and what you did, then move on to the next check.
- Never print, echo or log a secret. To check for a key, test for its prefix (`sk-or-`) and print only a count.
- A card waits for the owner. Poll for up to 10 minutes (`bottle ls`, or the task's events), then mark the check "no decision" and continue.
- Deny convention: when the owner should deny a card, its reason contains `E2E-DENY`. Every other card is approved, with the shortest duration unless the check says otherwise.
- Drive Pi through Herdr: `hc send pi-<id> "<message>"`, `hc wait pi-<id>`, `hc read pi-<id> --lines 80`.
- Evidence: speaker's `audit.jsonl` (in its data folder, `~/.local/share/speaker` by default), `~/.bottle/bottle.log`, and the task archive under `~/.bottle/output/`.
{.ai}

## Setup (owner and subagent, once)

1. The subagent runs `mise run install`, `mise run check` and `mise run test`. Stop if any of them fails.
2. The owner runs `! mise run init`. It needs a real terminal; it sets the owner password, builds the guest image (more than 10 minutes the first time), registers bottle with speaker, and runs a smoke task. Give it the model server's `host:port` when asked.
3. In `/admin` → Setup, the owner:
   - enters the OpenRouter API key on the **openrouter** service (the only place the key goes; Pi's hosted model uses the same service);
   - adds a target `local`: host `127.0.0.1`, the owner's own account, after adding Setup's `authorized_keys` line to that account (`sshd` runs on this machine);
   - adds a share `e2e` on target `local`, with path `~/e2e-share` written out in full. Create that folder first, with a file `hello.txt` in it.
4. The subagent copies the `openrouter` entry (`{ "id": "openrouter", "service": "openrouter", "models": [...] }`) from `bottle/config.example.json` into `hostedProviders` in `~/.bottle/config.json`, keeping one cheap model id the owner names, then restarts bottle.
{.ai}

## Checks

| # | The subagent does | The owner | Pass when |
| --- | --- | --- | --- |
| A | `bottle run --name e2e`, then `hc ls` | | A `pi-<id>` terminal appears in Herdr's bottle space; Pi answers "say hi" through the local model |
| B | Has Pi `GET $SPEAKER_URL/openrouter/models`, then `POST …/openrouter/chat/completions` with the cheap model | approves `openrouter.read`, then `openrouter.full` | Both return 200 with real data; `audit.jsonl` has `proxy` lines with status 200; inside the VM, `env` and Pi's config hold no `sk-or-` (count 0) |
| C | Has Pi request `site:example.com` with reason `E2E-DENY` | denies | Pi reports a denial; `curl https://example.com` in the VM gets 403 |
| D | Has Pi request `site:pypi.org` | approves | `curl -sI https://pypi.org` gives 200, and `https://example.org` still gives 403 |
| E | While B's read grant is live, has Pi repeat the models call | revokes it in Active | The next call is refused within a few seconds |
| F | Requests something approved with the shortest duration; calls again after it expires | approves | Refused after expiry |
| G | Has Pi request `folder:e2e` (read-only), `cat /input/e2e/hello.txt`, try to write there, and `ls /input/e2e/..` | approves | Read works; the write fails; nothing outside the share shows up. Then `folder:e2e:rw` (approve): a write lands in `~/e2e-share` on the host. A revoke unmounts it |
| H | `bottle run --model openrouter/<cheap id> --prompt "write hello to /output/hello.txt, then write DONE to /output/DONE"` | approves the first card (`openrouter.full`) | The task waits in `awaiting-grant`, Pi starts after approval, finishes, and the task archives. `_control/model-calls.jsonl` has lines with status 200; `grep -rc sk-or-` over the archive finds 0 |
| I | After H: `hc ls`, and list the archive | | H's tab is gone. The archive has `task.json`, `manifest.json`, `pi-session.jsonl`, `transcript.html`, `model-calls.jsonl`, `artifacts/hello.txt` |
| J | `bottle stop <A's id>` | | Archived; its tab is gone; the agent has left speaker's Active page |
| K | The owner links `herdr/mods/speaker` (speaker README) and signs in from its bar; the subagent has Pi request `site:pypi.org` again | approves from the Herdr inbox, not the browser | A toast appears; the bar counts 1 waiting, then 0; the grant shows in the inbox's Active list and in `/admin` |
| L | Has Pi request `site:example.net` | denies from the Herdr inbox, then revokes K's grant there | Pi reports the denial; the revoked site gets 403; `audit.jsonl` shows both decisions |
{.ai}

## Report

One table: check, pass / fail / no decision, and the evidence (an audit line, a file, a command's output). After it, each failure with its exact error and the steps that led there. Nothing else, and no fixes.
{.ai}
