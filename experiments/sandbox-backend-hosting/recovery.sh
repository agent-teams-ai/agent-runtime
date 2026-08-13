#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"

IMAGE=${IMAGE:-alpine:3.22.1}
RESULTS="$EVIDENCE_DIR/recovery.jsonl"
RESOURCE_NAME=ats-spike-recovery-target
GENERATION_LABEL=agent_teams_generation

trap_cleanup
cleanup_spike_resources
guard_host
: > "$RESULTS"

record() {
  printf '{"at":"%s","scenario":"%s","outcome":"%s"}\n' "$(timestamp)" "$1" "$2" >> "$RESULTS"
}

docker run -d --name "$RESOURCE_NAME" \
  --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" \
  --label "$GENERATION_LABEL=2" \
  --memory 32m --cpus 0.03 --pids-limit 16 --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=2m --security-opt no-new-privileges --cap-drop ALL \
  "$IMAGE" sh -c 'while :; do sleep 60; done' >/dev/null
record lost-create-ack "reconciled_by_exact_name_and_generation"

if docker run -d --name "$RESOURCE_NAME" \
  --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" "$IMAGE" true >/dev/null 2>&1; then
  record duplicate-create "unexpectedly_accepted"
  exit 1
else
  record duplicate-create "rejected_without_second_resource"
fi

observed_generation=$(docker inspect -f "{{ index .Config.Labels \"$GENERATION_LABEL\" }}" "$RESOURCE_NAME")
if [[ "$observed_generation" == 2 ]]; then
  record stale-generation-1 "rejected_before_mutation"
else
  record stale-generation-1 "invalid_observation"
  exit 1
fi

docker rm -f "$RESOURCE_NAME" >/dev/null
record lost-kill-ack "reconciled_as_absent"
docker rm -f "$RESOURCE_NAME" >/dev/null 2>&1 || true
record duplicate-kill "idempotent_absent"

cleanup_spike_resources
assert_no_spike_resources
printf 'recovery evidence: %s\n' "$RESULTS"
