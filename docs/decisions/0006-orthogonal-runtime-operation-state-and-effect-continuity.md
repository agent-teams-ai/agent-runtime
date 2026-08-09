---
id: ADR-0006
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0006: Orthogonal runtime-operation state and effect continuity

Status: proposed for the first Agent Execution slice

Date: 2026-08-09

## Context

ADR-0001 through ADR-0004 define the accepted authority, cutoff, effect,
reconciliation, output, and terminal invariants. They intentionally do not fix
one implementation representation. Before the first Agent Execution slice, the
remaining representation choices must be explicit enough to prevent three
expensive mistakes:

- implementing `RuntimeOperation` as one lifecycle enum even though dispatch,
  output, containment, reconciliation, and terminal truth change independently;
- treating an effect ledger as owned by only one operation even when an
  authorized successor operation continues the same stable technical effect;
- implementing `TerminalRequirementSet` as an open policy bag without a single
  output and requirement closure boundary.

This decision refines internal Agent Execution semantics only. It does not
define Runtime Published Language names, Protobuf fields, an Orchestrator ACL,
runtime-scope provisioning, a technical grant, or a provider adapter.

## Decision

### RuntimeOperation is a product of orthogonal axes

`RuntimeOperation` does not store a mutable lifecycle mega-enum. It is created
only after durable command acceptance and contains these independent
authoritative dimensions:

```text
immutable identity and intent
OperationDispatchState
OperationAdmissionFence
OperationOutputFence
ProviderExecutionState
ProviderContainmentState
EffectResolutionSet
ReconciliationDebt
TerminalRequirementSet
TerminalResult
operationAuthorityRevision
aggregateRevision
```

Names in this ADR are internal domain vocabulary. They do not reserve public or
wire names.

Reasons, checkpoints, authority-vector components, and digest preimages are
closed typed values or references to immutable owner records. Arbitrary strings
and generic JSON policy bags are forbidden in authoritative state.

The operation dispatch axis is:

```text
unclaimed(nextAttemptOrdinal)
claimed(attemptOrdinal, claimIdentity, authorityVectorDigest)
acceptance_unknown(attemptOrdinal, evidenceRefs)
known_not_accepted(attemptOrdinal, evidenceReceipt)
provider_accepted(attemptOrdinal, evidenceReceipt)
```

Allowed transitions are:

```text
unclaimed -> claimed
claimed -> acceptance_unknown | known_not_accepted | provider_accepted
acceptance_unknown -> known_not_accepted | provider_accepted
known_not_accepted -> claimed(nextAttemptOrdinal)
```

A claim after `known_not_accepted` requires a new attempt identity, fresh
authority, the same immutable operation intent and fingerprint, preservation
of every registered `EffectId` mapping, and a current command receipt.
`provider_accepted` never becomes claimable again. Timeout, disconnect,
`not_found`, or absence from provider history cannot produce
`known_not_accepted`.

The two monotonic operation fences are:

```text
OperationAdmissionFence = open(revision) | fenced(revision, reason, receiptRef)
OperationOutputFence = open(revision) |
  fenced(revision, finalCursorVector, receiptRef)
```

Provider execution closure is independent from containment:

```text
ProviderExecutionState =
  not_started
  | active(dispatchAttemptOrdinal)
  | terminated(terminalExecutionReceiptRef)
```

`terminated` proves that the operation's provider execution has quiesced and
can no longer run, produce external effects, or produce canonical output. An
output fence alone cannot establish `terminated`. The receipt must bind the
operation, dispatch attempt, execution authority revision, provider identity,
and the observation or containment evidence that proves execution closure. It
does not assert a successful or failed business outcome.

Provider execution transitions are closed:

```text
not_started -> active(attemptOrdinal)
active(attemptOrdinal) -> not_started
active(attemptOrdinal) -> terminated(receiptRef)
```

The first transition is part of the same owner CAS as
`OperationDispatchState.unclaimed -> claimed` for that attempt; no
provider-executable side effect is authorized before it. Returning to
`not_started` is allowed only for the same attempt after authoritative
`known_not_accepted` evidence proves that no provider execution or external
effect started. `terminated` requires exact quiescence evidence and never
reopens. A containment receipt may contribute to the termination proof only
when it establishes this exact execution closure. `qualified_not_required`
satisfies only the containment axis; it never substitutes for
`ProviderExecutionState` closure. `uncertain` containment blocks terminal
commit.

The containment axis is:

```text
not_requested
pending(dispatchAttemptOrdinal)
contained(receiptRef)
uncertain(evidenceRefs)
qualified_not_required(capabilityRef, receiptRef)
```

