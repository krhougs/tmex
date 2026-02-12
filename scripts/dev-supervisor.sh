#!/usr/bin/env bash

set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_DIR}/.env"
ENV_FALLBACK_FILE="${PROJECT_DIR}/.env.example"

if ! command -v bun >/dev/null 2>&1; then
  if [[ -f "${HOME}/.zshrc" ]]; then
    # shellcheck disable=SC1090
    source "${HOME}/.zshrc" >/dev/null 2>&1 || true
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[dev-supervisor] error: bun not found in PATH" >&2
  exit 1
fi

cd "$PROJECT_DIR"

load_env_file() {
  local file="$1"
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

if [[ -f "$ENV_FILE" ]]; then
  load_env_file "$ENV_FILE"
  ENV_SOURCE="$ENV_FILE"
elif [[ -f "$ENV_FALLBACK_FILE" ]]; then
  load_env_file "$ENV_FALLBACK_FILE"
  ENV_SOURCE="$ENV_FALLBACK_FILE"
else
  ENV_SOURCE="(none)"
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  case "$DATABASE_URL" in
    /*|file:*|sqlite:*|http:*|https:*|:memory:*)
      ;;
    *)
      DATABASE_URL="${PROJECT_DIR}/${DATABASE_URL#./}"
      export DATABASE_URL
      ;;
  esac
fi

declare -A PIDS=()
RESTART_DELAY_SECONDS=1
POLL_INTERVAL_SECONDS=0.3
SHUTTING_DOWN=0

MANAGED_SSH_AGENT_PID=""
MANAGED_SSH_AUTH_SOCK=""
FRONTEND_STARTED_ONCE=0
GATEWAY_WAIT_TIMEOUT_SECONDS="${GATEWAY_WAIT_TIMEOUT_SECONDS:-30}"

log() {
  local message="$1"
  echo "[dev-supervisor][$(date '+%Y-%m-%d %H:%M:%S')] ${message}"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

log "env source: ${ENV_SOURCE}"
if [[ -n "${GATEWAY_PORT:-}" ]]; then
  log "gateway port: ${GATEWAY_PORT}"
fi
if [[ -n "${FE_PORT:-}" ]]; then
  log "frontend port: ${FE_PORT}"
fi

resolve_socket_from_env() {
  if [[ -n "${SSH_AUTH_SOCK:-}" && -S "${SSH_AUTH_SOCK}" ]]; then
    return 0
  fi

  if [[ -f "${HOME}/.ssh/agent.env" ]]; then
    # shellcheck disable=SC1090
    source "${HOME}/.ssh/agent.env" >/dev/null 2>&1 || true
  fi

  if [[ -n "${SSH_AUTH_SOCK:-}" && -S "${SSH_AUTH_SOCK}" ]]; then
    return 0
  fi

  if command_exists zsh; then
    local zsh_socket
    zsh_socket="$(zsh -lic 'printf "%s" "${SSH_AUTH_SOCK:-}"' 2>/dev/null || true)"
    if [[ -n "${zsh_socket}" && -S "${zsh_socket}" ]]; then
      export SSH_AUTH_SOCK="${zsh_socket}"
      return 0
    fi
  fi

  if [[ -n "${SSH_AUTH_SOCK:-}" && -S "${SSH_AUTH_SOCK}" ]]; then
    return 0
  fi

  return 1
}

resolve_socket_from_tmp() {
  local discovered_socket
  discovered_socket="$(find /tmp -maxdepth 2 -type s -name 'agent.*' -user "$(id -un)" 2>/dev/null | head -n 1 || true)"

  if [[ -z "${discovered_socket}" ]]; then
    return 1
  fi

  export SSH_AUTH_SOCK="${discovered_socket}"
  return 0
}

ensure_ssh_agent_socket() {
  resolve_socket_from_env && return 0
  resolve_socket_from_tmp && return 0

  if command_exists ssh-agent; then
    eval "$(ssh-agent -s)" >/dev/null 2>&1
  fi

  if [[ -n "${SSH_AUTH_SOCK:-}" && -S "${SSH_AUTH_SOCK}" ]]; then
    return 0
  fi

  return 1
}

ensure_default_ssh_key_loaded() {
  if ! command_exists ssh-add; then
    return 0
  fi

  if ssh-add -l >/dev/null 2>&1; then
    return 0
  fi

  for key_path in "${HOME}/.ssh/id_ed25519" "${HOME}/.ssh/id_rsa"; do
    if [[ -f "${key_path}" ]]; then
      ssh-add "${key_path}" >/dev/null 2>&1 || true
      break
    fi
  done
}

stop_managed_ssh_agent() {
  local pid="${MANAGED_SSH_AGENT_PID:-}"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    log "stop ssh-agent: pid=${pid}"
    kill "${pid}" >/dev/null 2>&1 || true

    local i=0
    while kill -0 "${pid}" >/dev/null 2>&1; do
      sleep 0.05
      i=$((i + 1))
      if [[ "${i}" -ge 100 ]]; then
        kill -9 "${pid}" >/dev/null 2>&1 || true
        break
      fi
    done
  fi

  MANAGED_SSH_AGENT_PID=""
  MANAGED_SSH_AUTH_SOCK=""
  unset SSH_AUTH_SOCK SSH_AGENT_PID >/dev/null 2>&1 || true
}

start_managed_ssh_agent_fresh() {
  stop_managed_ssh_agent

  if command_exists ssh-agent; then
    unset SSH_AUTH_SOCK SSH_AGENT_PID >/dev/null 2>&1 || true
    eval "$(ssh-agent -s)" >/dev/null 2>&1

    MANAGED_SSH_AGENT_PID="${SSH_AGENT_PID:-}"
    MANAGED_SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}"

    if [[ -n "${MANAGED_SSH_AGENT_PID:-}" && -n "${MANAGED_SSH_AUTH_SOCK:-}" && -S "${MANAGED_SSH_AUTH_SOCK}" ]]; then
      export SSH_AUTH_SOCK="${MANAGED_SSH_AUTH_SOCK}"
      export SSH_AGENT_PID="${MANAGED_SSH_AGENT_PID}"
      log "ssh-agent started: pid=${MANAGED_SSH_AGENT_PID}, sock=${MANAGED_SSH_AUTH_SOCK}"
      ensure_default_ssh_key_loaded || true
      return 0
    fi

    if [[ -n "${MANAGED_SSH_AGENT_PID:-}" ]]; then
      kill "${MANAGED_SSH_AGENT_PID}" >/dev/null 2>&1 || true
    fi

    MANAGED_SSH_AGENT_PID=""
    MANAGED_SSH_AUTH_SOCK=""
  fi

  if ensure_ssh_agent_socket; then
    MANAGED_SSH_AGENT_PID="${SSH_AGENT_PID:-}"
    MANAGED_SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}"
    log "warning: using discovered ssh-agent socket: ${MANAGED_SSH_AUTH_SOCK} (pid=${MANAGED_SSH_AGENT_PID:-unknown})"
    ensure_default_ssh_key_loaded || true
    return 0
  fi

  log "warning: SSH_AUTH_SOCK 未设置，SSH Agent 认证将不可用"
  return 1
}

is_managed_ssh_agent_alive() {
  if [[ -n "${MANAGED_SSH_AGENT_PID:-}" ]] && ! kill -0 "${MANAGED_SSH_AGENT_PID}" >/dev/null 2>&1; then
    return 1
  fi

  if [[ -z "${MANAGED_SSH_AUTH_SOCK:-}" ]] || [[ ! -S "${MANAGED_SSH_AUTH_SOCK}" ]]; then
    return 1
  fi

  return 0
}

gateway_healthcheck_ok() {
  local gateway_port="${GATEWAY_PORT:-9663}"
  local url="http://127.0.0.1:${gateway_port}/healthz"

  if command_exists curl; then
    curl -sf "${url}" >/dev/null 2>&1
    return $?
  fi

  (
    exec 3<>"/dev/tcp/127.0.0.1/${gateway_port}" || exit 1
    printf 'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' >&3
    local status_line=""
    IFS= read -r status_line <&3 || true
    exec 3<&- 3>&- || true
    [[ "${status_line}" == *" 200 "* ]]
  ) >/dev/null 2>&1
  return $?
}

wait_gateway_ready_before_first_frontend_start() {
  if [[ "${FRONTEND_STARTED_ONCE}" -eq 1 ]]; then
    return 0
  fi

  local timeout_seconds="${GATEWAY_WAIT_TIMEOUT_SECONDS:-30}"
  if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]]; then
    timeout_seconds=30
  fi

  local gateway_port="${GATEWAY_PORT:-9663}"
  log "wait gateway ready before starting frontend (timeout=${timeout_seconds}s): http://127.0.0.1:${gateway_port}/healthz"

  local start_ts
  start_ts="$(date +%s)"

  while true; do
    if [[ "${SHUTTING_DOWN}" -eq 1 ]]; then
      return 1
    fi

    if gateway_healthcheck_ok; then
      log "gateway ready"
      return 0
    fi

    local now_ts
    now_ts="$(date +%s)"
    if [[ $((now_ts - start_ts)) -ge "${timeout_seconds}" ]]; then
      log "warning: gateway not ready within ${timeout_seconds}s, continue starting frontend"
      return 1
    fi

    sleep 1
  done
}

start_gateway_with_fresh_agent() {
  local old_pid="${PIDS[gateway]:-}"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
    kill "${old_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${old_pid}" ]]; then
    wait "${old_pid}" >/dev/null 2>&1 || true
  fi

  start_managed_ssh_agent_fresh || true

  if [[ -n "${MANAGED_SSH_AUTH_SOCK:-}" ]] && [[ -S "${MANAGED_SSH_AUTH_SOCK}" ]]; then
    log "start gateway: bun --cwd apps/gateway --watch src/index.ts (ssh-agent pid=${MANAGED_SSH_AGENT_PID:-unknown})"
    SSH_AUTH_SOCK="${MANAGED_SSH_AUTH_SOCK}" \
      SSH_AGENT_PID="${MANAGED_SSH_AGENT_PID:-}" \
      bun --cwd apps/gateway --watch src/index.ts &
  else
    log "start gateway: bun --cwd apps/gateway --watch src/index.ts (without ssh-agent)"
    bun --cwd apps/gateway --watch src/index.ts &
  fi

  PIDS[gateway]=$!
}

start_frontend() {
  log "start frontend: bun run --cwd apps/fe dev"
  bun run --cwd apps/fe dev &
  PIDS[frontend]=$!
}

stop_all() {
  if [[ "$SHUTTING_DOWN" -eq 1 ]]; then
    return
  fi

  SHUTTING_DOWN=1
  log "received stop signal, stopping all services"

  for service in gateway frontend; do
    local pid="${PIDS[${service}]:-}"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done

  for service in gateway frontend; do
    local pid="${PIDS[${service}]:-}"
    if [[ -n "$pid" ]]; then
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done

  stop_managed_ssh_agent
}

trap 'stop_all; exit 0' INT TERM

start_gateway_with_fresh_agent
wait_gateway_ready_before_first_frontend_start || true
start_frontend
FRONTEND_STARTED_ONCE=1

while true; do
  if [[ "$SHUTTING_DOWN" -eq 1 ]]; then
    break
  fi

  gateway_pid="${PIDS[gateway]:-}"
  if [[ -z "${gateway_pid}" ]]; then
    log "gateway pid missing, restarting with fresh ssh-agent"
    sleep "${RESTART_DELAY_SECONDS}"
    start_gateway_with_fresh_agent
  elif kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    if ! is_managed_ssh_agent_alive; then
      log "ssh-agent died, restarting gateway with fresh ssh-agent"
      sleep "${RESTART_DELAY_SECONDS}"
      start_gateway_with_fresh_agent
    fi
  else
    if wait "${gateway_pid}" >/dev/null 2>&1; then
      gateway_exit_code=0
    else
      gateway_exit_code=$?
    fi

    log "gateway exited with code ${gateway_exit_code}, restarting in ${RESTART_DELAY_SECONDS}s (with fresh ssh-agent)"
    sleep "${RESTART_DELAY_SECONDS}"
    start_gateway_with_fresh_agent
  fi

  frontend_pid="${PIDS[frontend]:-}"
  if [[ -z "${frontend_pid}" ]]; then
    sleep "${RESTART_DELAY_SECONDS}"
    start_frontend
  elif ! kill -0 "${frontend_pid}" >/dev/null 2>&1; then
    if wait "${frontend_pid}" >/dev/null 2>&1; then
      frontend_exit_code=0
    else
      frontend_exit_code=$?
    fi

    log "frontend exited with code ${frontend_exit_code}, restarting in ${RESTART_DELAY_SECONDS}s"
    sleep "${RESTART_DELAY_SECONDS}"
    start_frontend
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done
