# ADR-0002: Architecture reconciliation, tenancy, and operator recovery

Status: accepted for the architecture foundation

Date: 2026-07-29

Implementation status: no production slice is implementation qualified. This
ADR resolves conflicting foundation documents and defines implementation
boundaries. It does not qualify a provider, deployment, operator control, or
tenant-retirement workflow.

ADR-0003 later refines target-specific cutoff, predecessor barriers,
business-effect identity ownership, and runtime-scope disposition. Where those
semantics differ, ADR-0003 is the controlling refinement.

## Context

Two architecture lines were created independently:

- commit `542229c` added `docs/architecture/architecture-foundation.md`,
  `execution-generation-model.md`, `communication-boundaries.md`, and
  `opencode-integration.md`;
- sibling commit `4b9fad4` added ADR-0001 and the initial runtime-profile spike
  suite. ADR-0001 then evolved through later evidence campaigns.

The sibling commits had the same parent and were authored 44 seconds apart.
Neither superseded the other. They first appeared together after merge commit
`b86cd12`. The foundation documents contained valuable module, protocol,
observation, and quality-boundary decisions, but their five bounded contexts
and some execution semantics conflicted with the evidence-hardened ADR-0001.

This ADR reconciles the two lines. ADR-0001, ADR-0002, and their later accepted
refinements are normative. Supporting architecture documents are accepted only
as amended by those ADRs.

## Decision

### Four v1 bounded contexts

The v1 control plane has four bounded contexts:

1. Runtime Configuration;
2. Runtime Security;
3. Provider Access;
4. Agent Execution.

They remain separate packages and schema/migration owners inside one modular
control-plane deployable. Provider runtimes and hosted workers execute outside
that process. Cross-context SQL, ORM relations, aggregate mutation, and domain
entity imports remain forbidden.

The earlier foundation concepts are preserved as follows:

| Foundation concept | Accepted placement |
| --- | --- |
| `agent-execution` | Agent Execution bounded context |
| `provider-connectivity` | Provider Access bounded context |
| `runtime-interaction` | Agent Execution-owned request/elicitation workflow plus Runtime Security-owned authorization decision |
| `runtime-observation` | owner-published facts plus rebuildable read-only observation/operator projections |
| `runtime-environment` | application capabilities split across Runtime Configuration, Runtime Security, Provider Access, and Agent Execution |
| `runtime-capacity` | typed Agent Execution port until resource-pool truth gains an independently changing domain lifecycle |

`runtime-interaction`, `runtime-observation`, and `runtime-environment` remain
explicit feature/module vocabulary. They are not additional owners of domain
truth in v1.

Canonical output acceptance, sequencing, and terminal result publication stay
inside Agent Execution because they must atomically validate the current
session authority, cutoff, generation, and fence. A projection may index,
search, aggregate, or retain published observations, but it cannot decide or
rewrite an operation or effect outcome.

Observation storage ownership is explicit:

| Observation or artifact | Domain owner |
| --- | --- |
| profile/source artifacts and provenance | Runtime Configuration |
| operation artifacts, provider-process logs, runtime usage, canonical control/output feeds | Agent Execution |
| security and access audit facts | the context that made or enforced the decision |
| search, analytics, support, and Operator Case views | rebuildable projection only |

### Execution authority consistency boundary

`SessionExecutionAuthority` is the aggregate root for:

- the current execution slot;
- public execution epoch;
- private session execution fence;
- authority cutoff;
- activation and retirement of the current execution generation;
- canonical-output acceptance authority.

`ExecutionGeneration` is an authority-owned entity and immutable historical
record, not an independently mutable aggregate root. Its current identity and
transition are committed with the authority slot and fence. Historical rows
may be normalized and queried separately without loading all history into the
aggregate.

`ProviderHostInstance`, `RuntimeOperation`, and each semantic effect-ledger
entry remain separate aggregate roots because they have independent lifecycle,
concurrency, and failure boundaries. Durable application process managers
coordinate them through owner commands and events; they do not become a shared
aggregate or distributed transaction.

