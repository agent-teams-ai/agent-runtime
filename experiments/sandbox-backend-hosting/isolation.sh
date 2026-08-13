#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"

IMAGE=${IMAGE:-alpine:3.22.1}
RESULTS="$EVIDENCE_DIR/isolation.jsonl"
NETWORK_A=${SPIKE_NETWORK_PREFIX}tenant-a
NETWORK_B=${SPIKE_NETWORK_PREFIX}tenant-b
VOLUME_A=${SPIKE_VOLUME_PREFIX}tenant-a
VOLUME_B=${SPIKE_VOLUME_PREFIX}tenant-b

trap_cleanup
cleanup_spike_resources
guard_host
: > "$RESULTS"

record() {
  printf '{"at":"%s","scenario":"%s","outcome":"%s"}\n' "$(timestamp)" "$1" "$2" >> "$RESULTS"
}

docker network create --internal --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" "$NETWORK_A" >/dev/null
docker network create --internal --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" "$NETWORK_B" >/dev/null
docker volume create --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" "$VOLUME_A" >/dev/null
docker volume create --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" "$VOLUME_B" >/dev/null

docker run -d --name ats-spike-tenant-a --hostname tenant-a \
  --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" --network "$NETWORK_A" \
  --mount "type=volume,src=$VOLUME_A,dst=/workspace" \
  --memory 32m --cpus 0.03 --pids-limit 16 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=2m --security-opt no-new-privileges --cap-drop ALL \
  "$IMAGE" sh -c 'printf tenant-a-secret > /workspace/owner; while :; do sleep 60; done' >/dev/null

docker run -d --name ats-spike-tenant-b --hostname tenant-b \
  --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" --network "$NETWORK_B" \
  --mount "type=volume,src=$VOLUME_B,dst=/workspace" \
  --memory 32m --cpus 0.03 --pids-limit 16 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=2m --security-opt no-new-privileges --cap-drop ALL \
  "$IMAGE" sh -c 'printf tenant-b-secret > /workspace/owner; while :; do sleep 60; done' >/dev/null

if docker exec ats-spike-tenant-b ping -c 1 -W 1 tenant-a >/dev/null 2>&1; then
  record cross-tenant-network "unexpectedly_reachable"
  exit 1
else
  record cross-tenant-network "isolated"
fi

if docker exec ats-spike-tenant-b sh -c 'grep -R tenant-a-secret /workspace 2>/dev/null' >/dev/null 2>&1; then
  record cross-tenant-volume "unexpectedly_visible"
  exit 1
else
  record cross-tenant-volume "isolated"
fi

if docker exec ats-spike-tenant-b sh -c 'env | grep -E "AWS_|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY"' >/dev/null 2>&1; then
  record host-credential-inheritance "unexpected_secret_name"
  exit 1
else
  record host-credential-inheritance "not_inherited"
fi

docker rm -f ats-spike-tenant-a ats-spike-tenant-b >/dev/null
docker volume rm "$VOLUME_A" "$VOLUME_B" >/dev/null
docker network rm "$NETWORK_A" "$NETWORK_B" >/dev/null
record assigned-resource-reuse "destroyed_instead_of_reassigned"

cleanup_spike_resources
assert_no_spike_resources
printf 'isolation evidence: %s\n' "$RESULTS"
