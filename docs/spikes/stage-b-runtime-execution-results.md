# Stage B runtime execution results

Status: scoped foundation evidence

Date: 2026-07-27

This document records experimental evidence for ADR-0001. It is not a
production implementation or a substitute for provider, storage, transport,
and platform conformance.

## Safety boundary

All runs used synthetic workspaces, isolated HOME/XDG roots, synthetic
credentials, and the designated hosting worker. No user project, user
credential, model prompt, or provider inference request was used.

Actual OpenCode processes ran in a Linux network namespace with no default
route. OpenCode attempted metadata access, including `models.dev`; successful
external connections were blocked. ACP used stdio, not network loopback.

## Final controller runs

### Activation crash, revocation, and fencing

Run:

```text
2026-07-26T22-26-33-743Z-a421498a
```

Result:

- 46 of 46 scenarios passed;
- 909 producer assertions;
- 760 independent verifier assertions;
- 26 of 26 crash points converged;
- 5 start/revocation interleavings;
- 2 authority-cutoff windows;
- 1 two-controller same-command race;
- 6 negative self-falsification fixtures;
- no pre-cleanup receipt, operation, custody, dispatch, process, socket, or
  redaction debt.

The synthetic provider proved state-machine and external-effect semantics, not
ACP or OpenCode provider conformance.

### OpenCode bootstrap and credential lifecycle

Run:

```text
stage-b-opencode-credentials-2026-07-26T22-44-19.075Z
```

Result:

- 184 producer assertions;
- 18 hypotheses passed and 1 remained partial;
- actual OpenCode `1.18.5` completed ACP v1 initialize, two session
  lifecycles, and close without `session/prompt`;
- exact host reuse, bootstrap crashes, credential CAS, revocation recovery,
  guardian-dead/provider-alive cleanup, and durable credential GC passed;
- 32 GC intents processed, zero pending;
- only active canonical credential blobs remained; synthetic key material was
  deleted at teardown;
- independent pre-seal and post-seal verification passed;
- zero surviving processes, SQLite handles, or known secret canary leaks.

The partial is deliberate: real OAuth refresh and provider-written credential
import were not performed.

### Combined runtime/OpenCode seam

Run:

```text
stage-b-combined-v3-2026-07-26T23-39-31.274Z-f32c0c04
```

Result:

- 12 of 12 requirements passed;
- 133 producer assertions;
- 23 fault-evidence assertions;
- 134 independent verifier assertions;
- 420 sealed-evidence assertions;
- concurrent controllers converged to one durable host, guardian, and OpenCode
  process;
- recovery started while the guardian was held before self-attestation and
  reused the same process identity without duplicate spawn;
- a guardian-dead, provider-alive synthetic process was stopped through the
  durable controller revocation path;
- enforced state was persisted only after PID and boot-identity death proof;
- zero remaining credential ciphertext, synthetic keys, private fences, spawn
  nonces, processes, leases, database handles, or canary leaks.

## Falsified designs

The following designs failed during adversarial review and must not be copied:

- namespace-only provider-host reuse;
- spawning before a unique durable operation/generation host claim;
- ignoring CAS affected-row counts before process spawn;
- rotating a filesystem fence before revocation state commit;
- checking output authority without session revocation state;
- recovering only after a guardian has already self-attested;
- treating guardian death as proof of provider death;
- marking a host stopped from intent rather than process-identity proof;
- leaving terminal command receipts accepted without outcomes;
- allowing cleanup to hide nonterminal operation or custody debt;
- recording credential GC intents without a durable consumer;
- claiming zero network attempts when the network sandbox only proved zero
  successful connections;
- calling evidence independent when the verifier trusted producer summaries.

## Accepted invariants

1. Authority cutoff and canonical-output exclusion share one transactional
   consistency boundary.
2. External effects use durable semantic identities and reconcile before retry.
3. A stale external start is compensated exactly once after authority cutoff.
4. Host and dispatch identity are unique per operation and generation before
   spawn.
5. Concurrent controllers use affected-row-checked CAS; losers reconcile.
6. Runtime session, execution generation, operation, provider host identity,
   boot identity, public epoch, and private fence remain distinct.
7. Terminal operations converge command receipts. Nonterminal state retains
   explicit custody or containment-required evidence.
8. Provider and guardian liveness are verified independently.
9. Credential deletion is durable and idempotent, not best-effort cleanup.
10. ACP is a provider adapter. OpenCode-specific auth and native behavior remain
    provider conformance responsibilities.

## Remaining gates

The following were not proven and block broader release claims:

- real OAuth refresh, provider-written auth import, route/account semantic
  classification, and each supported OpenCode binary revision;
- production `KeyProvider`, KMS/HSM integration, key rotation, backup, and
  crypto-erasure policy;
- off-host signed evidence trust anchor;
- Linux cgroup/non-root containment and session-escape testing;
- macOS and Windows process, filesystem, and network containment;
- SQLite power-loss and disk-full behavior;
- PostgreSQL, distributed-host concurrency, remote transport, clock skew, and
  supervisor integration;
- public API cursor/replay, Connect transport, and SDK conformance;
- actual Desktop, CLI, embedded, and remote deployment parity.