V1 does not reuse a provider host across tenants, runtime sessions, or
credential generations. A future sharing policy requires provider-, binary-,
platform-, and containment-specific qualification.

## Hosted tenancy

The following terms are distinct:

- `single-user`: one interactive human principal uses the deployment; service
  principals used by that deployment do not by themselves make it multi-user;
- `multi-user`: several authorized principals act inside one tenant;
- `single-tenant hosted`: one tenant has a dedicated control-plane/data/key
  boundary, even though the deployment is remote;
- `multi-tenant hosted`: unrelated tenants share some control-plane, database,
  artifact, or worker-fleet infrastructure while remaining logically and
  cryptographically isolated.

The domain model is tenant-scoped from the first implementation even if the
first hosted deployment is dedicated single-tenant. Deployment topology is
not permission to omit tenant identity from commands, repositories, events,
artifacts, caches, journals, provider state, transcripts, output, or logs.

An internal `TenantId` is opaque, globally unique, and never reused. A
re-onboarded external customer receives a new `TenantId`; an external product
account/customer identifier is a different identity. A separate
`TenantIncarnationId` is not introduced unless a future product requirement
must preserve one internal tenant handle across distinct incarnations.

A dedicated single-tenant beta may close access and decommission the entire
deployment, storage namespace, and key namespace. It may claim verified tenant
retirement only when a versioned inventory also covers backups, logs, external
provider state, worker residue, and keys. Shared multi-tenant deployment
additionally requires per-tenant isolation and disposition qualification
before release.

## Tenant retirement scope

AR is not the system of record for customer/account lifecycle, legal holds, or
compliance policy. The external platform or orchestrator owns that product
workflow. Each AR bounded context eventually participates through an
idempotent, context-owned disposition command and receipt; no AR context
deletes another context's tables or objects.

The full tenant-retirement feature is deferred. The first implementation must
preserve these one-way-door invariants:

- tenant-owned identifiers and storage handles are scoped by the never-reused
  `TenantId`;
- each table, object namespace, cache, journal, log, provider-state namespace,
  transcript, and output has an explicit owner and data class;
- released or retired authority cannot be recreated by event, inbox, command,
  cache, or backup replay;
- storage, artifact, provider, and key adapters do not prevent later
  owner-driven disposition or cryptographic erasure;
- public non-secret binary closures may be globally deduplicated, while a
  tenant handle must not expose another tenant or become an existence oracle.

Legal holds, export workflows, remote provider deletion, deletion
certificates, multi-region purge, backup expiration, and production
cryptographic erasure are not v1 domain-slice requirements. They become
release gates whenever any hosted product promises the corresponding lifecycle
or compliance behavior, whether its deployment is dedicated or shared.

## Reconciliation ownership

Reconciliation is required execution correctness, not an optional operator
feature.

Each bounded context owns reconciliation of its aggregates:

- Agent Execution owns operations, effects, authority, host custody,
  containment, output, and terminal barriers;
- Provider Access owns credential, account, route, refresh, revocation, and
  provider-account state reconciliation;
- Runtime Security owns authorization decisions and exceptional operator
  capability policy;
- Runtime Configuration exact-replays or reconciles an ambiguous publication
  of the existing intended revision. Corrective content creates a new revision
  instead of mutating an immutable published revision.

Each owning context has its own durable reconciliation process manager that
schedules probes and owner commands. Shared scheduling infrastructure may wake
those managers but does not own their workflow state or truth. A shared
Operator Case projection is rebuildable and read-only. It may show cases,
missing requirements, evidence summaries, source watermarks, and projection
lag, but it cannot write owner schemas or choose an outcome.

It carries only redacted summaries, opaque owner references, and digests,
never raw evidence, user content, secrets, private fences, or internal
generation identities.

