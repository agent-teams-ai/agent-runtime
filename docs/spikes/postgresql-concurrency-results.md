# PostgreSQL concurrency and recovery results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

The final single-host v3 campaign passed an independent 32-of-32 read-only
audit. A later two-physical-host client campaign passed an independent
48-of-48 read-only audit. Together they qualify the tested PostgreSQL command,
dispatch, outbox, inbox, crash, same-server restore, cross-host client race,
and complete SSH-link-loss contracts. They do not qualify PostgreSQL HA,
leader failover, asymmetric partitions, physical power loss, or production
disaster recovery.

## Safety and scope

The campaign ran on the designated Linux hosting worker with synthetic data in
a dedicated Docker network, container, and volume. It used no user project,
ambient credential, provider request, MCP server, or external agent runtime.
Cleanup removed every resource with the campaign prefix without touching
pre-existing containers.

The database was the official `postgres:18.4-trixie` image at digest
`sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`.
PostgreSQL reported version 18.4 with data checksums enabled and Read Committed
isolation.

## Rejected evidence

The first campaign was rejected because the official image's temporary
initialization postmaster answered `pg_isready` before the final postmaster
became stable. The corrected harness bound readiness to the final server
identity.

The v2 runtime passed, but its independent audit rejected it as final evidence:

- the reported operation-row field directly checked only the outbox count;
- it did not test one command ID racing across different sessions;
- it did not directly test concurrent initial dispatch claims.

The v3 campaign added those cases and retained the earlier evidence rather than
rewriting the rejected result.

## Accepted v3 facts

### Command identity and sequencing

- 32 concurrent submissions of one command created exactly one operation and
  one outbox row; 31 returned replay.
- Reusing the command ID with a different semantic payload or session failed
  closed.
- In a 16-client race using one command ID across two sessions, one session
  won, eight clients replayed its result, and eight clients for the other
  session received typed conflicts. Exactly one operation and outbox row
  existed.
- 48 concurrent unique commands for one session committed the gap-free
  sequence `1..48`; the stored session counter ended at 48.
- A client killed after commit but before receiving the response retried as a
  replay and did not duplicate the operation or outbox row.

### Dispatch and acceptance uncertainty

- Of 16 concurrent initial dispatch claimers, one acquired fence 1 and 15
  observed `busy`.
- Expiring a started lease moved it to `reconcile_required`; repeated claims
  did not blindly redispatch.
- After an explicit `known_not_accepted` resolution, retry acquired fence 2.
  The stale fence was rejected.
- Repeating the same acceptance receipt was idempotent. A conflicting receipt
  was rejected and the accepted command remained terminal.

### Transactions, outbox, and inbox

- A forced transaction rollback left zero session, operation, and outbox rows.
- Eight workers claimed all 92 outbox events without duplicate ownership.
- Twenty-four duplicate deliveries to one consumer produced exactly one side
  effect through its durable inbox.
- An expired outbox claim was reclaimed with a new generation; the stale
  generation could not acknowledge it.

### Crash and logical restore

- After database-container `SIGKILL` and restart, the counts remained
  `93/93/1` for operation, outbox, and inbox rows. `pg_amcheck` passed and a
  new write succeeded.
- A same-server `pg_dump`/`pg_restore` cycle retained 94 operations, 94 outbox
  rows, one inbox row, one side effect, and the same projection digest.

## Cross-host client and transport follow-up

The accepted v6 campaign used two physical hosts:

```text
macOS 15.6.1 arm64, psql 14.18
  -> dedicated loopback SSH forward
  -> Linux hosting worker
  -> private Docker network
  -> PostgreSQL 18.4
```

The database had no published host port. Sixteen macOS and 16 Linux clients
racing one command created one operation/outbox pair and returned 31 replays.
An 8-by-8 cross-session command-ID race produced eight winner-session
successes, eight typed conflicts, and one operation. Twenty-four commands from
each host produced the exact gap-free sequence `1..48`.

Two complete SSH-link-loss cases were then exercised:

- after the command became externally visible but before the macOS client
  received its response, the client failed and retry returned replay;
- while PostgreSQL was sleeping inside an open transaction before a buffered
  `COMMIT`, the client failed, but PostgreSQL continued the already received
  batch and committed; retry again returned replay.

