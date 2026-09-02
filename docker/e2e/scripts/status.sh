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

docker compose -p "$PROJECT" -f "$COMPOSE" ps
for port in 18787 18788 18789; do
  state=$(curl -fsS "http://127.0.0.1:$port/state" 2>/dev/null || printf '{}')
  printf '%s\n' "$state" | node -e '
let raw=""; process.stdin.on("data", c => raw += c).on("end", () => {
  try {
    const value = JSON.parse(raw);
    const endpoint = value.endpoint ? value.endpoint.endpoint_id : value.endpointId;
    console.log(JSON.stringify({
      ready: value.ready === true,
      owner: typeof value.owner === "string" ? value.owner : undefined,
      endpoint_id: typeof endpoint === "string" ? endpoint.slice(0, 8) : undefined,
      runtime_id: typeof value.runtimeId === "string" ? value.runtimeId.slice(0, 8) : undefined,
      relay: typeof value.relay === "string" ? value.relay : undefined,
      frame_count: Array.isArray(value.frames) ? value.frames.length : undefined,
    }));
  } catch { console.log(JSON.stringify({ ready: false })); }
});'
done