No fifth Reconciliation or Operations bounded context is created.

## Execution reconciliation model

### Runtime operation

`RuntimeOperation` owns caller intent, immutable fingerprint, lifecycle, a
pinned `TerminalRequirementSet`, satisfied requirement references, and the
canonical terminal result.

```text
requested
-> accepted
-> executing
-> completing
-> succeeded | failed | cancelled | outcome_indeterminate

any nonterminal state
-> reconcile_required(resumePhase, reconciliationEpoch, reasons)
-> previous phase | terminal state
```

`reconcile_required` is durable and nonterminal. It represents active debt that
cannot be hidden by timeout, cleanup, or retry.

`outcome_indeterminate` is a truthful terminal result, not a synonym for
failure. It is allowed only when:

- execution authority is cut off;
- canonical output is fenced;
- every unknown semantic effect has a permanent no-retry tombstone;
- the provider/process is contained, or an independently qualified enforcement
  boundary proves that it can no longer produce externally observable effects;
  a local revocation intent or quarantine record alone is insufficient;
- all known terminal requirements have exact receipts;
- an `IndeterminateClosureReceipt` and canonical result are published
  atomically.

If the process may still perform effects, the operation remains
`reconcile_required` with containment uncertain. Later observations may append
audit evidence but cannot rewrite the terminal receipt, recreate authority, or
enable retry.

Terminal requirements are outcome-specific:

- success requires provider terminal success, proven output drain, exact
  required effect/child/containment/transcript receipts, and durable canonical
  result publication;
- failure requires a proven failure plus disposition of every possibly
  accepted effect and containment where required;
- cancellation requires cutoff, cancellation/containment evidence, and
  disposition of every possibly accepted effect;
- indeterminate requires cutoff, containment assurance, unknown-effect
  tombstones, and no-retry proof.

### Semantic effect ledger

An effect-ledger entry is an aggregate rooted at `(TenantId, EffectId)` and
owns:

- immutable semantic fingerprint and resource-claim digest;
- owning operation;
- `EffectAttempt` entities;
- acceptance and disposition;
- exact receipts and reconciliation history.

```text
registered
-> attempt_claimed
-> dispatching
-> accepted_pending_outcome | known_not_accepted | reconcile_required

known_not_accepted
-> attempt_claimed | not_performed

accepted_pending_outcome
-> completed | reconcile_required

reconcile_required
-> accepted_pending_outcome | known_not_accepted | completed
   | not_performed | outcome_indeterminate
```

The same intended effect across transport recovery, controller failover, or
execution-generation change always retains the same `EffectId`. A separate
caller intent receives a new `EffectId` even when its payload or semantic
fingerprint is identical. Each actual attempt receives a new
`EffectAttemptId` and `CommandId`; replay of one transport attempt reuses its
`CommandId`. A new attempt for the existing intended effect is permitted only
after evidence proves `known_not_accepted`. Conflicting fingerprints or
outcomes fail closed. Effectful cancel or cleanup receives its own semantic
effect identity. `not_performed` is allowed only when evidence proves that no
attempt was accepted.

The logical prohibition on retry or reuse of a retired `EffectId` is
irreversible. Its detailed physical journal is retained through the complete
retry, restore, and provider-replay horizon, after which it may be compacted
into an owner-signed retirement root that still rejects reuse. Removal of that
root is allowed only with retirement of the complete tenant namespace after
ingress and restore-resurrection paths are closed.

### Evidence and provider ports

Evidence is an immutable typed observation with:

- tenant, owner reconciliation ID/epoch, subject, operation, effect, attempt,
  adapter, binary, route, credential-generation, and execution-generation
  identities where relevant;
- source authority class and capability-manifest revision;
- request/response and raw-artifact digests;
- observed result and optional provider-supplied timestamps retained only as
  untrusted observations;
- AR `collectedAtControlTime` from the monotonic control-time view;
- signer and key generation where signed evidence is required.

