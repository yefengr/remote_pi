# syntax=docker/dockerfile:1
# Build both the extension dependency graph and TypeScript output inside Linux.
FROM node:24-bookworm-slim AS extension-build

WORKDIR /src/pi-extension
COPY pi-extension/package.json pi-extension/pnpm-lock.yaml pi-extension/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY pi-extension/src ./src
COPY pi-extension/tsconfig.json ./
RUN pnpm exec tsc

# Pi itself is pinned independently from the host's package installation.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/pi \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/home/pi/.pi/agent/sessions \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @earendil-works/pi-coding-agent@0.84.4 \
    && useradd --create-home --uid 10001 --shell /bin/bash pi \
    && mkdir -p /opt/remote-pi /workspace /home/pi/.pi/agent/sessions \
    && chown -R pi:pi /opt/remote-pi /workspace /home/pi \
    && mkdir -p /home/pi/.pi/remote \
    && chown -R pi:pi /home/pi/.pi

COPY --from=extension-build /src/pi-extension/package.json /opt/remote-pi/package.json
COPY --from=extension-build /src/pi-extension/dist /opt/remote-pi/dist
COPY --from=extension-build /src/pi-extension/node_modules /opt/remote-pi/node_modules
COPY docker/e2e/host/interactive-controller.mjs /usr/local/bin/interactive-controller.mjs
COPY docker/e2e/host/interactive-entrypoint.sh /usr/local/bin/interactive-entrypoint.sh
COPY docker/e2e/host/supervisor-entrypoint.sh /usr/local/bin/supervisor-entrypoint.sh

RUN chmod 0555 /usr/local/bin/interactive-entrypoint.sh /usr/local/bin/supervisor-entrypoint.sh \
    && chown pi:pi /usr/local/bin/interactive-controller.mjs

USER pi
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/interactive-entrypoint.sh"]
