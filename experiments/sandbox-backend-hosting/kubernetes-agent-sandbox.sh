#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"

KIND_VERSION=${KIND_VERSION:-v0.32.0}
KUBECTL_VERSION=${KUBECTL_VERSION:-v1.36.1}
AGENT_SANDBOX_VERSION=${AGENT_SANDBOX_VERSION:-v0.5.4}
TOOLS_DIR=${TOOLS_DIR:?set TOOLS_DIR}
KUBECONFIG=${KUBECONFIG:?set KUBECONFIG}
CLUSTER_NAME=${CLUSTER_NAME:-ats-sandbox-spike-v1}
NAMESPACE=${NAMESPACE:-ats-sandbox-spike-v1}
RESULTS="$EVIDENCE_DIR/kubernetes-agent-sandbox.jsonl"
KIND="$TOOLS_DIR/kind"
KUBECTL="$TOOLS_DIR/kubectl"

mkdir -p "$TOOLS_DIR" "$(dirname "$KUBECONFIG")"
: > "$RESULTS"

record() {
  printf '{"at":"%s","scenario":"%s","outcome":"%s","durationMs":%s}\n' \
    "$(timestamp)" "$1" "$2" "$3" >> "$RESULTS"
}

download_tools() {
  if [[ ! -x "$KIND" ]]; then
    gh release download "$KIND_VERSION" --repo kubernetes-sigs/kind \
      --pattern kind-linux-amd64 --pattern kind-linux-amd64.sha256sum \
      --dir "$TOOLS_DIR"
    (cd "$TOOLS_DIR" && sha256sum --check kind-linux-amd64.sha256sum)
    mv "$TOOLS_DIR/kind-linux-amd64" "$KIND"
    chmod 0755 "$KIND"
  fi

  if [[ ! -x "$KUBECTL" ]]; then
    curl -fsSLo "$KUBECTL" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl"
    curl -fsSLo "$KUBECTL.sha256" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl.sha256"
    printf '%s  %s\n' "$(cat "$KUBECTL.sha256")" "$KUBECTL" | sha256sum --check
    chmod 0755 "$KUBECTL"
  fi
}

cleanup_cluster() {
  if [[ -x "$KIND" ]]; then
    "$KIND" delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  fi
}

trap cleanup_cluster EXIT INT TERM
guard_host
download_tools
cleanup_cluster

started=$(date +%s%N)
"$KIND" create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --wait 120s
ended=$(date +%s%N)
record cluster-create ready "$(( (ended - started) / 1000000 ))"

"$KUBECTL" apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$AGENT_SANDBOX_VERSION/sandbox.yaml"
"$KUBECTL" apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$AGENT_SANDBOX_VERSION/extensions.yaml"
"$KUBECTL" wait --for=condition=Ready pod \
  -l app=agent-sandbox-controller -n agent-sandbox-system --timeout=180s
"$KUBECTL" create namespace "$NAMESPACE"

started=$(date +%s%N)
"$KUBECTL" apply -n "$NAMESPACE" -f - <<'YAML'
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: lifecycle
spec:
  podTemplate:
    spec:
      containers:
        - name: runtime
          image: alpine:3.22.1
          command: ["sh", "-c", "while :; do sleep 60; done"]
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 50m
              memory: 32Mi
      restartPolicy: Never
YAML
"$KUBECTL" wait -n "$NAMESPACE" --for=condition=Ready sandbox/lifecycle --timeout=120s
pod_name=$(
  "$KUBECTL" get sandbox -n "$NAMESPACE" lifecycle \
    -o jsonpath='{.metadata.annotations.agents\.x-k8s\.io/pod-name}'
)
"$KUBECTL" exec -n "$NAMESPACE" "$pod_name" -- sh -c 'printf lifecycle-ok' \
  | grep -Fxq lifecycle-ok
"$KUBECTL" delete -n "$NAMESPACE" sandbox/lifecycle --wait=true --timeout=120s
ended=$(date +%s%N)
record direct-sandbox-lifecycle ready-and-deleted "$(( (ended - started) / 1000000 ))"

"$KUBECTL" apply -n "$NAMESPACE" -f - <<'YAML'
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: warm-template
spec:
  podTemplate:
    spec:
      containers:
        - name: runtime
          image: alpine:3.22.1
          command: ["sh", "-c", "while :; do sleep 60; done"]
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 50m
              memory: 32Mi
      restartPolicy: Never
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: warm-pool
spec:
  replicas: 2
  sandboxTemplateRef:
    name: warm-template
YAML
pool_ready=0
for _ in $(seq 1 120); do
  pool_ready=$(
    "$KUBECTL" get sandboxwarmpool -n "$NAMESPACE" warm-pool \
      -o jsonpath='{.status.readyReplicas}'
  )
  pool_ready=${pool_ready:-0}
  if (( pool_ready >= 2 )); then
    break
  fi
  sleep 1
done
if (( pool_ready < 2 )); then
  printf 'warm pool did not create two members\n' >&2
  exit 1
fi

started=$(date +%s%N)
"$KUBECTL" apply -n "$NAMESPACE" -f - <<'YAML'
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: warm-claim
spec:
  warmPoolRef:
    name: warm-pool
YAML
"$KUBECTL" wait -n "$NAMESPACE" --for=condition=Ready \
  sandboxclaim/warm-claim --timeout=60s
claimed_sandbox=$(
  "$KUBECTL" get sandboxclaim -n "$NAMESPACE" warm-claim \
    -o jsonpath='{.status.sandbox.name}'
)
"$KUBECTL" wait -n "$NAMESPACE" --for=condition=Ready \
  "sandbox/$claimed_sandbox" --timeout=60s
ended=$(date +%s%N)
record warm-pool-claim ready "$(( (ended - started) / 1000000 ))"

started=$(date +%s%N)
"$KUBECTL" delete namespace "$NAMESPACE" --wait=true --timeout=120s
ended=$(date +%s%N)
record namespace-disposition deleted "$(( (ended - started) / 1000000 ))"

capture_host_snapshot kubernetes-agent-sandbox-after
cleanup_cluster
trap - EXIT INT TERM
printf 'Kubernetes Agent Sandbox evidence: %s\n' "$RESULTS"
