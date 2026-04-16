#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
GHOSTTY_DIR="$REPO_ROOT/vendor/ghostty"
TOOLS_DIR="$REPO_ROOT/.cache/tools"
ZIG_VERSION="0.15.2"

read_locked_ghostty_commit() {
  git -C "$REPO_ROOT" ls-tree HEAD vendor/ghostty | awk '{print $3}'
}

detect_zig_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os/$arch" in
    Darwin/arm64)
      printf '%s\n' "zig-aarch64-macos-$ZIG_VERSION"
      ;;
    Darwin/x86_64)
      printf '%s\n' "zig-x86_64-macos-$ZIG_VERSION"
      ;;
    Linux/aarch64)
      printf '%s\n' "zig-aarch64-linux-$ZIG_VERSION"
      ;;
    Linux/x86_64)
      printf '%s\n' "zig-x86_64-linux-$ZIG_VERSION"
      ;;
    *)
      printf 'unsupported platform: %s/%s\n' "$os" "$arch" >&2
      exit 1
      ;;
  esac
}

ensure_zig() {
  local zig_dist zig_dir zig_bin archive tmp_dir
  zig_dist="$(detect_zig_target)"
  zig_dir="$TOOLS_DIR/$zig_dist"
  zig_bin="$zig_dir/zig"

  if [[ -x "$zig_bin" ]]; then
    printf '%s\n' "$zig_bin"
    return 0
  fi

  mkdir -p "$TOOLS_DIR"
  tmp_dir="$(mktemp -d)"
  archive="$tmp_dir/$zig_dist.tar.xz"

  curl -L "https://ziglang.org/download/$ZIG_VERSION/$zig_dist.tar.xz" -o "$archive"
  tar -xf "$archive" -C "$TOOLS_DIR"

  printf '%s\n' "$zig_bin"
}

if ! git -C "$GHOSTTY_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'ghostty submodule not initialized: %s\n' "$GHOSTTY_DIR" >&2
  exit 1
fi

LOCKED_GHOSTTY_COMMIT="$(read_locked_ghostty_commit)"
SUBMODULE_HEAD="$(git -C "$GHOSTTY_DIR" rev-parse HEAD)"

if [[ -z "$LOCKED_GHOSTTY_COMMIT" ]]; then
  printf 'failed to read locked vendor/ghostty commit from superproject\n' >&2
  exit 1
fi

if [[ "$LOCKED_GHOSTTY_COMMIT" != "$SUBMODULE_HEAD" ]]; then
  printf 'vendor/ghostty HEAD %s does not match locked superproject commit %s\n' \
    "$SUBMODULE_HEAD" \
    "$LOCKED_GHOSTTY_COMMIT" >&2
  exit 1
fi

ZIG_BIN="$(ensure_zig)"

cd "$GHOSTTY_DIR"
"$ZIG_BIN" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall

cp "$GHOSTTY_DIR/zig-out/bin/ghostty-vt.wasm" "$PKG_DIR/src/assets/ghostty-vt.wasm"

bun "$PKG_DIR/scripts/ghostty-wasm.ts" write-metadata

printf 'built %s from ghostty %s with %s\n' \
  "$PKG_DIR/src/assets/ghostty-vt.wasm" \
  "$SUBMODULE_HEAD" \
  "$("$ZIG_BIN" version)"
