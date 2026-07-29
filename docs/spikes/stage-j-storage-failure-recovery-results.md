# Stage J storage failure and recovery results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage J exercised PostgreSQL 18.4 on a dedicated 384 MiB loopback ext4 image
on the hosted Linux worker. Each campaign created and removed its own image,
mount, loop device, container, synthetic database, and backup. It did not use
a user project, credential, agent/provider/MCP process, or pre-existing Docker
resource.

## Scope

The campaign covered:

- synthetic filesystem `ENOSPC` with a 32 MiB emergency reserve;
- transactional state plus outbox rollback;
- recovery after reserve release and a new successful write;
- database-container `SIGKILL`, restart, projection verification, and
  `pg_amcheck`;
- offline one-byte relation corruption with data checksums enabled;
- corruption detection by read and `pg_amcheck`;
- restore from a backup stored outside the corrupted loopback image;
- projection-digest and `pg_amcheck` verification after restore.

It did not cut physical power, lose the host, use an off-host backup, exercise
replication/failover, or qualify production disaster recovery.

## Accepted facts

### ENOSPC and atomicity

- The campaign reduced available non-reserved ext4 space from 230,027,264
  bytes to 2,097,152 bytes.
- A transaction that updated aggregate state and inserted an incompressible
  outbox payload failed with an operating-system no-space class.
- State revision, state digest, and outbox count all remained at their
  pre-transaction values. No half-committed state/outbox pair was observed.
- Releasing the preallocated 32 MiB reserve restored database availability.
  After removing synthetic pressure, a new state-plus-outbox transaction
  committed.

### Crash, corruption, and restore

- After database-container `SIGKILL`, a new postmaster recovered the exact
  state/outbox projection and `pg_amcheck` passed.
- With the database cleanly stopped, the campaign flipped one byte in a
  2,932,736-byte relation. After restart, both the relation read and
  `pg_amcheck` failed with checksum/page-corruption classification.
- A pre-corruption custom-format backup restored into a clean database. The
  restored state/outbox semantic projection matched the pre-corruption
  projection and `pg_amcheck` passed.
- Every final campaign removed its container, unmounted ext4, detached its
  loop device, and removed its synthetic work directory.

## Repeatability and audit

Calibration and two parallel final campaigns passed a 38-of-38 independent
read-only verifier. Random ENOSPC diagnostic hashes were deliberately excluded
from semantics. The explicit final semantic projection had the same digest in
both campaigns:

```text
0b5b884b5df41512f157a5e92fda4b54a7058027a4d386b0e821259db9899224
```

Raw results differed.

## Architecture consequence

- Aggregate state and transactional outbox remain one database transaction;
  storage failure cannot be converted into a partially successful command.
- Storage health is an infrastructure readiness input to admission. Workers
  stop accepting new durable work before a configured free-space watermark;
  they do not wait for the first `ENOSPC` error.
- A protected emergency reserve is an operational recovery mechanism, not
  normal capacity. Releasing it creates room for shutdown/recovery and does
  not authorize continued workload.
- Database process restart plus successful reads is insufficient integrity
  evidence; checksums and structural checks remain explicit recovery gates.
- Checksums detect corruption but do not repair it. A backup is not qualified
  until restore, semantic projection comparison, and integrity checks pass.

These are persistence-adapter and deployment contracts. They do not create a
new domain context or move aggregate/outbox ownership.

## Evidence identity

```text
source / verifier / semantic comparator
6104285ec2734b00b138c86c3df827aa35b5b03428dd4f19fc4e021df5b3374a
9b4490b4ea30e07946463659b33e95b50095e6086e1328406526a914f9e01838
4d9e1adc1daa46162d01ad28cfaa70df8cb219856621fdcfdb3c5ef59b10089d

calibration result / audit
63a772213c13e6a554c033787205c90687351844544dcbd4ebc1b2e3825bc2e8
64bba73a1a9c519b1a98f2a25c8267111b4b620709463b64aac8d68bdca5be57

final A result / audit
85558c88a8931315205f7a9b79d63dae2eb2929d4cd2766e08de22d218df0c02
241b17fc7788a40a6c32d25bfba9d0ed70037efd1b870272789f6a1592c7926c

final B result / audit
6a4f16a5f420988b1ea9607cd6b1731b5da635c7e9e2db472de132fc23cdf914
d8d1002f6372d1d7f13184a97f82fb11e084c5cb76b33a95582288e76e6d5ab8

final comparison
68bfc0da62404ab091e4c6eb35eaea4dcac81f72030ded593edd820e49259862
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-j-storage-failure-recovery-summary.json`.

## Remaining gates

- production free-space watermark, reserve custody, alerting, and admission
  integration;
- physical power loss and full worker-host replacement;
- off-host backup, restore, retention, encryption, and key-loss behavior;
- continuous archiving, PITR, replication, leader failover, and split-brain
  fencing;
- measured RPO/RTO and repeated disaster-recovery drills;
- supported filesystem, kernel, storage-class, and database-version matrix.
