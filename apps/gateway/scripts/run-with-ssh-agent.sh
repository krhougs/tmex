#!/usr/bin/env bash

set -euo pipefail

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

  if command -v zsh >/dev/null 2>&1; then
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

  if command -v ssh-agent >/dev/null 2>&1; then
    eval "$(ssh-agent -s)" >/dev/null
  fi

  if [[ -n "${SSH_AUTH_SOCK:-}" && -S "${SSH_AUTH_SOCK}" ]]; then
    return 0
  fi

  return 1
}

if ensure_ssh_agent_socket; then
  echo "[gateway] SSH_AUTH_SOCK=${SSH_AUTH_SOCK}"

  if command -v ssh-add >/dev/null 2>&1 && ! ssh-add -l >/dev/null 2>&1; then
    for key_path in "${HOME}/.ssh/id_ed25519" "${HOME}/.ssh/id_rsa"; do
      if [[ -f "${key_path}" ]]; then
        ssh-add "${key_path}" >/dev/null 2>&1 || true
        break
      fi
    done
  fi
else
  echo "[gateway] warning: SSH_AUTH_SOCK 未设置，SSH Agent 认证将不可用" >&2
fi

exec bun "$@"
