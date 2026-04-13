#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/dev-supervisor-pids.sh"

GATEWAY_PID=""
FRONTEND_PID=""

[[ "$(pid_store_get gateway)" == "" ]]
[[ "$(pid_store_get frontend)" == "" ]]

pid_store_set gateway "123"
pid_store_set frontend "456"

[[ "${GATEWAY_PID}" == "123" ]]
[[ "${FRONTEND_PID}" == "456" ]]
[[ "$(pid_store_get gateway)" == "123" ]]
[[ "$(pid_store_get frontend)" == "456" ]]

pid_store_clear gateway
[[ "$(pid_store_get gateway)" == "" ]]
[[ "$(pid_store_get frontend)" == "456" ]]

if pid_store_get unknown >/dev/null 2>&1; then
  echo "expected unknown service lookup to fail" >&2
  exit 1
fi

if pid_store_set unknown "789" >/dev/null 2>&1; then
  echo "expected unknown service store to fail" >&2
  exit 1
fi
