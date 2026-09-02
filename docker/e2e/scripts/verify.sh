#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
COMPOSE="$ROOT/docker/e2e/compose.yml"
PROJECT=remote-pi-e2e

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI is required.' >&2
  exit 127
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker Compose v2 is required.' >&2
  exit 127
fi

docker compose -p "$PROJECT" -f "$COMPOSE" up -d --build
exec node "$ROOT/docker/e2e/runner.mjs"
