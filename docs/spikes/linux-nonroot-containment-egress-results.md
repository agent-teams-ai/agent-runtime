# Linux non-root containment and egress results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/linux-nonroot-containment-egress-summary.json`

## Scope and safety

The campaign ran on the designated Linux hosting worker using only newly
created synthetic containers and networks. It did not mount or open a user
project, inherit a credential, call a provider, or expose a host port.

The tested host used Linux `6.8.0-134-generic`, Docker Engine `29.6.1`,
cgroup v2, the systemd cgroup driver, seccomp, and AppArmor. The pinned runtime
image was:

```text
node:24.18-bookworm-slim
sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
```

The first harness revision was rejected because its `docker top` field format
was invalid. It produced no accepted custody result. The final harness passed
three campaigns and an independent 50-of-50 audit.

## Accepted containment facts

Each runtime used:

- UID and GID `65532`;
- zero effective capabilities and `no-new-privileges`;
- seccomp filter mode and `docker-default (enforce)` AppArmor;
- read-only root plus a bounded temporary filesystem;
- PID limit 32, memory limit 96 MiB, and CPU limit 0.5;
- no network for the process-custody flow.

The provider parent created a detached child whose PID, process-group ID, and
session ID were equal and different from the parent's session. This reproduced
the important process-group/session escape shape.

Across all three campaigns:

- timed container stop observed two host PIDs, left zero survivors, and left
  zero container cgroup residue;
- forced container kill observed two host PIDs and left zero survivors;
- 80 process-creation attempts were bounded by the PID limit: the three
  success/failure pairs were `6/74`, `9/71`, and `9/71`;
- writing through the read-only root failed.

This closes the scoped question: a trusted container/cgroup owner can terminate
a descendant that escaped the provider process group and session. It does not
make the provider process or tenant code the container owner.

## Egress counterexample

An internal user-defined bridge allowed the exact synthetic endpoint while
blocking its unopened port, external HTTPS, and external DNS in all three
runs.

The same runs deliberately attached a second peer labelled unauthorized. The
provider reached that peer in every run. Docker documents the same property:
containers on one user-defined bridge can reach all listening ports of every
other attached container.

Therefore a Docker network is a connectivity boundary, not a signed endpoint
allowlist. `--internal` removes north-south connectivity in this sample but
does not authorize peers within the bridge.

The production topology must attach a provider container only to a
per-operation gateway-facing network. The gateway, not bridge membership,
enforces the signed destination host, port, protocol, DNS resolution, and
byte/time budget. Databases, brokers, the control plane, other providers, and
sibling workers must not share that provider-facing bridge.

The later synthetic OpenCode and application TLS gateway qualification is
recorded in
`docs/spikes/opencode-container-tls-gateway-results.md`. It confirmed the
end-to-end container path, TLS hostname validation, a pinned IP in the presence
of a duplicate alias, generic proxy denial, redirects, and byte/time budgets.

## Architecture consequences

- Agent Execution requests a container through a focused worker port; it never
  sends arbitrary Docker arguments.
- A trusted worker supervisor owns the full container and cgroup lifecycle.
  Provider code runs non-root and never receives the Docker socket.
- Process-group tracking remains useful for graceful shutdown and evidence,
  but the container/cgroup is the final Linux descendant-custody boundary.
- Runtime Capacity supplies explicit PID, memory, CPU, temporary-storage, and
  wall-time budgets for each execution generation.
- Runtime Security publishes exact egress authorization. The Linux adapter
  materializes it into a gateway policy and an isolated network topology.
- A same-network unexpected peer is a fail-closed preparation or attestation
  failure, not a harmless deployment detail.

## Evidence

```text
rejected v1 harness
597465eb4dbbe756df589e4300772b414df80ac5fef0775bf2b1de96671e3e74

accepted harness
dd486e1b0cb5574691f90747f06ad47c5eb2435eb3681868b9bf67b2c203241b

accepted results v8, v9, v10
ecf82273416fc2ba8644fea01df52ab2075d719d60b90a9370b861977937c1f2
723f3f8ceaf22e4846cf6dce7313aa86f51ed8df24c33f42ac1ce3118ba88408
723f3f8ceaf22e4846cf6dce7313aa86f51ed8df24c33f42ac1ce3118ba88408

independent audit script
c317f03741cac7d8f969d1982c9526e67eba5f6ba09d482805a0049cdd85b14e

independent audit result
e4f6f5a6b25b244b80cfd71943516b2bb42e23dcfdb7b1eea3ddb6b5d3a3dc89

retained bundle
18c64019e67a7fbdf4ee3ac2335533dc1ee0bc2cda226b6e43255ca5d2a4b266
```

Retained bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  linux-nonroot-containment-egress-2026-07-28.tar.gz
```

## Remaining gates

This is not a Linux production `GO`. The later follow-up closes the synthetic
end-to-end OpenCode container path and application-gateway TLS semantics.
The remaining gates are:

- production signed operation-policy loading and public-PKI external TLS/DNS
  conformance, including rebinding, private/reserved addresses, allowed IP
  rotation, external proxies, load balancers, and streaming backpressure;
- Docker daemon socket protection and trusted-supervisor authorization;
- custom seccomp and AppArmor policies plus image-signature enforcement;
- init and zombie-reaping behavior;
- the supported kernel, distribution, Docker, and cgroup-version matrix;
- physical power loss and worker-host replacement recovery.

References:

- [Docker bridge network
  driver](https://docs.docker.com/engine/network/drivers/bridge/);
- [Docker AppArmor security
  profiles](https://docs.docker.com/engine/security/apparmor/);
- [Docker resource
  constraints](https://docs.docker.com/engine/containers/resource_constraints/);
- [Docker Engine security](https://docs.docker.com/engine/security/).