Completeness/finality guarantees and retention horizons come from the pinned
adapter/binary capability manifest and evidence-policy revision, never from a
provider response or timestamp. `OperatorCaseId` belongs only to the
rebuildable projection and is not an owner evidence identity.

Provider adapters return observations, not business decisions. Narrow ports
include:

- `AcceptanceObservationProbe`;
- `EffectOutcomeObservationProbe`;
- `SessionContinuityObservationProbe`;
- `OutputDrainObservationProbe`;
- `ProcessCustodyObservationProbe`;
- `TranscriptPublicationObservationProbe`.

Closed observation outcomes include `found_exact`,
`not_found_with_scope`, `multiple_conflicting`, `unavailable`,
`unsupported`, and `malformed`. `not_found_with_scope`, timeout, an absent
provider ID, or expired provider history is not automatically
`known_not_accepted`.

Each adapter/binary pair publishes a
`ReconciliationCapabilityManifest`. A pinned `EvidencePolicyRevision` owned by
the target context evaluates observations as authoritative positive,
authoritative negative, non-authoritative, conflicting, or insufficient.

### Commands and transactions

Allowed owner commands are capability-specific, for example:

- `RequestEvidenceProbe`;
- `FenceExecution`;
- `RetryContainment`;
- `QuarantineResource`;
- `ApplyKnownCommittedEvidence`;
- `ApplyKnownNotAcceptedEvidence`;
- `AuthorizeSuccessorAttempt`;
- `SealIndeterminate`.

There is no `ForceSuccess`, `ForceFailed`, `ForceRetry`, generic
`SetOperationState`, direct operator SQL, tombstone reset, or weakening of the
pinned terminal requirement set.

Each owner command atomically persists:

```text
owner aggregate state
+ command journal/receipt
+ local audit record
+ transactional outbox
```

External probes or provider actions execute only after intent commit. Duplicate
schedulers and probes are safe. Resolution uses an owner revision,
reconciliation epoch, semantic fingerprint, and command identity. A response
lost after commit is recovered by exact replay of the same command. A changed
fingerprint is a security conflict.

Effect receipts reach `RuntimeOperation` through an idempotent inbox. The
operation first records the requirement receipt in its owner transaction. If
that receipt satisfies the final missing requirement, the same transaction
also publishes the terminal result and outbox event. The Operator Case
projection never participates in that transaction.

## Operator capability and break-glass

Normal operator reconciliation does not receive a desired outcome. It selects
or approves a system-generated typed proposal bound to the current owner
revision and evidence-set digest.

The owning context generates the proposal from its current aggregate,
reconciliation epoch, pinned capability manifest, evidence-policy revision,
and immutable evidence. The Operator Case projection exposes only an opaque
proposal reference and redacted summary. At command handling, the owner reloads
state and recomputes or verifies the evidence-set digest, policy, revision, and
allowed transition. Operator input cannot supply an outcome classification or
construct an `ApplyKnown*` proposal.

Runtime Security may issue a short-lived signed
`OperatorCommandCapability` bound to:

- tenant, owning context, exact target and action;
- command fingerprint and expected owner revision; Agent Execution actions
  additionally bind the public execution epoch and authority/cutoff revision;
- opaque owner proposal reference, evidence/proposal digest, and policy
  revision;
- actor, policy-required distinct approvers, reason, and incident reference;
- audience, expiry, single-use capability ID, issuer, and key generation.

The owning context verifies and consumes the capability in the same
transaction as the typed command, receipt, local audit record, and outbox.
There is no distributed transaction with Runtime Security.
Agent Execution revalidates its private current fence locally; the fence never
leaves its owner or appears in a capability, event, projection, or audit.
Audit records contain typed redacted metadata and digests, never secrets,
private execution fences, raw provider payloads, or user content.

Break-glass is a separate emergency channel and can only reduce authority:

- fence;
- revoke;
- stop;
- quarantine;
- disable admission.

