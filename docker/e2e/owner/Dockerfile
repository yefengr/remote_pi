# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies

WORKDIR /src/pi-extension
COPY pi-extension/package.json pi-extension/pnpm-lock.yaml pi-extension/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    OWNER_PORT=8788 \
    OWNER_STATE_DIR=/var/lib/remote-pi-owner

RUN useradd --create-home --uid 10002 --shell /bin/bash owner \
    && mkdir -p /opt/remote-pi-owner /var/lib/remote-pi-owner \
    && chown -R owner:owner /opt/remote-pi-owner /var/lib/remote-pi-owner

COPY --from=dependencies /src/pi-extension/node_modules /opt/remote-pi-owner/node_modules
COPY docker/e2e/owner/server.mjs /opt/remote-pi-owner/server.mjs
RUN chown -R owner:owner /opt/remote-pi-owner

USER owner
WORKDIR /opt/remote-pi-owner
EXPOSE 8788
ENTRYPOINT ["node", "/opt/remote-pi-owner/server.mjs"]
