FROM node:26.13.0-slim AS dependencies
WORKDIR /app
RUN npm install -g pnpm@12.16.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:26.13.0-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# ssh-keygen signs SSH user certificates when SSH_CA_KEY is set.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.ts ui.ts lifecycle.ts ssh.ts providers.example.json ./
COPY skill/SKILL.md ./skill/SKILL.md
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
