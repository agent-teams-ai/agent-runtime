# Stage F authority, lease, effect, and custody results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage F tested the new Agent Execution contracts against real PostgreSQL
transactions and independent client-process races. It used a disposable
PostgreSQL 18.4 container with data checksums on and Read Committed isolation.
The campaign did not start a provider, make a provider request, read a user
project or ambient credential, or start an MCP server.

## Scope

The accepted v2 source covered:

- two-step launch-ticket consume/start claims;
- invocation admission and dispatch revalidation;
- capacity renewal, loss, output cutoff, reclaim, and explicit successor;
- semantic effect identity and acceptance uncertainty;
- child-custody acceptance and effective handoff;
- mediated versus contained-unmediated terminal receipt sets.

It ran on one physical Linux host. Client `SIGKILL` after a visible database
commit tested unknown response outcomes. It did not test PostgreSQL process
crash, replication, network partition, a real worker/provider process, native
platform containment, or production code.

## Superseded v1 model

The first calibration passed its own assertions but was not promoted. It
lacked unknown-response and live child-claim revocation cases, and its
experimental capacity grant could reopen output after lease loss without an
explicit successor execution generation.

V2 made generation and cutoff validation mandatory, added an explicit
`start_successor_generation` transition, and retained v1 as scoped historical
evidence. This counterexample confirms that capacity allocation alone must
never restore execution authority.

## Accepted facts

### Launch ticket

- 32 concurrent consumes produced one claimant and 31 status-only results.
- 16 conflicting claimants were classified as replay.
- 32 concurrent starts produced one start claim and 31 status-only results.
- After the start commit became visible, the client was killed with `SIGKILL`.
  Retry returned status-only with the same custody fence and did not grant a
  second start.

### Invocation authorization and admission

- 32 concurrent admissions produced one admission and 31 exact replays.
- The budget was charged once, from 100 to 97 units.
- Reusing the attempt identity with a different fingerprint failed closed.
- 16 concurrent dispatch claims produced one claim and 15 status-only
  results.
- Expired admission, revoked decision, and advanced session cutoff each
  rejected dispatch as stale or revoked.

### Capacity

- 24 concurrent renewal CAS operations produced one renewal and 23 stale
  results.
- A renewal committed before client `SIGKILL`; retry with the old expected
  expiry returned stale and did not extend the lease twice.
- Loss without expiry or allocator evidence returned `not_lost`.
- Durable lease loss advanced the authority cutoff, closed canonical output,
  and moved the slot to `reclaim_pending`.
- Old output was rejected and the slot could not be re-granted before
  containment acknowledgement.
- A capacity grant could not create a successor implicitly. After an explicit
  successor transition, the slot received generation 2/fence 2 and new output
  was accepted.

### Effect identity

- 24 concurrent claims for one tenant/effect produced one active claim and 23
  busy observations.
- Unknown acceptance entered `reconcile_required`; blind retry stayed blocked.
- Only `known_not_accepted` enabled a successor attempt.
- Commit survived execution-generation change as one semantic effect.
- Conflicting semantic fingerprint and result digest failed closed.
- The same opaque effect ID in another tenant had a separate identity scope.

### Child custody and terminal receipts

- Expired, revoked, and mismatched acceptance tokens left the old child owner
  and fence unchanged.
- 24 concurrent effective calls produced one handoff and 23 status-only
  observations.
- A handoff committed before client `SIGKILL`; retry observed the canonical
  new owner and did not transfer again.
- Mediated success remained blocked until both exact effect receipts existed.
- A fake effect receipt could not satisfy a contained-unmediated operation;
  its exact containment receipt was required.

## Repeatability and audit

The calibration and two final campaigns used the same frozen schema and
harness. Both finals passed the 46-of-46 read-only verifier. Their raw result
hashes differed, while their canonical facts shared digest:

```text
08ccbc0f4cc63369813ef3cbe4abb7ce39f2c94e1eda8972a268f4d6a8c01c58
```

Cleanup removed every Stage F container, volume, and network without touching
pre-existing Docker resources.

## Architecture consequence

The campaign supports the existing ADR boundaries; it does not add a bounded
context or move ownership:

- launch consumption and executable start claim are separate durable CAS
  transitions;
- queued authority, admission, capacity, and session cutoff are revalidated at
  dispatch;
- capacity loss closes authority and requires containment before reuse;
- a successor generation is explicit;
- semantic effect identity outlives attempts and execution generations;
- child custody is an atomic fenced handoff, not a receipt-only convention;
- terminal evidence is derived from the immutable capability-specific receipt
  set.

The schema and harness are experimental evidence only and must not be copied
into production repositories without implementation review.

## Evidence identity

```text
v2 schema
8506d2d95850fc57d393f3d92943b22271f99d681715fa691330601a76c48835

v2 harness
1050ba6d6e0bb12ff7ed502ddfaab8035dd569e4505e9d0ed3b519f5ca01a2be

read-only verifier
7f9ec3481ae35bb15a8bbdee9a6731a2558351efcfa60b890c3bca9a428faa5a

calibration result / audit
aa1041c01071c467200d8cccaa10ebbb6a0eef90902851a7e4a250a6a23b8c71
e918b6ab69e6d0e9efdf7d205df91f0e71c879a67afac75a7b19eb083fcff9cd

final A result / audit
a430d83aedda3a95844f6e5ddebdbd7ce221a230ec57cb63ab84c3c2e3389f72
33a75aaffb0f31cd90ef39f5b034dbf2b70c6d21d4124fa135635ea077eb1c81

final B result / audit
def35f6225345bc510d151e6493a1a6507a4d4a5c478990efdde204f361036f8
49fed8e858b65964bd6d58f5b79a8ab590e2221d1377409d0f4ae1a6e2a94ea8
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-f-authority-lease-custody-summary.json`.

## Remaining gates

- production aggregate/repository and migration implementation;
- real worker/provider process crash and containment;
- PostgreSQL delay, partition, replication, failover, and PITR;
- cross-host capacity and custody controllers;
- long-duration queue and lease soak;
- real provider interception and platform enforcement.
