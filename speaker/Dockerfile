# speaker's container image: speaker itself, its SSH jump server, and a sandboxed Chromium for browser sites.
# Use it to run speaker on a server or always-on box; on a laptop, `mise run init speaker` runs it without Docker.
# Normally built and started by compose.yaml next to this file (`mise run speaker:up`); nothing here needs editing.
# Settings go in speaker/.env (see .env.example); services, groups and secrets are set up in /admin.
# Built from the repository root (the pnpm workspace): docker build -f speaker/Dockerfile .
FROM node:26-slim AS dependencies
# The newest releases by default; LOCKED=1 installs exactly the tested set in pnpm-lock.yaml.
ARG LOCKED=0
WORKDIR /app
RUN npm install -g pnpm@latest
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY speaker/package.json speaker/
COPY bottle/package.json bottle/
RUN if [ "$LOCKED" = 1 ]; then pnpm install --filter speaker --prod --frozen-lockfile --ignore-scripts; \
  else pnpm update --filter speaker --prod --ignore-scripts --config.lockfile=false; fi

FROM node:26-slim
WORKDIR /app/speaker
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data \
  BROWSER_BROKER_PORT=3100 AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium-sandboxed
# ssh-keygen (from openssh-client) for speaker's initial SSH key; Chromium and a font for browser sites, run by the user
# `browser` (setpriv, from util-linux, switches users at start).
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data \
  && useradd --system --no-create-home --shell /usr/sbin/nologin browser
# agent-browser always passes --no-sandbox in a container; dropping it keeps Chromium's own sandbox (the user namespaces
# it needs are what chrome-seccomp.json allows).
COPY --chmod=755 <<'EOF' /usr/local/bin/chromium-sandboxed
#!/bin/sh
for arg do
  shift
  [ "$arg" = --no-sandbox ] || set -- "$@" "$arg"
done
exec /usr/lib/chromium/chromium "$@"
EOF
# The broker as `browser`, speaker as `node`. The broker token is made here when .env sets none.
COPY --chmod=755 <<'EOF' /usr/local/bin/speaker-start
#!/bin/sh
set -e
export BROWSER_BROKER_TOKEN="${BROWSER_BROKER_TOKEN:-$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')}"
export BROWSER_BROKER_URL="http://127.0.0.1:$BROWSER_BROKER_PORT"
HOME=/tmp setpriv --reuid=browser --regid=browser --init-groups node browser-broker.ts &
HOME=/home/node exec setpriv --reuid=node --regid=node --init-groups node server.ts
EOF
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/speaker/node_modules ./node_modules
COPY speaker/package.json speaker/*.ts speaker/config.example.json ./
COPY speaker/skill ./skill
EXPOSE 3000
# Starts as root holding only SETUID and SETGID (compose.yaml) and drops at once to the two users.
CMD ["speaker-start"]
