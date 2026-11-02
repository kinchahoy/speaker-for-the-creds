FROM node:26.11.1-slim AS dependencies
WORKDIR /app
# Bootstrap the pinned pnpm distribution; application dependencies are managed by pnpm.
RUN node --input-type=module -e "import {writeFile} from 'node:fs/promises'; const r = await fetch('https://registry.npmjs.org/pnpm/-/pnpm-10.18.3.tgz'); if (!r.ok) throw new Error('pnpm download failed'); await writeFile('/tmp/pnpm.tgz', new Uint8Array(await r.arrayBuffer()))" \
    && mkdir /pnpm && tar -xzf /tmp/pnpm.tgz -C /pnpm --strip-components=1
COPY package.json pnpm-lock.yaml ./
RUN node /pnpm/bin/pnpm.cjs install --prod --frozen-lockfile --ignore-scripts

FROM node:26.11.1-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.ts ui.ts providers.example.json ./
COPY skill/SKILL.md ./skill/SKILL.md
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
