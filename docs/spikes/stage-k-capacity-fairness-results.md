# Stage K capacity and fairness results

Status: accepted scoped experimental evidence

Date: 2026-07-29

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage K exercised a PostgreSQL 18.4 capacity-contract model on the hosted
single-host Linux worker. Every campaign used a pinned, preloaded image, empty
Docker configuration, synthetic database, exact resource labels, and
`--pull=never`. It did not start a worker, agent, provider, MCP server, use a
credential or user project, or contact an external network.

## Accepted facts

- Thirty-two concurrent claims for eight slots produced exactly eight grants
  and 24 `capacity_full` results. Four tenants held two active claims each and
  the capacity fences were unique and monotonic.
- Thirty equal-priority grants across three continuously eligible tenants were
  distributed 10/10/10. A priority burst limit of three produced the observed
  order `high, high, high, medium, high, high, high, low` even while higher
  priority work remained queued.
- The finite wait bound is qualified only while the tenant set is fixed and
  finite, the operation remains queued and eligible, and the competing older
  eligible set is finite. Strict priority without the FIFO escape starved the
  low-priority operation in the retained negative case.
- Claim, quota-update, output-chunk, and reclaim-ack commands use a request ID
  plus semantic fingerprint. Exact replay returned the original receipt;
  conflicting and `NULL` identities failed closed without a second slot,
  history row, output chunk, quota revision, or reclaim transition.
- Quota shrink did not preempt three existing claims. New claims remained
  blocked until usage fell below the new quota. All 24 modeled claim/shrink
  races ended in one of the two serialized legal outcomes.
- Expired queued work was pruned before overload counting. In the retained
  overload campaigns, tenant admission produced 10 queued and 54
  `overloaded_tenant`; global admission produced five queued and 11
  `overloaded_global`.
- Lease loss closed canonical output and moved the slot to `reclaim_pending`.
  No successor claim was granted before an exact fencing acknowledgement.
  After acknowledgement the successor received a new fence; stale release and
  stale output remained rejected.
- Lease, expiry, output, and reclaim decisions used the pool's authoritative
  monotonic time. `NULL`, stale, and future caller assertions were rejected.
  A real PostgreSQL stop/start preserved clock, lease, fence, quota, claim,
  output, and command-journal state; exact retries after restart remained
  exact.
- Docker create failure and process-start failure both exercised label-owned
  cleanup. Both final campaigns and both fault probes left no container,
  volume, or network residue.
- A 300-grant soak across ten equal tenants produced exactly 30 grants per
  tenant.

## Architecture consequence

- Capacity remains an Agent Execution application port. The allocator owns
  pool truth; Agent Execution owns admission intent, local binding, lease-loss
  cutoff, output fencing, and reconciliation. This evidence does not justify a
  fifth bounded context.
- Reservation, claim, quota update, output chunk, and reclaim acknowledgement
  are separate idempotent commands with closed input schemas and conflict
  rejection. A response timeout never authorizes a new command identity.
- Quota shrink is non-preemptive. `reclaim_pending` consumes capacity until
  stale-host fencing is acknowledged or the slot is quarantined.
- Fairness policy must state its finite-starvation assumptions. Unbounded
  strict priority is not an accepted default.
- Caller timestamps are observations, not authority. Capacity decisions use
  the injected monotonic control-time view described by ADR-0001.

## Repeatability and evidence identity

The final campaigns used different externally supplied invocation nonces. Each
passed the same 46-check verifier; their normalized semantic projections had
the same digest:

```text
3fa11fcb9457c861c478aeefec22996db36f2b175d66c601760282fba48f2158
```

The comparison result was `CONSISTENT`. This establishes structural and
behavioral consistency of the agent-observed hosted runs, not cryptographic
execution attestation.

The raw hosted evidence is retained on `codex-workers-eu-01` under
`/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-k-capacity-fairness/`
(`v6`, `runs/calibration-v6-*`, `runs/final-*-v6-*`, and
`final-v6-comparison.json`). The repository retains only the redacted summary.

```text
schema / campaign / verifier / audit / comparator / self-test
93d63f0f1468c37805579a8aa611c67737a334ca6aecfd743bb8068696f0d180
73499d8752e10c89da39657ddd804f2f05acfb795da0327293b45b7d97c68da0
1c8426bdcc69e435a41499eaf04eadd5b54c0a8e8a370a27d8b9008bd9518dc9
47349c8a154f1a332d23c743b0f1620b1f96fb1d74d89583abb29d7bec4a0cde
ce1d96d4da34439230c8dd35754335fbe2d75de502d244e3f0cf3f60be8a1703
665df40ae08f021a152a03b1dd985c22b45561d2cc00dca8266aa1412d7d9557

calibration result / audit
f7273572609d205f26e06e285c82f61c1cb998c7f1ca47fe93cc0be085ddb9e5
bbf5c9816c352cfde65d076130d86d8a21602706b0f0bba7f6dae5e3d096ceb9

final A result / audit
4d0471256591f3b89b5f4ab81eedfb1c08bf0ab2e5e02faf2917feeefaa15cc9
71cc3a383ff0a03dc68e177509bb45849a4ff83fa11eb2dd9cb219fd9dabdb9c

final B result / audit
524c4a10694a6f003c3a07423a4d4e2366f5d1fb338239a96626940283571ecd
f1b725068377ff8978c62427a4668bce7a9b83102cd90e2b8905fcccc93c86d8

final comparison
8e7fc65dc2e2d2483fb7109fc2f3b14c417eaec44e37ca614603709190611403
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-k-capacity-fairness-summary.json`.

## Remaining gates

- production allocator and Agent Execution adapter implementation;
- real multi-controller and multi-host concurrency, allocator failover, and
  network partitions;
- worker crash, containment acknowledgement, quarantine, and long-duration
  renewal/backpressure soak;
- dynamic tenant-set and workload-policy qualification beyond the explicit
  finite fairness assumptions;
- production durable monotonic anchor, deployment observability, and recovery;
- cryptographic run attestation if independently verifiable evidence becomes a
  release requirement.
