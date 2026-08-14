#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(cd "${APP_DIR}/../.." && pwd)"
FE_DIST_DIR="${ROOT_DIR}/apps/fe/dist"
TARGET_FE_DIR="${APP_DIR}/resources/fe-dist"

if [[ ! -f "${FE_DIST_DIR}/index.html" ]]; then
  echo "[tmex build] frontend dist not found, building @tmex/fe ..."
  (cd "${ROOT_DIR}" && bun run --filter @tmex/fe build)
fi

rm -rf "${TARGET_FE_DIR}" "${APP_DIR}/resources/gateway-drizzle"
mkdir -p "${TARGET_FE_DIR}"
cp -R "${FE_DIST_DIR}/." "${TARGET_FE_DIR}/"

# 剔除不应随 npm 包分发的开发期产物：
# - source map 只用于本地调试，体积约占包的一半
find "${TARGET_FE_DIR}" -name '*.map' -delete

echo "[tmex build] resources bundled"
