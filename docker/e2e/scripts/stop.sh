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

# Deliberately preserve named volumes and all pairing/session state.
exec docker compose -p "$PROJECT" -f "$COMPOSE" stop "$@"
