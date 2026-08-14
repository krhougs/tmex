#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

if ! command -v cargo >/dev/null 2>&1 && [[ -f "${HOME}/.zshrc" ]]; then
  # shellcheck disable=SC1090
  source "${HOME}/.zshrc" >/dev/null 2>&1 || true
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[gateway] error: cargo not found in PATH" >&2
  exit 1
fi

cd "${REPO_ROOT}"
cargo build --locked --package tmex-gateway --bin tmex-gateway
exec "${REPO_ROOT}/target/debug/tmex-gateway" "$@"
