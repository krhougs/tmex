#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(cd "${APP_DIR}/../.." && pwd)"
FE_DIST_DIR="${ROOT_DIR}/apps/fe/dist"
GATEWAY_DRIZZLE_DIR="${ROOT_DIR}/apps/gateway/drizzle"
TARGET_FE_DIR="${APP_DIR}/resources/fe-dist"
TARGET_DRIZZLE_DIR="${APP_DIR}/resources/gateway-drizzle"

if [[ ! -f "${FE_DIST_DIR}/index.html" ]]; then
  echo "[tmex build] frontend dist not found, building @tmex/fe ..."
  (cd "${ROOT_DIR}" && bun run --filter @tmex/fe build)
fi

rm -rf "${TARGET_FE_DIR}" "${TARGET_DRIZZLE_DIR}"
mkdir -p "${TARGET_FE_DIR}" "${TARGET_DRIZZLE_DIR}"
cp -R "${FE_DIST_DIR}/." "${TARGET_FE_DIR}/"
cp -R "${GATEWAY_DRIZZLE_DIR}/." "${TARGET_DRIZZLE_DIR}/"

echo "[tmex build] resources bundled"
