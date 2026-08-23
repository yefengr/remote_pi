#!/usr/bin/env bash
# Deploy Remote Pi in two explicit stages:
#   test    build/transfer images and start only the test PWA on port 3002
#   promote reuse those images and start the production Relay/PWA
# Caddy is intentionally untouched by both stages.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG:-$ROOT_DIR/deploy.env}"
BUILDER="${BUILDER:-multiarch}"
ACTION="${1:-test}"

fail() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

info() {
  printf '→ %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-self-hosted.sh test
  ./scripts/deploy-self-hosted.sh promote

Stages:
  test     Build and transfer images, then start only the test PWA.
  promote  Reuse the transferred images and start production Relay/PWA.
EOF
}

case "$ACTION" in
  test|promote) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

[[ -f "$CONFIG_FILE" ]] || fail "Missing deployment config: $CONFIG_FILE (copy deploy.env.example to deploy.env)"
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${DEPLOY_SSH:?DEPLOY_SSH is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${REMOTE_DIR:?REMOTE_DIR is required}"
: "${IMAGE_NAMESPACE:?IMAGE_NAMESPACE is required}"
: "${RELAY_VERSION:?RELAY_VERSION is required}"
: "${SITE_VERSION:?SITE_VERSION is required}"

PUBLISH_IMAGES="${PUBLISH_IMAGES:-0}"
KEEP_IMAGE_ARCHIVE="${KEEP_IMAGE_ARCHIVE:-0}"
TEST_PWA_URL="${TEST_PWA_URL:-}"
PWA_URL="${PWA_URL:-}"
RELAY_URL="${RELAY_URL:-}"
SSH_TARGET="${DEPLOY_USER}@${DEPLOY_SSH}"
RELAY_IMAGE="${IMAGE_NAMESPACE}/remote-pi-relay:${RELAY_VERSION}"
SITE_IMAGE="${IMAGE_NAMESPACE}/remote-pi-site:${SITE_VERSION}"

valid_token() {
  [[ "$1" =~ ^[A-Za-z0-9._:/-]+$ ]]
}

valid_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]
}

valid_token "$DEPLOY_SSH" || fail "DEPLOY_SSH contains unsupported characters"
valid_token "$DEPLOY_USER" || fail "DEPLOY_USER contains unsupported characters"
valid_path "$REMOTE_DIR" || fail "REMOTE_DIR must be an absolute path without shell metacharacters"
valid_token "$IMAGE_NAMESPACE" || fail "IMAGE_NAMESPACE contains unsupported characters"
valid_token "$RELAY_VERSION" || fail "RELAY_VERSION contains unsupported characters"
valid_token "$SITE_VERSION" || fail "SITE_VERSION contains unsupported characters"
[[ "$PUBLISH_IMAGES" == 0 || "$PUBLISH_IMAGES" == 1 ]] || fail "PUBLISH_IMAGES must be 0 or 1"
[[ "$KEEP_IMAGE_ARCHIVE" == 0 || "$KEEP_IMAGE_ARCHIVE" == 1 ]] || fail "KEEP_IMAGE_ARCHIVE must be 0 or 1"

for command in docker ssh scp gzip; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command not found: $command"
done
if [[ -n "$TEST_PWA_URL" || -n "$PWA_URL" || -n "$RELAY_URL" ]]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required for public URL checks"
fi

[[ -f "$ROOT_DIR/docker-compose.yml" ]] || fail "Missing $ROOT_DIR/docker-compose.yml"
[[ -f "$ROOT_DIR/relay/Dockerfile" ]] || fail "Missing Relay Dockerfile"
[[ -f "$ROOT_DIR/site/Dockerfile" ]] || fail "Missing site Dockerfile"

remote() {
  ssh -o ConnectTimeout=15 -o BatchMode=yes "$SSH_TARGET" "$1"
}

compose_remote() {
  local compose_args="$1"
  remote "cd '$REMOTE_DIR' && export RELAY_IMAGE='$RELAY_IMAGE' SITE_IMAGE='$SITE_IMAGE' && docker-compose $compose_args"
}

wait_for_health() {
  local container="$1"
  local service="$2"
  info "Waiting for $service health check"
  remote "for attempt in \$(seq 1 30); do
    state=\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' '$container' 2>/dev/null || true)
    if [ \"\$state\" = healthy ]; then exit 0; fi
    sleep 2
  done
  docker inspect '$container' 2>/dev/null || true
  cd '$REMOTE_DIR' && docker-compose logs --tail=80 '$service'
  exit 1"
}

check_url() {
  local label="$1"
  local url="$2"
  [[ -n "$url" ]] || return 0
  info "Checking $label"
  curl -fsS --connect-timeout 10 --max-time 30 "$url" >/dev/null
}

info "Checking SSH and remote Docker"
REMOTE_ARCH="$(remote 'uname -m')"
remote 'docker info --format "Server={{.ServerVersion}}" && docker-compose version >/dev/null'

case "$REMOTE_ARCH" in
  x86_64|amd64) PLATFORM="linux/amd64" ;;
  aarch64|arm64) PLATFORM="linux/arm64" ;;
  *) fail "Unsupported remote architecture: $REMOTE_ARCH" ;;
