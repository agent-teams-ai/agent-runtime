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
  cat "$SERVER_PID_FILE"
}

server_is_expected() {
  local pid
  pid=$(server_pid)
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
  kill -KILL "$pid" 2>/dev/null || true
}

start_server() {
  nohup env OPENSANDBOX_INSECURE_SERVER=YES \
    uvx --from opensandbox-server opensandbox-server --config "$SERVER_CONFIG" \
    >> "$SERVER_LOG" 2>&1 &
  printf '%s\n' "$!" > "$SERVER_PID_FILE"
  for _ in $(seq 1 60); do
    if curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  printf 'OpenSandbox server did not recover\n' >&2
  return 1
}

ensure_server() {
  if curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
    return
  fi
  start_server
}

trap ensure_server EXIT INT TERM
guard_host
uv run --with opensandbox "$SCRIPT_DIR/opensandbox-spike.py" prepare-server-restart

stop_server
for _ in $(seq 1 30); do
  if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
start_server
uv run --with opensandbox "$SCRIPT_DIR/opensandbox-spike.py" verify-server-restart
trap - EXIT INT TERM
