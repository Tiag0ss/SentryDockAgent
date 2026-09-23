#!/usr/bin/env bash
# Local Docker build + compose up. No secrets. Override via env.
# Builds once via compose (or docker build if no compose file); avoids double-build.
set -euo pipefail

IMAGE="${IMAGE:-app:local}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yml}"
BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"

usage() {
  cat <<'EOF'
Usage: deploy.sh

Environment:
  IMAGE          Image tag (default: app:local)
  COMPOSE_FILE   Compose file path (default: compose.yml)
  BUILD_CONTEXT  Docker build context when no compose (default: .)
  DOCKERFILE     Dockerfile when no compose (default: Dockerfile)
  SKIP_BUILD=1   Skip build
  SKIP_UP=1      Skip compose up

Example:
  IMAGE=myapp:dev COMPOSE_FILE=compose.yml ./deploy/scripts/deploy.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  if [[ -f "${COMPOSE_FILE}" ]]; then
    echo "==> Building via ${COMPOSE_FILE} (IMAGE=${IMAGE})"
    IMAGE="${IMAGE}" docker compose -f "${COMPOSE_FILE}" build
  else
    echo "==> Building ${IMAGE} (no compose file)"
    docker build -t "${IMAGE}" -f "${DOCKERFILE}" "${BUILD_CONTEXT}"
  fi
fi

if [[ "${SKIP_UP:-0}" != "1" ]]; then
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    echo "Compose file not found: ${COMPOSE_FILE}" >&2
    echo "Build finished. Create a compose file or set SKIP_UP=1." >&2
    exit 1
  fi
  echo "==> Starting ${COMPOSE_FILE}"
  IMAGE="${IMAGE}" docker compose -f "${COMPOSE_FILE}" up -d --no-build
fi

echo "==> Done"
