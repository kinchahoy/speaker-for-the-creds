# bottle's service in a container (used by compose.yaml next to this file). Most installs do not need it: bottle
# normally runs straight on the host (`mise run init bottle`). Nothing here needs editing; bottle's settings and
# templates are in config.json in the data volume (start from config.example.json).
# Built from the repository root (the pnpm workspace): docker build -f bottle/Dockerfile .
# The service only: microsandbox runs each agent's VM in here through /dev/kvm. The guest image is built with Docker on
# the host and loaded into the data volume (see compose.yaml); this container never talks to Docker.
FROM node:26-slim AS dependencies
# The newest releases by default; LOCKED=1 installs exactly the tested set in pnpm-lock.yaml.
ARG LOCKED=0
WORKDIR /app
RUN npm install -g pnpm@latest
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY speaker/package.json speaker/
COPY bottle/package.json bottle/
RUN if [ "$LOCKED" = 1 ]; then pnpm install --filter bottle --prod --frozen-lockfile --ignore-scripts; \
  else pnpm update --filter bottle --prod --ignore-scripts --config.lockfile=false; fi

FROM node:26-slim
WORKDIR /app/bottle
# BOTTLE_HOME holds config.json, config/, state/, output/ and microsandbox/ (images, VM disks); it must stay private (700).
ENV NODE_ENV=production BOTTLE_HOME=/data PATH=/app/bottle/bin:$PATH
# ssh-keygen makes each agent's throwaway folder key; msb's HTTP client needs the system CA store; setsid (util-linux)
# is already in the base image.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/* \
  && mkdir -m 700 /data && chown node:node /data \
  && mkdir bin && ln -s /app/bottle/src/cli.ts bin/bottle && ln -s /app/bottle/node_modules/.bin/msb bin/msb
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/bottle/node_modules ./node_modules
# bottle imports these two pure speaker modules (items, lifecycle); api.ts is a type-only import.
COPY speaker/items.ts speaker/lifecycle.ts /app/speaker/
COPY bottle/package.json bottle/start.sh bottle/catalog.json bottle/config.example.json ./
COPY bottle/src ./src
# The two guest extensions bottle copies into every VM (and reply.ts, which src/pi.ts imports).
COPY bottle/guest/extensions ./guest/extensions
USER node
CMD ["./start.sh"]
