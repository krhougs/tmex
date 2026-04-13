#!/usr/bin/env bash

pid_store_var_name() {
  case "${1:-}" in
    gateway)
      printf '%s' "GATEWAY_PID"
      ;;
    frontend)
      printf '%s' "FRONTEND_PID"
      ;;
    *)
      return 1
      ;;
  esac
}

pid_store_get() {
  local var_name
  var_name="$(pid_store_var_name "${1:-}")" || return 1
  printf '%s' "${!var_name:-}"
}

pid_store_set() {
  local var_name
  var_name="$(pid_store_var_name "${1:-}")" || return 1
  printf -v "${var_name}" '%s' "${2:-}"
}

pid_store_clear() {
  pid_store_set "${1:-}" ""
}
