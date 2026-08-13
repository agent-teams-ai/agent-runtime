#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"

export EVIDENCE_DIR SPIKE_RUN_ID
export OPEN_SANDBOX_VOLUME_ROOT=${OPEN_SANDBOX_VOLUME_ROOT:?set OPEN_SANDBOX_VOLUME_ROOT}

cleanup_all() {
  cleanup_spike_resources
  uv run --with opensandbox "$SCRIPT_DIR/opensandbox-spike.py" cleanup >/dev/null 2>&1 || true
}

trap cleanup_all EXIT INT TERM
guard_host

for scenario in density recovery isolation; do
  "$SCRIPT_DIR/$scenario.sh"
done

for scenario in density recovery isolation; do
  guard_host
  if [[ "$scenario" == density ]]; then
    uv run --with opensandbox "$SCRIPT_DIR/opensandbox-spike.py" density \
      --max-sandboxes "${OPEN_SANDBOX_MAX_SANDBOXES:-100}" \
      --step "${OPEN_SANDBOX_STEP:-10}" \
      --create-concurrency "${OPEN_SANDBOX_CREATE_CONCURRENCY:-1}" \
      --evidence-label "${OPEN_SANDBOX_EVIDENCE_LABEL:-sequential}"
  else
    uv run --with opensandbox "$SCRIPT_DIR/opensandbox-spike.py" "$scenario"
  fi
done

cleanup_all
trap - EXIT INT TERM
