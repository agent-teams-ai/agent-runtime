# Stage H version-skew and migration contract results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage H exercised rolling-version and expand/contract contracts against real
PostgreSQL transactions. It used a disposable PostgreSQL 18.4 container with
data checksums on and Read Committed isolation. It did not use a user project,
ambient credentials, provider process, provider request, or MCP server.

## Scope

The frozen source covered:

- old and new consumers receiving v1 and additive v2 events;
- deterministic v1-to-v2 normalization;
- unsupported v3 quarantine followed by progress on later events;
- concurrent inbox replay;
- event-version retirement gates;
- additive schema expansion, rollback to an old writer, backfill, and contract;
- active old-binary leases and concurrent migration claims.

It ran on one physical Linux host with an experimental schema. It did not run
real old and new services, inject a network partition, execute a production
migration, or qualify service extraction.

## Accepted facts

### Event version skew

- Both consumer revisions applied the v1 event. The v2 consumer normalized
  missing `routeClass` to the deterministic value `default`.
- The v1 consumer applied the additive v2 event while ignoring the new field;
  the v2 consumer applied the full v2 shape.
- Both consumers quarantined unsupported v3. Each then applied the following
  valid v1 event, so one poison record did not stop partition progress.
- 24 concurrent duplicate deliveries all returned the existing applied inbox
  disposition. No duplicate projection mutation was granted.
- Version 1 could not retire while either an active consumer required it or an
  unarchived v1 event remained. It became eligible only after both conditions
  cleared.

### Expand, backfill, contract, and rollback

- The old reader read rows produced by the expanded writer.
- The old writer still wrote successfully before contract, which preserved
  rollback compatibility during the expansion window.
- Backfill populated two legacy rows; every row had the new non-null value
  before contract.
- Contract remained blocked while an active v1 binary lease existed. After
  retiring that lease and completing backfill, the gate became ready.
- 16 concurrent migration claims produced one claimant and 15 busy results.
- After dropping the v1 column, the old writer failed. This is the expected
  irreversible boundary and proves why active old-binary leases must block
  contract.

## Repeatability and audit

Calibration passed a 44-of-44 independent read-only verifier. Two final
campaigns used the same frozen schema, harness, and verifier and also passed
44 of 44. Their raw result hashes differed while their canonical fact sets
shared digest:

```text
616a028a5dfcaed5710411bbf8b01193d362e15926dfc5374651a763f61653f3
```

Cleanup removed every Stage H container, volume, and network without touching
pre-existing Docker resources.

## Architecture consequence

The campaign supports the existing modular-control-plane strategy:

- integration events evolve additively and consumers deploy before producers;
- deterministic upcasters and inbox identities belong to consumer adapters;
- unsupported versions are quarantined explicitly rather than guessed;
- event retirement depends on both consumer contracts and retained events;
- schema contract is a durable migration with expand, backfill, binary-lease
  gate, single migration claim, and only then destructive contract;
- each bounded context owns its schema and migration port, which preserves a
  later service-extraction seam without requiring services today.

No bounded-context ownership change was required. The experimental SQL is
evidence, not production migration code.

## Evidence identity

```text
schema
2ad0c23feb809c8df6bc470297d343cf63eb37c689b39dfb68f5348084f2ee7b

harness
894aaa01e1183ff54b747acf43a7a1143a507495ca8aa0ee87dabf9921a88396

read-only verifier
19fbfbdabc44f124b16b37f70743abd5fc344313eb84a3cb831945083412ac1f

calibration result / audit
b08712d1c1b50e20f51aff4a8823fd6cc9d7d60e01184ba54ebfd14652a7f1ad
f5fef9729710f5474bf451c3c3a588d954426494a490a6cdb515041d1ae6378b

final A result / audit
8725b2e0a703189bd0cbb4fd0ce4655128990da77af2527d87d1ba79d79f5fc9
872ec5fecc5b5f5ba6d686d99cc70bc54b8e2124e9a7d22cca3646f355804f58

final B result / audit
e3c1fa25c152649eb1a88e5d913009b1995212acf64e82e0eaf076c076485f6e
dabea47ee6b47ac14e508b0ac23102ea9903fed47fe6f6b086e8aa260e69bdb4

final comparison
e131d29d5d04808b9438558201dc63ec76c4dcf2823fc971b4c1d6c66f563a6b
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-h-version-skew-migration-summary.json`.

## Remaining gates

- production event, inbox, upcaster, and migration implementation;
- real rolling old/new binary deployment and rollback;
- cross-host delay, packet loss, asymmetric partition, replication, and
  failover;
- poison-message operations, retention, replay, and repair UX;
- production backup, restore, PITR, and measured RPO/RTO;
- contract tests across every separately deployable adapter and generated SDK.
