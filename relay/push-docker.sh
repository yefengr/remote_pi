#!/usr/bin/env bash
# Build a multi-platform image and push it to Docker Hub.
# Version is read from Cargo.toml — bump `version = "..."` there before running.
#
# Usage:
#   ./push-docker.sh
#
# Always tags `:v<cargo-version>` and `:latest`.
#
# Requirements:
#   docker buildx (bundled with modern Docker).
#   Log in first with: docker login

set -euo pipefail

IMAGE="${IMAGE:-${REGISTRY_NAMESPACE:-remote-pi-local}/remote-pi-relay}"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER="multiarch"

# Always resolve paths relative to this script so it can be called from anywhere
cd "$(dirname "$0")"

# Extract the [package] version from Cargo.toml.
VERSION=$(awk '
  /^\[package\]/ { in_pkg = 1; next }
  /^\[/          { in_pkg = 0 }
  in_pkg && /^version[[:space:]]*=/ {
    gsub(/[" ]/, "")
    sub(/^version=/, "")
    print
    exit
  }
' Cargo.toml)

if [[ -z "$VERSION" ]]; then
  echo "✗ Could not extract version from Cargo.toml" >&2
  exit 1
fi

TAG="v$VERSION"

# The default `docker` driver cannot build multi-platform images in one shot.
# Ensure a `docker-container` builder exists and is selected. Idempotent.
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "→ Creating buildx builder '$BUILDER' (docker-container driver)"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi
docker buildx use "$BUILDER"

echo "→ Building $IMAGE:$TAG + :latest ($PLATFORMS)"

docker buildx build \
  --platform "$PLATFORMS" \
  --tag "$IMAGE:$TAG" \
  --tag "$IMAGE:latest" \
  --push \
  .

echo "✓ Pushed $IMAGE:$TAG and $IMAGE:latest"
