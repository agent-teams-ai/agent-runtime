# Sandbox backend hosting qualification results

Status: scoped feasibility evidence, not a qualified target

Date: 2026-08-13

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

## Question

Can a shared Linux host support 100 lightweight sandbox sessions, survive lost
acknowledgements and a control-process crash, isolate tenant network, credentials,
and writable data, and provide enough evidence to choose between OpenSandbox and
a direct Kubernetes Agent Sandbox adapter?

## Environment

- isolated worker host with 8 CPUs, 15.6 GiB RAM, cgroup v2, and Docker 29.6.1;
- synthetic Alpine 3.22.1 workloads with 0.03 CPU, 32 MiB, and bounded PIDs;
- OpenSandbox Server 0.2.2, Python SDK 0.1.15, and CLI 0.1.1;
- OpenSandbox `execd` 1.0.21 and egress 1.1.4;
- Kubernetes Agent Sandbox 0.5.4;
- Kind 0.32.0 with Kubernetes 1.36.1 and kubectl 1.35.3;
- one disposable namespace, Kind cluster, OpenSandbox state store, port range,
  volume root, metadata namespace, and Docker label namespace.

The probes did not use an agent provider, user project, production data, or
foreign container. Guards stopped admission below 3 GiB available memory, 20 GiB
free disk, or configured PSI limits. Cleanup selected only spike-owned resources.
The reusable harness now pins kubectl 1.36.1 to match the Kind node; the recorded
run used kubectl 1.35.3 and exercised only stable lifecycle operations.

The campaign was collected before the repository-ownership correction under the
isolated host path
`/var/data/agent-teams-ai--agent-teams-orchestrator/spikes/sandbox-v1`.
That path is retained evidence custody only; its historical name grants no
Orchestrator ownership. The canonical reusable harness now lives in this Agent
Runtime repository.

## Results

| Scenario | Result |
| --- | --- |
| Raw Docker density | 100 active idle containers; about 49.1 MiB aggregate container RSS |
| Raw Docker startup | Each additional group of 10 took 12.4-16.0 seconds on the shared host |
| OpenSandbox sequential density | 100 active sandboxes; all creates and cleanup completed |
| OpenSandbox sequential startup | Last groups of 10 took 26.3-31.2 seconds, about 2.6-3.1 seconds per sandbox |
| OpenSandbox burst create, concurrency 10 | Intermittent port-allocation collision; two failed rounds, including one of five controlled repeats |
| OpenSandbox client reconnect | Reconnected to the same running sandbox after losing the local client |
| OpenSandbox server crash | Sandbox remained usable after killing and restarting only the spike-owned server process |
| Lost create acknowledgement | One resource was found by operation metadata |
| Duplicate operation identity | Backend created two resources; it does not own command idempotency |
| Generation fencing | Backend lifecycle API has no expected-generation fence |
| Network isolation | Tenant B could not reach tenant A or the cloud metadata endpoint under deny-egress policy |
| Credential inheritance | Common host credential variables were not inherited |
| Writable volume isolation | Each tenant observed only its assigned host-path workspace |
| Runtime cleanup | Sandbox resources disappeared after destruction |
| Workspace cleanup | Workspace remained until a separate explicit disposition step removed it |
| KAS direct lifecycle | Sandbox became Ready, executed a command through its Pod, and deleted in about 7.9 seconds |
| KAS warm-pool claim | Ready claim allocation completed in about 0.74 seconds |
| KAS cleanup | Namespace and the complete Kind cluster were deleted |

The OpenSandbox SDK `get_metrics()` result was host-scoped in this Docker setup:
it reported about 16 GiB total memory and several GiB used for a sandbox limited
to 32 MiB, while Docker cgroup metrics showed about 3.9 MiB. Adapter qualification
must not use that SDK value as per-sandbox accounting.

Disk free space fell by several GiB while repeatedly creating environments and
Kind nodes. Some of that cost is shared image cache rather than live-sandbox
state. Capacity policy therefore needs separate image, writable-layer, workspace,
artifact, and retained-evidence budgets rather than one sandbox count.

## Interpretation

The evidence supports the accepted Agent Runtime ownership boundary:

- Agent Runtime owns idempotency, expected-generation fencing, containment compilation,
  resource lifecycle, and technical receipts;
- AR-composed runtime-capacity admission serializes or limits creates where a backend cannot
  prove safe concurrent allocation;
- sandbox resource disposition and workspace disposition remain separate
  owner-local operations;
- concrete sandbox products remain replaceable Agent Runtime outbound adapters.

OpenSandbox is useful as a common local and single-host API, but its Docker
adapter is not production-qualified. The concurrent host-port race, missing
backend idempotency and generation fence, and host-scoped metrics require adapter
guardrails or upstream fixes.

Kubernetes Agent Sandbox provides valuable native lifecycle, reconciliation, and
warm-pool semantics. A direct KAS adapter remains a first-class hosted option.
The spike does not justify making OpenSandbox a mandatory layer above KAS. That
choice needs a dedicated interoperability and failure-semantics comparison.

## Limitations and readiness gates

- the host had unrelated background load, so measurements are suitability
  evidence rather than capacity SLOs;
- workloads were idle Alpine containers, not coding agents with language servers;
- no gVisor, Kata, Firecracker, confidential VM, GPU, or nested-container profile
  was installed;
- the Kind probe used ordinary container runtime and proves lifecycle, not strong
  hostile-code isolation;
- no multi-node Kubernetes failure, network partition, autoscaling, eviction,
  node death, or persistent-volume recovery was exercised;
- no credential proxy, dynamic secret rotation, image signature policy, SBOM,
  system-call filter qualification, or kernel exploit test was performed;
- no Desktop packaging, macOS VM, Windows container, or local hibernation profile
  was exercised;
- no long-duration soak, fork bomb, disk-full, inode exhaustion, noisy-neighbor,
  or 100 concurrent-create storm was performed.

Before selecting a production backend, qualify each supported assurance profile
with representative agent workloads, runtime-specific isolation, concurrent
admission, resource accounting, node failure, residue scans, and destructive
cleanup evidence.

The retained harness is
[`experiments/sandbox-backend-hosting`](../../experiments/sandbox-backend-hosting/README.md).