`qualified_not_required` requires immutable technical capability evidence and
a receipt. Product policy cannot declare technically required containment
unnecessary.

Containment transitions are closed:

```text
not_requested -> pending
pending -> contained
pending -> uncertain
uncertain -> pending
uncertain -> contained
not_requested -> qualified_not_required
```

`uncertain -> pending` is an evidence-preserving retry. `uncertain -> contained`
requires late exact proof. `qualified_not_required` may be established only
with the qualified proof above, fenced operation admission and output, and no
active provider execution. `contained` and `qualified_not_required` are
terminal containment states and never reopen.

Effect resolution stores exact sets rather than a lossy status:

```text
unresolvedEffectIds
resolvedEffectIds
indeterminateEffectIds
resolutionDigest
```

Read models may project `pending`, `required`, `resolved`, or `indeterminate`,
but terminal policy checks the exact sets and digest. The sets are pairwise
disjoint and their union equals every effect registered in the sealed terminal
requirement manifest. Effect registration is open or closed only through that
manifest; it has no second closure flag.

Reconciliation is an overlay, not a lifecycle phase:

```text
clear
required(reconciliationEpoch, resumeCheckpoint, nonEmptyReasonSet,
  evidenceSetDigest)
```

Only an exact owner command with the current epoch, revision, and evidence can
clear reconciliation debt. Timeout, restart, a projection, or an operator
selected result cannot clear it.

Terminal truth is write-once:

```text
open
final(
  succeeded | failed | cancelled | outcome_indeterminate,
  resultDigest,
  requirementManifestDigest,
  satisfactionLedgerDigest,
  outputClosureDigest,
  effectResolutionDigest,
  terminalReceiptRef
)
```

The familiar lifecycle is only a derived view:

| Projection | Derivation |
| --- | --- |
| `accepted` | terminal open, requirement manifest open, no authority-started provider work |
| `executing` | terminal open, requirement manifest open, authority-started provider work exists |
| `completing` | terminal open, requirement manifest sealed |
| `terminal` | terminal final |
| `reconcile_required` | reconciliation debt required over any non-terminal projection |

A derived lifecycle value is never a mutation or CAS precondition.

### TerminalRequirementSet has a sealed manifest and satisfaction ledger

Acceptance creates an append-only `TerminalRequirementSet` pinned to exact
policy and capability revisions. Before any child, effect, containment,
transcript, or provider action, the operation transaction first reserves the
applicable typed requirement.

V1 requirement kinds are a closed discriminated union:

```text
provider_terminal_evidence
output_drain
effect_resolution(EffectId)
child_join(RuntimeOperationId)
child_handoff(RuntimeOperationId)
transcript_seal
cutoff_enforcement
provider_containment
indeterminate_closure
```

An outcome or qualified capability may prove that a kind does not apply, but
cannot add an arbitrary requirement name. Extending the union requires a new
domain decision and compatibility analysis.

The requirement set is:

```text
manifest:
  open(policyRevision, capabilityRevision, entries)
  | sealed(policyRevision, capabilityRevision, immutableEntries,
      sealRevision, manifestDigest)
satisfactionLedger:
  append_only(receiptEntries, satisfactionRevision, satisfactionDigest)
```

Requirement identity and membership become immutable at manifest seal. Later
receipts advance only the append-only satisfaction ledger. Terminal truth pins
both `manifestDigest` and the final `satisfactionDigest`.

One owner-local `EnsureTerminalBoundarySealed` command atomically:

1. blocks new operation dispatch and requirement registration;
2. fences operation admission if it is still open;
3. fences canonical operation output if it is still open;
4. establishes the terminal `operationAuthorityRevision`, or validates the
   revision already established by operation cutoff;
5. captures or reuses the final cursor for every applicable output channel;
6. seals the requirement manifest;
7. records the command receipt, audit entry, and outbox item.

It uses the stable scope, session, operation lock and CAS order from ADR-0003.
It performs no provider, network, process, or broker side effect. If an earlier
operation cutoff already fenced admission and output, the command validates
and reuses the existing monotonic fence receipt and final cursor vector. It
never reopens or advances the cursor a second time. Exact replay returns the
original boundary receipt; a conflicting fence or cursor precondition is
stale and enters reconciliation.

The linearization rule is exact:

- output committed first receives a sequence and is included in the final
  cursor vector;
- boundary seal committed first rejects the append before sequence allocation;
- requirement registration committed first appears in the sealed manifest;
- boundary seal committed first rejects the registration and any later
  dispatch that depended on it.