esac

info "Remote architecture: $REMOTE_ARCH ($PLATFORM)"
info "Using images: $RELAY_IMAGE and $SITE_IMAGE"

if [[ "$ACTION" == test ]]; then
  info "Test stage: production Relay/PWA will remain unchanged"
  existing_relay="$(remote "docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' remote-pi-relay 2>/dev/null || true")"
  [[ "$existing_relay" == healthy ]] || fail "Production Relay is not healthy; test stage will not replace it"

  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    info "Creating Buildx builder: $BUILDER"
    docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
  fi
  docker buildx use "$BUILDER" >/dev/null

  if [[ "$PUBLISH_IMAGES" == 1 ]]; then
    info "Publishing target-platform images to the configured registry namespace"
    docker buildx build --builder "$BUILDER" --platform "$PLATFORM" \
      --tag "$RELAY_IMAGE" --push "$ROOT_DIR/relay"
    docker buildx build --builder "$BUILDER" --platform "$PLATFORM" \
      --tag "$SITE_IMAGE" --push "$ROOT_DIR/site"
  fi

  info "Building Relay locally ($PLATFORM)"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORM" \
    --tag "$RELAY_IMAGE" --load "$ROOT_DIR/relay"

  info "Building PWA locally ($PLATFORM)"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORM" \
    --tag "$SITE_IMAGE" --load "$ROOT_DIR/site"
  docker image inspect "$RELAY_IMAGE" "$SITE_IMAGE" >/dev/null

  info "Preparing remote deployment directory"
  remote "mkdir -p '$REMOTE_DIR'"
  scp -q "$ROOT_DIR/docker-compose.yml" "$SSH_TARGET:$REMOTE_DIR/docker-compose.yml"

  info "Transferring local images to the server"
  if [[ "$KEEP_IMAGE_ARCHIVE" == 1 ]]; then
    ARCHIVE_DIR="$ROOT_DIR/.pi/tmp"
    mkdir -p "$ARCHIVE_DIR"
    ARCHIVE="$ARCHIVE_DIR/remote-pi-images-$(date +%Y%m%d%H%M%S).tar.gz"
    docker save "$RELAY_IMAGE" "$SITE_IMAGE" | gzip -1 > "$ARCHIVE"
    ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$SSH_TARGET" \
      'gzip -dc | docker load' < "$ARCHIVE"
    info "Kept image archive: $ARCHIVE"
  else
    docker save "$RELAY_IMAGE" "$SITE_IMAGE" | gzip -1 | \
      ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$SSH_TARGET" \
        'gzip -dc | docker load'
  fi

  info "Starting only the test PWA on 127.0.0.1:3002"
  compose_remote '--profile test config --quiet'
  compose_remote '--profile test up -d --pull never site-test'
  wait_for_health remote-pi-site-test site-test
  compose_remote '--profile test ps site-test'
  check_url "test PWA" "$TEST_PWA_URL"
  if [[ -n "$RELAY_URL" ]]; then
    check_url "Relay" "${RELAY_URL%/}/health"
  fi
  remote "relay_id=\$(docker image inspect --format '{{.Id}}' '$RELAY_IMAGE'); site_id=\$(docker image inspect --format '{{.Id}}' '$SITE_IMAGE'); printf '%s\\n' 'RELAY_IMAGE=$RELAY_IMAGE' 'SITE_IMAGE=$SITE_IMAGE' \"RELAY_IMAGE_ID=\$relay_id\" \"SITE_IMAGE_ID=\$site_id\" > '$REMOTE_DIR/.remote-pi-test-state'"
  printf '✓ Test deployment completed. Review the test PWA, then run: %s promote\n' "$0"
  exit 0
fi

info "Promotion stage: reusing images already transferred by the test stage"
remote "test -f '$REMOTE_DIR/.remote-pi-test-state'"
remote "grep -Fqx 'RELAY_IMAGE=$RELAY_IMAGE' '$REMOTE_DIR/.remote-pi-test-state'"
remote "grep -Fqx 'SITE_IMAGE=$SITE_IMAGE' '$REMOTE_DIR/.remote-pi-test-state'"
remote "test \"\$(docker image inspect --format '{{.Id}}' '$RELAY_IMAGE')\" = \"\$(sed -n 's/^RELAY_IMAGE_ID=//p' '$REMOTE_DIR/.remote-pi-test-state')\""
remote "test \"\$(docker image inspect --format '{{.Id}}' '$SITE_IMAGE')\" = \"\$(sed -n 's/^SITE_IMAGE_ID=//p' '$REMOTE_DIR/.remote-pi-test-state')\""
remote "docker image inspect '$RELAY_IMAGE' '$SITE_IMAGE' >/dev/null"
remote "test -f '$REMOTE_DIR/docker-compose.yml'"
compose_remote 'config --quiet'
compose_remote 'up -d --pull never relay site'
wait_for_health remote-pi-relay relay
wait_for_health remote-pi-site site
compose_remote 'ps relay site'
if [[ -n "$RELAY_URL" ]]; then
  check_url "production Relay" "${RELAY_URL%/}/health"
fi
check_url "production PWA" "$PWA_URL"
printf '✓ Production promotion completed\n'
