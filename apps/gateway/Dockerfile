FROM node:22-bookworm-slim AS build
WORKDIR /app
# Chromium comes from Debian in the runtime stage; don't download Puppeteer's copy during install.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Fixes applied to dependencies on install (whatsapp-web.js: WhatsApp Web renamed message ids in July 2026).
COPY patches patches
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN pnpm install --frozen-lockfile --filter @huzaifa/gateway...
COPY packages/contracts packages/contracts
COPY apps/gateway apps/gateway
RUN pnpm --filter @huzaifa/gateway build \
 && pnpm --filter @huzaifa/gateway deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WHATSAPP_AUTH_PATH=/data/wwebjs-auth
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-noto-color-emoji dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /app/apps/gateway/dist ./dist
USER node
EXPOSE 3001
# dumb-init forwards SIGTERM so the gateway can drain queues and close Chromium cleanly (session files flushed).
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
