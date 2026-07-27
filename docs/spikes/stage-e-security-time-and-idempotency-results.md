# Stage E security, time, and idempotency results

Status: scoped architecture evidence

Date: 2026-07-27

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

No production runtime code was written in this stage. Every campaign used
synthetic configuration, secrets, clocks, commands, and external-effect
adapters on the designated Linux hosting worker.

## Secret separation

Accepted campaigns:

```text
stage-e-secret-separation-v2-alpha-2026-07-27T13-50-03-368Z-5a860e2c
stage-e-secret-separation-v2-beta-2026-07-27T13-50-08-186Z-0ccc5d3f
```

Frozen source pin:

```text
a5e8e8d7ba7727a29f69b9f1307d46632ddc19c19159c8d007cea5aa560004bc
```

Each campaign accepted 12 documents, failed 6 malformed or unsafe documents
closed, produced 134 classifications and 79 opaque credential references, and
exercised 3 executable resources. Forty persisted negative artifacts per
campaign were checked by separate verifier processes.

Confirmed:

- profile and executable-resource identity excludes credential bytes;
- secrets remain behind typed Provider Access references;
- public evidence, logs, classifications, and exported configuration reject
  the exercised secret forms;
- executable resources require provider-aware classification;
- malformed or unsupported structures fail closed;
- mutation fixtures proved the verifier detects the exercised leaks.

Scoped partials:

- provider-specific corpora still need independent Claude, Codex, and OpenCode
  conformance;
- no generic scanner can prove that a semantically broad field does not hide
  an intentionally disguised secret;
- same-host root was the signing and filesystem trust anchor;
- production key custody, rotation, backup, and crypto-erasure were not tested.

## Idempotency and retention

Accepted campaigns:

```text
stage-e-idempotency-retention-v2-alpha-e821dc49a0673fb2
stage-e-idempotency-retention-v2-beta-19f4a60dce8b2751
```

Frozen source pin:

```text
0c98cbd1e6578bf7dda1b6ae2e1b32d3bbecef7864b6807bb638591a3e9d0f2a
```

The independent verifier passed 658 assertions and rejected 20 persisted
mutated SQLite fixtures. Ten real SIGKILL checkpoints were bound to PID, boot
identity, and process start time.

Confirmed:

- an exact retry returns the durable prior outcome;
- the same command or idempotency identity with different semantic payload
  returns conflict;
- outcome eviction preserves deduplication and returns
  `IDEMPOTENCY_RESULT_EXPIRED` without redispatch;
- a command identity remains retired even after its result expires;
- configured idempotency-key reuse after the tombstone horizon requires a new
  command identity;
- acceptance uncertainty enters reconciliation rather than blind retry;
- state, command receipt, outcome, artifact reference, and garbage-collection
  intent survive the exercised crash windows;
- referenced artifacts cannot be collected by the exercised cleanup race.

Scoped partials:

- external provider acceptance was synthetic and same-host;
- physical power loss, PostgreSQL, distributed concurrency, and real transport
  timeout were not exercised;
- expiry correctness depends on the separately tested clock authority model.

## Clock, expiry, and rollback

Accepted self-verified campaigns:

```text
stage-e-v5-rho-20260727T144506Z-2f5ab696
stage-e-v5-sigma-20260727T144510Z-52ab0dd1
```

Both campaigns independently replayed 79 transitions and rejected 36 negative
fixtures. Their normalized digest was identical:

```text
c40d30a64a4e02b174ae1b714ead2f9f26d259a06d606a29f32467e872cd3362
```

Confirmed:

- expiry decisions use a repository-owned, revisioned time anchor rather than
  caller-provided wall time;
- decision and checkpoint evidence is authority-bound and reconstructable from
  persisted JSON;
- non-finite, unsafe, malformed, rollback, stall, stale-revision, and replayed
  observations fail closed;
- CAS and an independently computed reference model agree for all accepted
  transitions;
- rejected v3 and v4 evidence is explicitly marked superseded.

This lane remains `SELF_VERIFIED_AWAITING_EXTERNAL_REVIEW`. A direct read-only
audit rechecked source inventory, detached signatures, campaign manifests,
negative outcomes, selected raw outputs, and the independent reference model,
but it is not represented as a separate external-agent verdict.

Critical limitation:

- coordinated rollback of both runtime state and its revision guard cannot be
  detected using only local mutable storage. Production rollback resistance
  needs an external monotonic root, TPM, remote witness, or append-only trusted
  storage.

Other partials:

- HMAC keys and clocks were synthetic;
- suspend/reboot behavior, physical power loss, and multi-process database
  contention were not tested;
- local root can override filesystem mode bits.

## Architecture consequence

The evidence supports these boundaries:

- secret material belongs to Provider Access, never profile identity;
- command identity, semantic fingerprint, retained result, and tombstone have
  separate lifecycles;
- expiry is evaluated through an authority-owned clock capability;
- a result may expire without making redispatch safe;
- external acceptance uncertainty always reconciles before retry;
- production trust roots and rollback resistance remain explicit deployment
  concerns, not domain booleans.