Break-glass cannot authorize retry, restore authority, declare a business
outcome, delete a ledger/audit record, or reveal/export secrets. Recovery,
quarantine release, successor attempts, and semantic terminalization use the
normal control path and dual control.

If issuer trust, revocation state, authoritative control time, or durable
enforcement-point audit cannot be verified, AR refuses the manual command. An
out-of-band infrastructure stop may still reduce immediate risk, but AR
records it only as an observation; it does not prove containment or authorize
a terminal operation result.

The capability boundary and prohibitions are foundation requirements. JIT
issuance, operator UI, off-host immutable audit, offline hardware-backed
containment issuer, and drills are phased deployment gates.

## Implementation structure

The initial slices are:

```text
packages/contexts/agent-execution/src/features/
  runtime-operations/
  effect-ledger/
  execution-authority/
  host-custody/
  reconciliation-process/

packages/projections/operator-cases/
```

Domain code contains state, value objects, and policies. PostgreSQL, SQLite,
provider SDKs, clocks, artifact stores, KMS, identity, audit sinks, and
transports remain adapters behind narrow application ports.

Implementation order:

1. state/value contracts and model/property tests;
2. effect ledger, command journal, exact replay, and no-blind-retry;
3. operation terminal barrier and indeterminate closure;
4. authority, host, capacity, and containment reconciliation;
5. durable process manager and synthetic probe adapter;
6. rebuildable Operator Case projection;
7. one provider/binary-specific manifest, probes, and conformance row at a
   time.

## Qualification gates

Before implementation qualification:

- exhaustive state and forbidden-transition property tests;
- concurrent claim/CAS and kill-after-commit exact replay;
- duplicate, delayed, and reordered inbox/outbox;
- stale tenant, revision, generation, fence, cutoff, and capability;
- conflicting fingerprints and evidence;
- tenant, target, audience, proposal, and evidence-digest substitution;
- capability replay, expiry, key revocation, clock rollback, approver
  separation-of-duty failure, and audit-unavailable fail-close;
- one capability presented concurrently to partitioned writers;
- provider `not found` cannot become proof without a qualified policy;
- no terminal success without its exact requirement set;
- no indeterminate closure without cutoff, containment assurance, and
  permanent no-retry tombstones;
- GC/restore cannot resurrect command/effect identity;
- Operator Case projection rebuild is deterministic and projection lag cannot
  authorize a stale command.

Before hosted single-tenant:

- production repositories and migrations;
- real probes and manifests for every enabled provider/binary;
- operator API and normal JIT capability flow;
- off-host immutable audit;
- descendant containment and late-output rejection;
- lost-response and KMS/identity/audit-outage drills;
- minimal safe-direction break-glass.

Before hosted multi-tenant:

- tenant scope in every evidence, journal, projection, query, cache, artifact,
  output, and log path;
- no cross-tenant existence oracle;
- support-role redaction, RBAC plus resource/policy attributes, and dual
  control for high-risk recovery actions;
- cross-tenant substitution, leakage, queue-isolation, and fairness campaigns.

Before multi-host:

- independent external fencing of stale database, controller, worker, and
  client routes;
- asymmetric partition and stale-primary campaigns on physical hosts;
- globally consistent capability consumption;
- off-host audit recovery and restore/PITR/failover drills;
- qualified hardware-backed offline containment issuer if the operating model
  requires it.

## Consequences

- The useful observation, interaction, protocol, and package boundaries from
  the parallel foundation are retained without creating duplicate domain
  owners.
- Reconciliation remains close to the aggregate whose truth it protects.
- Operators receive one coherent view without a universal mutation service.
- Unknown external effects can terminate truthfully only after authority,
  containment, output, and no-retry obligations are closed.
- Early dedicated single-tenant hosting remains possible without weakening
  the tenant-scoped domain model.
- Full tenant retirement and advanced break-glass are deferred until their
  product or deployment triggers exist.
