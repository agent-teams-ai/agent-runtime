#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"

SERVER_CONFIG=${OPEN_SANDBOX_SERVER_CONFIG:?set OPEN_SANDBOX_SERVER_CONFIG}
SERVER_PID_FILE=${OPEN_SANDBOX_SERVER_PID_FILE:?set OPEN_SANDBOX_SERVER_PID_FILE}
SERVER_LOG=${OPEN_SANDBOX_SERVER_LOG:?set OPEN_SANDBOX_SERVER_LOG}
SERVER_HEALTH_URL=${OPEN_SANDBOX_SERVER_HEALTH_URL:-http://127.0.0.1:18080/health}
SERVER_DOMAIN=${OPEN_SANDBOX_DOMAIN:-127.0.0.1:18080}

export EVIDENCE_DIR SPIKE_RUN_ID OPEN_SANDBOX_DOMAIN=$SERVER_DOMAIN

server_pid() {
  [[ -r "$SERVER_PID_FILE" ]] || return 1
  cat "$SERVER_PID_FILE"
}

server_is_expected() {
  local pid
  pid=$(server_pid) || return 1
  [[ -r "/proc/$pid/cmdline" ]] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "$SERVER_CONFIG"
}

stop_server() {
  local pid child
  pid=$(server_pid)
  if ! server_is_expected; then
    printf 'refusing to stop a process not owned by this spike\n' >&2
    return 1
  fi
  while read -r child; do
    [[ -n "$child" ]] && kill -KILL "$child" 2>/dev/null || true
  done < <(ps --ppid "$pid" -o pid=)
  kill -KILL "$pid"
  for _ in $(seq 1 30); do
    if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  printf 'OpenSandbox server remained healthy after forced stop\n' >&2
  return 1
}

start_server() {
  nohup env OPENSANDBOX_INSECURE_SERVER=YES \
    uvx --from "$OPEN_SANDBOX_SERVER_SPEC" opensandbox-server --config "$SERVER_CONFIG" \
    >> "$SERVER_LOG" 2>&1 &
  printf '%s\n' "$!" > "$SERVER_PID_FILE"
  for _ in $(seq 1 60); do
    if server_is_expected && curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  printf 'OpenSandbox server did not recover\n' >&2
  return 1
}

ensure_server() {
  if server_is_expected && curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
    return
  fi
  start_server
}

guard_host
if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1 || ! server_is_expected; then
  printf 'OpenSandbox server is not running as the spike-owned process\n' >&2
  exit 1
fi
trap ensure_server EXIT INT TERM
uv run --with "$OPEN_SANDBOX_SDK_SPEC" "$SCRIPT_DIR/opensandbox-spike.py" prepare-server-restart

stop_server
start_server
uv run --with "$OPEN_SANDBOX_SDK_SPEC" "$SCRIPT_DIR/opensandbox-spike.py" verify-server-restart
trap - EXIT INT TERM