For success, seal requires an authoritative output-drain receipt. Failure,
cancellation, and indeterminate closure do not invent a drain; seal closes
canonical output and later provider bytes become bounded redacted evidence.

A terminal result may commit in the seal transaction when all requirements are
already satisfied, or in the transaction that records the final missing
receipt. Every terminal result requires:

- admission and output fenced;
- requirement manifest sealed and exact manifest coverage: every immutable
  entry has exactly one typed satisfaction receipt or typed non-applicability
  proof bound to its identity, policy revision, capability revision, and
  subject, with no conflicting, unknown, duplicate, or unbound receipt;
- provider execution proven `not_started` or `terminated`;
- every `cutoff_enforcement` entry satisfied by the exact cutoff or boundary
  receipt that established the required admission and output fences;
- every `provider_containment` entry satisfied by an exact `contained` receipt
  or immutable qualified-not-required capability evidence plus its receipt;
- reconciliation debt clear;
- current revisions and digests;
- outcome-specific requirements satisfied.

The satisfaction digest covers this exact manifest-to-proof mapping. A
registered child, transcript, effect, drain, cutoff, containment, provider, or
closure requirement cannot be ignored merely because an outcome table does
not repeat its kind.

Outcome-specific rules are:

| Outcome | Additional requirements |
| --- | --- |
| `succeeded` | authoritative success, proven drain, exact effect, child, and transcript receipts; every applicable registered containment entry satisfied; no indeterminate effect |
| `failed` | authoritative failure; every possibly accepted effect resolved or proven not performed; no indeterminate effect |
| `cancelled` | cutoff and cancellation evidence; every applicable registered containment entry satisfied; every possibly accepted effect resolved or proven not performed |
| `outcome_indeterminate` | cutoff; every applicable registered containment entry satisfied; permanent no-retry tombstone for every unresolved effect; atomic indeterminate-closure receipt |

An irreducibly indeterminate semantic effect forbids `failed` and `cancelled`.
The terminal truth is `outcome_indeterminate`.

### Effect identity survives authorized successor operations

The normative cardinality is:

```text
RuntimeOperation 1 -> 0..N referenced EffectIds
EffectId 1 -> exactly 1 originating RuntimeOperation
EffectId 1 -> 0..N EffectAttempts
EffectAttempt 1 -> exactly 1 attempting RuntimeOperation
EffectId 1 -> 0..1 externalEffectIdentityRef
externalEffectIdentityRef 1 -> exactly 1 EffectId within its stable namespace
```

Non-effectful operations reference no effects. A contained-unmediated turn
references one coarse effect. A mediated operation may reference multiple
effects.

`EffectId` remains the one AR technical identity for one intended effect.
Execution-generation replacement, retry, and an authorized successor
`RuntimeOperation` do not create a new `EffectId` for the same effect. The
effect ledger records `originatingOperationId`, each attempt's
`attemptingOperationId`, and append-only `EffectParticipation` links. Each
participation link is unique by effect and operation and contains the exact
authority receipt that allowed the successor to join.

After acceptance, the ADR-0002 phrase `owning operation` is interpreted as the
immutable originating operation. It does not forbid attempts by separately
authorized successor operations.

The effect-ledger state machine in ADR-0002 remains controlling. Registration
may exist with zero attempts when a cutoff wins before claim. Every attempt
retains its own `attempt_claimed`, `dispatching`, acceptance, evidence, and
disposition transitions. One proven `known_not_accepted` transition authorizes
at most one next attempt through a fresh affected-row CAS; a later independent
proof may authorize a later attempt.

An external identity claim is unique by:

```text
(TenantId, runtime scope, externalEffectIdentityRef)
  -> (EffectId, canonicalFingerprintVersion, immutableFingerprint)
```

Deployment incarnation and execution generation are current authority
preconditions, not part of stable deduplication identity. The uniqueness claim
holds only inside one authoritative runtime-scope namespace and its retained
retirement-root horizon. Restore, rebind, or deployment replacement may
continue that namespace only with a verified continuity receipt for the effect
ledger and retirement root. Without that proof, AR fails closed, marks the
binding for reconciliation, and does not dispatch; it does not claim
cross-deployment deduplication from an absent store.

Rules for successor participation are:

- same external identity and fingerprint returns the existing `EffectId`;
- same external identity with another fingerprint is a hard conflict;
- different external identities cannot alias one `EffectId`;
- equal payloads with different external identities remain distinct effects;
- a completed effect returns its canonical result without provider dispatch;
- each authoritative `known_not_accepted` receipt permits one fresh authorized
  attempt through an atomic claim;
