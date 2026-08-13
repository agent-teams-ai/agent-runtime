#!/usr/bin/env bash
set -euo pipefail

SPIKE_RUN_ID=${SPIKE_RUN_ID:-sandbox-hosting-v1}
SPIKE_LABEL_KEY=agent_teams_spike
SPIKE_LABEL_VALUE=$SPIKE_RUN_ID
export SPIKE_NETWORK_PREFIX=ats-spike-
export SPIKE_VOLUME_PREFIX=ats-spike-
EVIDENCE_DIR=${EVIDENCE_DIR:-$(pwd)/artifacts/sandbox-hosting-spike}
MIN_AVAILABLE_MEMORY_MB=${MIN_AVAILABLE_MEMORY_MB:-3072}
MIN_FREE_DISK_GB=${MIN_FREE_DISK_GB:-20}
MAX_CPU_PSI_AVG10=${MAX_CPU_PSI_AVG10:-80}
MAX_MEMORY_PSI_AVG10=${MAX_MEMORY_PSI_AVG10:-10}
MAX_IO_PSI_AVG10=${MAX_IO_PSI_AVG10:-20}

mkdir -p "$EVIDENCE_DIR"

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

available_memory_mb() {
  awk '/MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo
}

free_disk_gb() {
  df -Pk "$EVIDENCE_DIR" | awk 'NR == 2 { print int($4 / 1024 / 1024) }'
}

psi_avg10() {
  local resource=$1
  awk '/^some / { for (i = 1; i <= NF; i++) if ($i ~ /^avg10=/) { split($i, value, "="); print value[2]; exit } }' "/proc/pressure/$resource"
}

greater_than() {
  awk -v left="$1" -v right="$2" 'BEGIN { exit !(left > right) }'
}

guard_host() {
  local memory disk cpu_psi memory_psi io_psi
  memory=$(available_memory_mb)
  disk=$(free_disk_gb)
  cpu_psi=$(psi_avg10 cpu)
  memory_psi=$(psi_avg10 memory)
  io_psi=$(psi_avg10 io)

  if (( memory < MIN_AVAILABLE_MEMORY_MB )); then
    printf 'guard: available memory %s MB is below %s MB\n' "$memory" "$MIN_AVAILABLE_MEMORY_MB" >&2
    return 1
  fi
  if (( disk < MIN_FREE_DISK_GB )); then
    printf 'guard: free disk %s GB is below %s GB\n' "$disk" "$MIN_FREE_DISK_GB" >&2
    return 1
  fi
  if greater_than "$cpu_psi" "$MAX_CPU_PSI_AVG10"; then
    printf 'guard: CPU PSI avg10 %s exceeds %s\n' "$cpu_psi" "$MAX_CPU_PSI_AVG10" >&2
    return 1
  fi
  if greater_than "$memory_psi" "$MAX_MEMORY_PSI_AVG10"; then
    printf 'guard: memory PSI avg10 %s exceeds %s\n' "$memory_psi" "$MAX_MEMORY_PSI_AVG10" >&2
    return 1
  fi
  if greater_than "$io_psi" "$MAX_IO_PSI_AVG10"; then
    printf 'guard: IO PSI avg10 %s exceeds %s\n' "$io_psi" "$MAX_IO_PSI_AVG10" >&2
    return 1
  fi
}

capture_host_snapshot() {
  local name=$1
  {
    printf 'captured_at=%s\n' "$(timestamp)"
    printf 'available_memory_mb=%s\n' "$(available_memory_mb)"
    printf 'free_disk_gb=%s\n' "$(free_disk_gb)"
    printf 'cpu_psi_avg10=%s\n' "$(psi_avg10 cpu)"
    printf 'memory_psi_avg10=%s\n' "$(psi_avg10 memory)"
    printf 'io_psi_avg10=%s\n' "$(psi_avg10 io)"
    docker info --format 'docker_server={{.ServerVersion}} storage={{.Driver}} cgroup={{.CgroupVersion}} cpus={{.NCPU}} memory={{.MemTotal}}'
  } > "$EVIDENCE_DIR/$name.env"
}

cleanup_spike_resources() {
  docker ps -aq --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" | xargs -r docker rm -f >/dev/null
  docker network ls -q --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" | xargs -r docker network rm >/dev/null
  docker volume ls -q --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE" | xargs -r docker volume rm -f >/dev/null
}

assert_no_spike_resources() {
  local count
  count=$(
    {
      docker ps -aq --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE"
      docker network ls -q --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE"
      docker volume ls -q --filter "label=$SPIKE_LABEL_KEY=$SPIKE_LABEL_VALUE"
    } | sed '/^$/d' | wc -l
  )
  if (( count != 0 )); then
    printf 'cleanup: %s spike-owned Docker resources remain\n' "$count" >&2
    return 1
  fi
}

trap_cleanup() {
  trap 'cleanup_spike_resources' EXIT INT TERM
}
