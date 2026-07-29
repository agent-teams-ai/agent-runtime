# Stage L PostgreSQL failover results

Status: accepted scoped experimental evidence

Date: 2026-07-29

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage L exercised two isolated synthetic three-node PostgreSQL 18.4 clusters
on one hosted Linux worker. The safe campaign used separate replication and
client network identities, pinned preloaded images, empty Docker
configuration, and no external network. It did not use a credential, user
project, agent, provider, MCP server, managed HA system, or second physical
failure domain.

## Accepted facts

- The retained negative cluster allowed two divergent primaries to accept
  writes while disconnected. A replication-visible authority epoch and unique
  command key inside each database did not fence the other writer. Replication
  state is therefore not write authority.
- With synchronous replication configured for `remote_apply`, the baseline
  command and outbox row were visible on both standbys before acknowledgement.
- Concurrent exact command replay converged to one command and one outbox row;
  the same command ID with another fingerprint failed closed.
- Loss and later rejoin of one standby preserved command processing through the
  remaining synchronous standby.
- Loss of synchronous quorum left `COMMIT` waiting in `SyncRep`. PostgreSQL
  statement timeout did not turn that outcome into a safe retry decision. The
  controller deadline fenced the client, recorded an unknown outcome, restored
  quorum, reconciled the ledger, and then replayed to exactly one command and
  one outbox row.
- The old primary process and client route were fenced before promotion. A
  stale controller session was terminated within the supervisor boundary; no
  successor write relied on the old primary voluntarily observing a new epoch.
- The new primary advanced the durable authority generation before accepting
  post-failover work. Output carrying the old generation was rejected.
- The former primary was rebuilt with `pg_rewind`, persisted least-privilege
  `replicator` upstream identity, and rejoined as a streaming standby. The
  receiver and sender both observed the new timeline; post-failover writes were
  visible after rejoin.
- Replication aliases had to be network-specific. Reusing the client-network
  alias produced an address outside the replication HBA subnet and prevented
  reparenting; the retained final campaign uses `pg-*-repl` identities.
- Both final campaigns removed every container, volume, network, and anonymous
  PostgreSQL volume.

## Architecture consequence

- PostgreSQL replication is a persistence mechanism, not the owner of
  execution authority. An external controller must fence the old writer and
  client route before successor writes.
- A synchronous-commit deadline produces `unknown`, not `failed`. Recovery
  reconciles the durable command ledger before deciding whether an exact retry
  is allowed.
- Promotion, authority-generation advance, command acceptance, and canonical
  output use separate observable receipts and fences.
- Reparenting is complete only after persisted upstream identity, receiver,
  sender, HBA, DNS/network identity, timeline, and post-failover visibility are
  all observed.
- This is a persistence/HA adapter contract. It does not create a new bounded
  context or move aggregate/outbox ownership.

## Repeatability and evidence identity

Both final campaigns passed 67/67 checks. Raw results differed, the frozen
source/runtime pins matched, and the timing-excluded semantic digest was the
same:

```text
a9ff2b535191d1bcc1091ec238e5cffbc9f2e36f8759926a88d0a44b9f74e72b
```

The raw hosted evidence is retained on `codex-workers-eu-01` under
`/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-l-postgres-failover/`
(`v10`, the two retained `final-*-v9-*` campaign directories with v10 audits,
and `final-v10-comparison.json`). The repository retains only the redacted
summary.

```text
schema / campaign / audit / comparator
0c5d34ff28ecd60899ecd7a82659f0235c2edffbd71cb059bb2c0682a256a929
a31c6bc122922e2a5143360168d6f71462b447b852feef0836034fbba7f628e8
11f9b877c2e33c39ceba7fc5b450e56a0503977eed86cefeae75b8099bdc4587
59cb36a561401984daf8a7f2e849b458830783d46ca5e7470e1017c16a6ed393

calibration result / audit
1ca0611db9f06fc7c5ad08a3017da2804ec5c23519879f9ec6ca0aca693c048d
858f61885fad7072cf90f28b808cb4feb76500fd950b959a719dcb546292aa2d

final A result / audit
df46e2193ebf1cb38acda972c2ae2402ae3e9ba91de4b54e3a169bb875e1ffd2
d899c9969a4bdb6343d65654233b677ca1ad715bf3482bd74bfea12819e7d8d8

final B result / audit
9579f67eabd3f960ca74dba86c6ceb76e8ec3387ac06952350a3f4d625808762
70375de96862b0178457457ca3c71bd9dd5d05859ddd4dade75afbe40b9a5e84

final comparison
47b1d7d176f61c683e6cdc73623f9fad49003d124dfea218b5eca79efc5d0ea1
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-l-postgres-failover-summary.json`.

## Remaining gates

- an external production HA manager and independent STONITH/fencing system;
- two or more physical database hosts with asymmetric delay, loss and network
  partition campaigns;
- connection-pool, proxy, load-balancer, DNS and deployment-drain behavior;
- WAL archive, PITR, backup/restore, failback and topology migration;
- measured RPO/RTO, quorum-policy operations and repeated disaster-recovery
  drills;
- production key/certificate custody and supported PostgreSQL/platform matrix.