- `accepted_pending_outcome` or `reconcile_required` effect-ledger state blocks
  another attempt;
- an indeterminate no-retry tombstone blocks another attempt permanently;
- cross-operation participation without a qualified stable external identity
  is forbidden;
- a successor link does not itself grant execution authority.

### Invariants and forbidden transitions

Every final terminal result implies fenced admission and output, a sealed
requirement manifest, a pinned satisfaction-ledger digest, clear reconciliation
debt, proven provider execution closure, applicable containment, and exact
outcome-specific effect closure.

For `outcome_indeterminate`, clearing reconciliation debt does not mean that an
unknown outcome became known. Each Effect ledger aggregate first commits its
permanent no-retry tombstone owner-locally and emits an exact tombstone receipt.
The operation-local transaction then consumes the complete expected receipt
set and atomically commits the transition to `clear`, the
indeterminate-closure receipt, satisfaction-ledger update, and terminal result.
There is no cross-aggregate transaction. Missing, duplicate, stale, or
scope-substituted tombstone receipts keep the operation non-terminal and in
reconciliation. The completed sequence proves that no active reconciliation
path can safely resolve or retry the effect.

These transitions are forbidden:

- creating `RuntimeOperation(requested)` before durable acceptance;
- storing a lifecycle mega-enum as authoritative state;
- reopening an operation fence or a sealed requirement manifest;
- registering a requirement or effect after terminal seal;
- appending canonical output after output fence or with a stale operation
  authority revision;
- terminalizing without exact output closure, a sealed requirement manifest,
  and a pinned satisfaction-ledger digest;
- succeeding without drain;
- failing or cancelling with an indeterminate semantic effect;
- attempting again from `accepted_pending_outcome`, `reconcile_required`, or
  an indeterminate no-retry tombstone;
- creating a new `EffectId` for an existing external identity claim;
- sharing an `EffectId` across operations without a qualified stable external
  identity;
- rewriting terminal truth because of late evidence;
- clearing reconciliation debt through timeout or a generic operator command;
- separating the accepted CAS seam with a check-then-act RPC;
- restoring or compacting state in a way that reopens a fence, requirement set,
  terminal result, or external-effect mapping.

## Required executable oracle

Acceptance of this ADR requires machine-readable fixtures for at least:

1. every output-append and terminal-seal commit order;
2. dispatch claim racing operation, session, and scope cutoff;
3. requirement reservation racing requirement-set closure;
4. final receipt racing duplicate terminal commands;
5. indeterminate sealing racing late authoritative-positive evidence;
6. crash after seal commit but before outbox publication;
7. crash after dispatch claim but before provider bytes;
8. provider acceptance before durable observation;
9. terminal commit with lost acknowledgement and exact replay;
10. two successor operations claiming the same external identity and
    fingerprint;
11. same external identity with a conflicting fingerprint;
12. different external identities with equal payload;
13. completed-effect replay with zero provider calls;
14. one fresh attempt after authoritative `known_not_accepted`;
15. permanent no-retry after restore and compaction;
16. operations with zero, one coarse, and multiple mediated effects;
17. delayed, reordered, duplicate, and conflicting receipts;
18. stale restore that attempts to reopen authority;
19. model-based generation across all axes and invariants.
20. cutoff before boundary seal, including exact reuse of its cursor and
    receipt;
21. normal provider termination without cutoff containment;
22. zero-attempt effect registration followed by cutoff;
23. receipt arrival after manifest seal and before terminal commit;
24. atomic indeterminate-debt clearing with permanent tombstones;
25. missing cross-deployment continuity proof and fail-closed dispatch.
26. a sealed child or transcript requirement missing from the satisfaction
    mapping, which must reject terminal commit;
27. every allowed and forbidden cross-axis transition among dispatch,
    provider execution, containment, cutoff, and terminal state.

The oracle uses deterministic synthetic models only. It does not run an agent,
provider, terminal runtime, MCP, or user project.

## Consequences

- the first implementation can remain an internal Agent Execution kernel;
- public contracts remain deferred until a separate Published Language ADR;
- terminal and effect correctness are testable before choosing a database or
  provider adapter;
- the model has more explicit value types but fewer invalid combined states;
- accepted ADR-0001 through ADR-0004 remain immutable; after acceptance this
  ADR becomes the controlling refinement for operation state, effect
  continuity, and terminal closure.

This ADR must be accepted before materializing the first Agent Execution
vertical slice. Acceptance authorizes that internal materialization only under
the executable oracle; it does not make the resulting slice
implementation-qualified or deployment-qualified by itself.
