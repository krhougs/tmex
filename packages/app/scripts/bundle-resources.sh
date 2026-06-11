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

# 剔除不应随 npm 包分发的开发期产物：
# - source map 只用于本地调试，体积约占包的一半
# - drizzle meta/NNNN_snapshot.json 只被 drizzle-kit generate 使用，
#   运行时 migrate 只读 meta/_journal.json 与 *.sql
find "${TARGET_FE_DIR}" -name '*.map' -delete
find "${TARGET_DRIZZLE_DIR}/meta" -name '*_snapshot.json' -delete

echo "[tmex build] resources bundled"
