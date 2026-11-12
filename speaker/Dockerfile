FROM node:26.13.0-slim AS dependencies
WORKDIR /app
RUN npm install -g pnpm@12.16.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:26.13.0-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# The jump server (sshd), ssh, ssh-agent and ssh-keygen for SSH and folders over SSH.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssh-client && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.ts ui.ts lifecycle.ts store.ts proxy.ts jump.ts relay.ts sftp.ts services.example.json ./
COPY skill ./skill
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
