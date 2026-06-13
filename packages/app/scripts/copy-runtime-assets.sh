#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(cd "${APP_DIR}/../.." && pwd)"

# headless ghostty 通过 `new URL('./assets/ghostty-vt.wasm', import.meta.url)` 加载 wasm，
# bundled `dist/runtime/server.js` 的相对解析指向 `dist/runtime/assets/ghostty-vt.wasm`，
# 但 `bun build` 不会把该 wasm 当作 asset 输出。这里在构建后补拷，使其随 runtime 目录
# 一起被 deployRuntimeFiles 收进 `<installDir>/runtime/assets/`，生产运行时即可命中。
WASM_SRC="${ROOT_DIR}/packages/ghostty-terminal/src/assets/ghostty-vt.wasm"
RUNTIME_ASSETS_DIR="${APP_DIR}/dist/runtime/assets"

if [[ ! -f "${WASM_SRC}" ]]; then
  echo "[tmex build] ghostty-vt.wasm not found at ${WASM_SRC}" >&2
  exit 1
fi

mkdir -p "${RUNTIME_ASSETS_DIR}"
cp "${WASM_SRC}" "${RUNTIME_ASSETS_DIR}/ghostty-vt.wasm"

echo "[tmex build] runtime ghostty-vt.wasm copied"
