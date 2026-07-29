# Stage N binary revision lifecycle results

Status: accepted scoped experimental evidence

Date: 2026-07-29

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage N exercised a deterministic executable-closure, rollout, compatibility,
worker-placement, lifecycle, and garbage-collection model on the hosted Linux
worker. It used only synthetic artifact and signing fixtures. It did not start
a real provider binary or worker, use a real database, artifact store, KMS,
credential, MCP server, external network, or user project.

## Accepted facts

- `BinaryRevision` identity is the digest of the complete executable closure.
  Changing helper, config, adapter, classifier, projector, or codec produced a
  different closure ID. Missing, duplicate, conflicting, malformed, unknown,
  and digest-mismatched components failed closed.
- Closure and component descriptors use exact closed shapes. Registration uses
  an explicit rollback-retention policy; old positional timestamps, absolute
  retention fields, unknown fields, and conflicting policy replay were
  rejected.
- Transcript compatibility produced four distinct results: exact continuation,
  explicit idempotent migration, read-only inspection, or incompatible. A
  required target, reader, or migration artifact had to remain retained.
- Activation used a closed signed command, exact principal/tenant binding,
  expected head generation, retained executable closure, compatible worker
  capacity, and reservation fence. Exact replay after an unknown response
  returned the committed receipt; conflicting or substituted identity failed
  closed.
- A session stayed bound to its accepted closure. Worker assignment atomically
  owned a lifecycle lease and assignment root. Drain allowed an already pinned
  continuation but denied a new assignment. Unknown, deprecated, collected, or
  non-executable closures could not be assigned.
- Release removed the active assignment, lease, and root and marked its journal
  receipt terminal. After deprecation and collection, replay of the original
  assignment request returned inactive historical evidence and did not
  recreate authority or state.
- Rollout, rollback, and reactivation required head-generation CAS and compatible
  capacity. A deprecated target required an explicit reactivation capability;
  a collected target could not be reactivated.
- Garbage collection was blocked by current head, rollback retention, active
  session lease, or assignment root. Collection left an immutable tombstone;
  registration replay, artifact-set mutation, direct GC calls, and snapshot
  mutation did not resurrect executable state.
- The clock store, lifecycle, registry, fleet, and head store had to share the
  exact composition graph and authoritative monotonic time identity. Startup,
  restart, stale anchor, clock regression, mixed clock, or mixed object graph
  failed closed.
- Authority-bearing maps and records are private. Public reads returned
  detached immutable snapshots. Direct property assignment, `defineProperty`,
  prototype mutation, and snapshot mutation could not replace head state,
  alter lifecycle state, inject artifacts, mutate reservations/journals, or
  bypass rollback/CAS.

## Architecture consequence

- Runtime Configuration may select and reference an immutable binary closure,
  but it does not own rollout head, worker compatibility, leases, deprecation,
  retention, rollback, or GC. Those lifecycle concerns remain inside Agent
  Execution, principally its Host Custody boundary.
- Mutable aliases and rollout heads are lookup/lifecycle state; neither is part
  of `BinaryRevision` identity. Activation and session state pin the immutable
  closure ID, never a mutable alias or newest head.
- A worker assignment is an authority-bearing lifecycle root. It is created and
  released atomically with its lease and terminal journal state.
- Exact replay returns current authority meaning. Historical success after
  release or collection cannot be interpreted as a new assignment.
- Aggregate state, journals, roots, reservations, and tombstones remain private;
  adapters and callers receive immutable snapshots through narrow ports.
- Binary closure lifecycle remains an internal Host Custody module concern in
  v1. This evidence does not justify a new bounded context.

## Repeatability and evidence identity

Calibration and both final campaigns passed the 285-check verifier. Final
results used different external nonces and raw identities, shared the exact
facts oracle, and had the same semantic digest:

```text
a16eb73c17a33d0badb793c3b2c5d6ff660716b61d15a75a073c68cab37b0eed
```

The comparator returned `GO` for structural consistency. External nonces bind
the observed artifacts but do not provide cryptographic execution attestation.

The raw hosted evidence is retained on `codex-workers-eu-01` under
`/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-n-binary-revision/`
(`v12`, `runs/calibration-v12-*`, `runs/final-*-v12-*`, and
`final-v12-comparison.json`). The repository retains only the redacted summary.

```text
contract / campaign / audit / comparator
2ea2d50265cd45bf64f6bac0977d80e0a5afc2951028bfc822091e404340fd07
f35df403140b7234e7c6634d76c1affb5287e959768b75575ed7464d550a0fea
8403fb74ec4622a32f88876d1d923807e537f6e9dfb2d2a827b703488f1bdc60
2b1b2ea1124dd6fc2f5a1950113528ff27613f9b21d16c02bf82ebd85b2bff98

calibration result / audit
227adb7b6f5fd0e49b05a7c83a2675c9a12aac522c1091db236e6c3dcf07bcab
8493dbeda224d74fe0267330e705b9eea3dfe1e55afecc14393db2a1abaa119d

final A result / audit
ce2085f8bf417231fe7ee3869d273630aea0280b0442ebbd080072416a03cedc
36e13a9cf9a8a85bfdbade2d86b140ec62a35682f5d6182ed57c463655c3a7fb

final B result / audit
ab2393aae847fdb491502b757031ccd79389a5c6bf2cf48cccfb3f4160e03975
ff6beb2d0623ddf25bbb650fa6bbea23e266e64768b0f34fa644b88c6de6d733

final comparison
9d92eb61996467b9046c8f5434902f3a02a17430eb97657e9430d6c7147454f5

facts oracle / audit-check oracle
01ed77680b3cc97639d9f6146c13d988cd9ce8d51b04333994ea409bfa274441
280155971f444d2d3fa3dc8f1fdda560c7d05fd49505a58c31834f50238e50fd
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-n-binary-revision-summary.json`.

## Remaining gates

- production artifact store, signatures, KMS custody, provenance and
  corruption handling;
- real production database transactions, concurrent controllers and durable
  monotonic anchor adapter/storage;
- real worker fleet, provider binaries, process custody and supported closure
  matrix;
- rolling upgrade, rollback, drain, crash, host-loss and cross-host partition
  campaigns;
- artifact retention, backup/restore, GC operations and measured rollback
  window;
- cryptographic execution attestation if it becomes a release requirement.
