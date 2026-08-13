#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"

IMAGE=${IMAGE:-alpine:3.22.1}
MAX_SANDBOXES=${MAX_SANDBOXES:-100}
STEP=${STEP:-10}
MEMORY_LIMIT=${MEMORY_LIMIT:-32m}
CPU_LIMIT=${CPU_LIMIT:-0.03}
PIDS_LIMIT=${PIDS_LIMIT:-16}
RESULTS="$EVIDENCE_DIR/density.csv"

trap_cleanup
cleanup_spike_resources
guard_host
capture_host_snapshot density-before
printf 'count,create_seconds,total_mem_bytes,total_cpu_percent,available_memory_mb,cpu_psi_avg10,memory_psi_avg10,io_psi_avg10\n' > "$RESULTS"

for (( target = STEP; target <= MAX_SANDBOXES; target += STEP )); do
  guard_host || break
  current=$(docker ps -q --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" | wc -l)
  started=$(date +%s%N)
  for (( index = current + 1; index <= target; index++ )); do
    docker run -d \
      --name "ats-spike-density-$index" \
      --label "$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" \
      --memory "$MEMORY_LIMIT" \
      --cpus "$CPU_LIMIT" \
      --pids-limit "$PIDS_LIMIT" \
      --network none \
      --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,size=2m \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      "$IMAGE" sh -c 'while :; do sleep 60; done' >/dev/null
  done
  ended=$(date +%s%N)
  sleep 2

  mapfile -t container_ids < <(
    docker ps -q --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE"
  )
  stats=$(docker stats --no-stream \
    --format '{{.MemUsage}}|{{.MemPerc}}|{{.CPUPerc}}' "${container_ids[@]}")
  total_mem=$(printf '%s\n' "$stats" | awk -F'[| /]+' '
    function bytes(value, number) {
      number = value + 0
      if (value ~ /KiB$/) return number * 1024
      if (value ~ /MiB$/) return number * 1024 * 1024
      if (value ~ /GiB$/) return number * 1024 * 1024 * 1024
      return number
    }
    { total += bytes($1) }
    END { printf "%.0f", total }
  ')
  total_cpu=$(printf '%s\n' "$stats" | awk -F'|' '{ gsub(/%/, "", $3); total += $3 } END { printf "%.3f", total }')
  elapsed=$(awk -v start="$started" -v end="$ended" 'BEGIN { printf "%.3f", (end - start) / 1000000000 }')
  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$target" "$elapsed" "$total_mem" "$total_cpu" \
    "$(available_memory_mb)" "$(psi_avg10 cpu)" "$(psi_avg10 memory)" "$(psi_avg10 io)" >> "$RESULTS"
done

capture_host_snapshot density-after
cleanup_spike_resources
assert_no_spike_resources
printf 'density evidence: %s\n' "$RESULTS"
