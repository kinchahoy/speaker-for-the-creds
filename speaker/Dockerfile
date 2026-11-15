# Built from the repository root (the pnpm workspace): docker build -f speaker/Dockerfile .
FROM node:26.13.0-slim AS dependencies
# The newest releases by default; LOCKED=1 installs exactly the tested set in pnpm-lock.yaml.
ARG LOCKED=0
WORKDIR /app
RUN npm install -g pnpm@12.16.1
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY speaker/package.json speaker/
COPY bottle/package.json bottle/
RUN if [ "$LOCKED" = 1 ]; then pnpm install --filter speaker --prod --frozen-lockfile --ignore-scripts; \
  else pnpm update --filter speaker --prod --ignore-scripts --config.lockfile=false; fi

FROM node:26.13.0-slim
WORKDIR /app/speaker
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# The jump server (sshd), ssh, ssh-agent and ssh-keygen for SSH and folders over SSH.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssh-client && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/speaker/node_modules ./node_modules
COPY speaker/package.json speaker/*.ts speaker/services.example.json ./
COPY speaker/skill ./skill
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