Both cases ended with exactly one operation and one outbox row. The second
case falsifies the assumption that disconnecting a client guarantees database
rollback. A transport failure means `commit outcome unknown`; recovery must
query or retry the same durable command ID.

The final `pg_amcheck --install-missing` passed. Cleanup left no campaign
container, volume, or network.

### Rejected cross-host revisions

- v1 transported multiline SQL incorrectly through the SSH shell.
- v2 opened one SSH session per database client and hit SSH admission limits
  before the database assertion.
- v3 expected an open transaction to roll back on disconnect; PostgreSQL
  continued the buffered batch and committed.
- v4 rejected an unclassified `pg_amcheck` failure.
- v5 proved the failure was not corruption: the fresh database lacked the
  `amcheck` extension, so there were no relations to check.

The v6 source added the documented `--install-missing` prerequisite and was
the only revision promoted. The independent audit passed 48 of 48 checks.

Official PostgreSQL documentation defines the relevant
[transaction-isolation behavior](https://www.postgresql.org/docs/18/transaction-iso.html),
[data-checksum scope](https://www.postgresql.org/docs/18/checksums.html),
simple-query
[multi-statement transaction flow](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT),
the fact that a successfully dispatched
[cancel request need not take effect](https://www.postgresql.org/docs/18/libpq-cancel.html),
[`pg_amcheck`](https://www.postgresql.org/docs/18/app-pgamcheck.html), and
[`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Architecture consequences

The accepted evidence supports these production invariants:

- one globally unique durable command ID, with fail-closed semantic mismatch;
- a locked per-session sequence counter, never `MAX(sequence) + 1`;
- aggregate state and transactional outbox persisted atomically;
- an idempotent inbox or equivalent ledger for every integration consumer;
- an explicit `reconcile_required` state after acceptance uncertainty;
- monotonically increasing fences or generations for dispatch receipts and
  outbox claims;
- separate schema and migration ownership per bounded context, with no
  cross-context SQL;
- every client disconnect treated as an unknown commit outcome until the
  durable command ID is reconciled;
- a bounded pooled worker transport rather than one SSH/control connection per
  database command.

These rules apply equally to the initial in-process adapters and future
RPC/broker adapters. They allow a bounded context to be extracted without
moving aggregate ownership or rewriting its use cases.

The experimental schema and harness are evidence only. Production code must
not copy them without its own design and conformance review.

## Evidence identity

```text
schema
54c53ce47838feaeac638b6b4b2200779484ebd6ca6c0f8a355e60818be3d617

harness
8e4a651b248b91bd5277cd47b1e605204c24db9b12cb8e9b6b4e9bddfc6288d0

v3 result
c40e50bd66b93e4d184c7632298ec04db9d02e39a5557013cca8520b748563ae

independent audit source
bb01caed36cebd4c8e4b6f95781725ef7851822f1f9cfc50abfe652c11219e87

independent audit result, 32/32 GO
7d734f36cf83d923d3f9d09c40581500846b40e93d605900621775ac9659e4b4

retained bundle
345eeb2a83e2814a4b3730d08418beed15e7e2d62f79f9491186c8e3bd233931

cross-host v6 harness
087ccfe4b1e59e896a2356d286768bf051ad235bcd5ee843578c9eb74ad1b8c0

cross-host v6 result
8d852f839dbd25e16e1ddf5df391d165002549293ca83bafed7b3e1cf5d14b44

cross-host independent audit source
0722ff5a5713963688b526bdda9fa6dcb7baac49015f751ec3531b9f8c6a0c3d

cross-host independent audit result, 48/48 GO
273b412b2d0f0990a561ed2860a5c847d4190cb62039896a081588b8be325d85

cross-host retained bundle
22f7a46f201713a11d3200659c8537b3a48497e0fbc65dc4fa7e871059753091
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/postgresql-concurrency-summary.json`.

## Remaining production gates

- PostgreSQL replication, leader failover, split-brain fencing, and measured
  RPO/RTO;
- general delay, packet loss, asymmetric partition, and multi-control-plane or
  multi-worker orchestration;
- off-host backup, restore, and point-in-time recovery;
- physical power loss;
- production connection-pool, migration-locking, statement-timeout, and
  cancellation conformance.
