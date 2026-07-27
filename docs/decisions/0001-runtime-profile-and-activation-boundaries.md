# ADR-0001: Runtime profile and activation boundaries

Status: accepted for the architecture foundation

Date: 2026-07-26

Implementation status: production runtime code has not started. Stage A and
the scoped Stage B foundation spikes are complete after repeated adversarial
falsification and hardening. Runtime Configuration, Provider Access, and Agent
Execution foundation code may start. This is not a production-readiness claim:
provider authentication, production key custody, platform containment,
power-loss storage, and distributed deployment remain explicit gates.

## Context

Agent Runtime (AR) must make a user's existing Claude Code, Codex, OpenCode,
and future provider setup easy to reuse without making active sessions depend
on mutable ambient files. The same architecture must work in local Desktop,
CLI, hosted, embedded TypeScript, and future remote SDK modes.

Profiles can include executable or externally connected resources:

- MCP servers;
- hooks;
- plugins;
- skills with executable assets;
- commands, agents, formatters, LSP servers, and provider extensions;
- external binaries, package references, and files.

These resources are not ordinary settings. Discovery, compilation,
authorization, host preparation, process execution, and user review have
different owners and different consistency boundaries.

Provider processes cannot participate in a database transaction. Profile
activation also crosses several bounded contexts. Therefore neither a shared
Unit of Work nor one large preparation aggregate can make activation atomic.

This ADR supersedes architecture conclusions in
`docs/spikes/runtime-profile-behavior.md`. That document remains evidence only.
Stage A results and scoped uncertainties are recorded in
`docs/spikes/stage-a-profile-foundation-results.md`.
Stage B results, counterexamples, and remaining gates are recorded in
`docs/spikes/stage-b-runtime-execution-results.md`.

The experiment tree contains candidate implementations that intentionally
preserve historical behavior. Production code must not import or copy them.
Known superseded candidates include:

- authority drift that directly returns `retire-generation-and-restart`;
- profile composition whose identity includes grants and live security state;
- ordinary Node path traversal treated as secure artifact capture;
- AR-side team launch planning.

## Decision summary

AR is an event-driven modular monolith with Clean Architecture, Hexagonal
Architecture, strategic and tactical DDD, SOLID dependency direction, and
feature-owned vertical slices.

The canonical profile lifecycle is:

```text
authorized passive source ingestion
  -> ProfileRevision
  -> CompiledProfilePlan
  -> ReviewedRuntimeSetup
  -> ResourceAuthorization
  -> AuthorizedActivationSpec
  -> RuntimePreparationReceipt
  -> RuntimeActivation
  -> pinned RuntimeSession
```

The names describe different lifecycles. They must not be collapsed into a
single `PreparedRuntimeProfile` or `RuntimePreparationReceipt`.

## Bounded contexts

### Runtime Configuration

Runtime Configuration owns desired, portable, non-secret provider setup.

Aggregate roots:

- `ProfileDefinition`: named mutable profile with optimistic revision and a
  selected published revision;
- `ProfileRevision`: immutable provider-bound publication.

Immutable records and value objects:

- `ProfileSourceSnapshot`;
- `ProfileSourceLocation`;
- `ArtifactClosure`;
- `DependencyRequirements`;
- `CompiledProfilePlan`;
- resource provenance and normalized profile operations.

`ProfileRevision` does not contain:

- credentials or credential generations;
- concrete provider routes or endpoints containing secrets;
- authority policy, grants, or workspace trust;
- capacity, process custody, or execution fences;
- a target host, provider process, or mutable runtime state;
- provider SDK, ACP, filesystem-layout, or transport DTOs.

`CompiledProfilePlan` is a provider/compiler/binary-specific projection of one
immutable revision. It contains requested resources, derived capabilities,
dependency requirements, compatibility requirements, and their classification.
It does not receive or embed policy, grants, credentials, concrete routes, or
workspace trust.

### Runtime Security

Runtime Security owns decisions about what may be read and executed.

Aggregate roots:

- `CapabilityGrantPolicy`: durable user or administrator consent expressed as
  origin, capability, workspace, and constraint rules;
- `ResourceAuthorization`: an exact, expiring decision for a compiled resource
  closure and dependency set;
- `WorkspaceTrustDecision`;
- revisioned authority-policy bindings.

Runtime Security also owns source-access authorization. An SDK caller cannot
ask AR to capture an arbitrary path merely because the path is syntactically
valid.

Source access and collected-byte provenance are separate:

- `SourceAccessAuthorization` permits a collector to read an exact tenant,
  source host, opaque root, source kind, and observation epoch;
- `CollectorBundleAttestation` binds the resulting manifest and closure
  digests to collector identity/version, platform, source host, observation
  epoch, target tenant, provenance, and canonicalization version.

Neither object participates in `ProfileSourceSnapshot` semantic identity.
Security evidence remains separately revisioned and revalidated.

Runtime Security does not stop provider processes. It records and publishes
authority decisions such as `AuthorityRevoked`. Agent Execution owns technical
enforcement.

`CapabilityGrantPolicy` improves UX without weakening enforcement. Every
activation still receives an exact `ResourceAuthorization` bound to concrete
resource digests, origin, dependency closure, capability scope, workspace,
expiry, and authorization revision.

### Provider Access

Provider Access owns provider identity, authentication, and route semantics.

Aggregate roots:

- `ProviderAccount`;
- `CredentialBinding`;
- `CredentialGeneration`;
- `ProviderRouteBinding`.

Credential refresh, revocation, generation CAS, provider-written auth state,
and route/account changes have a lifecycle independent from profiles and
process custody.

Concrete secrets never enter profile revisions, public setup projections,
logs, event payloads, artifact identity, or exported profile bundles.

### Agent Execution

Agent Execution owns technical activation and provider execution.

Domain identities and aggregate roots:

- `RuntimeSession`: logical managed agent session;
- `ExecutionGeneration`: one continuous execution-authority generation;
- `ProviderHostInstance`: provider host identity plus process boot identity;
- `RuntimeOperation`: durable unit of requested runtime work.

Durable process managers and application state:

- `RuntimeActivationProcess`;
- recovery and revocation-enforcement processes;
- provider bootstrap lifecycle;
- workspace-access and execution-resource reservations.

Technical evidence and projections:

- `RuntimePreparationReceipt`;
- `MaterializationAttestation`;
- `ReviewedRuntimeSetup`;
- activation and diagnostic read models.

Receipts and views are not authority-owning aggregates. A receipt references
the authoritative revisions and evidence; it does not absorb their invariants.

`RuntimePreparationReceipt` is host-bound, expiring technical evidence. It
references:

- the profile revision and compiled plan;
- the security authorization;
- provider account and route identity without secrets;
- dependency and target-environment attestations;
- provider binary, compiler, materializer, and capability-set revisions;
- the final authorized materialization digest and attestation coverage;
- expiry and the staleness vector needed before dispatch.

It never grants authority by itself. `RuntimeActivationProcess` revalidates the
referenced owners before dispatch.

Agent Execution owns:

- sandbox and workspace-access enforcement;
- provider host custody;
- private execution fences and public execution epochs;
- final provider materialization;
- provider dispatch, cancellation, reattach, and recovery;
- rejecting stale output and retaining redacted operational evidence.

### Runtime Capacity

Runtime Capacity is not a separate bounded context in v1.

`RuntimeActivationProcess` may obtain an opaque, typed execution-resource
reservation through an application port. Capacity lease, credential custody,
and execution custody are different types and must never share a universal
`Lease` abstraction.

Capacity becomes a bounded context only when scheduling, quotas, resource
pools, or allocation lifecycle evolve independently.

## Source ingestion and product modes

The user-facing modes are:

- `Latest local setup`;
- `Saved profile`;
- `Clean setup`.

`Latest local setup` means capture a new immutable source observation for a
new preparation. It never means that an active session reads live ambient
configuration.

The UI must name the source device or host, for example `Settings from this
Mac` or `Settings from worker-01`. `Local` alone is ambiguous for Desktop,
remote CLI, browser, and hosted execution.

Canonical source categories are:

- `UserGlobalSource`;
- `WorkspaceSource`;
- `ExplicitSource`;
- `ProviderDefaultSource`.

Managed policy is not a profile source. It belongs to Runtime Security.
Provider defaults are interpreted under a pinned provider binary and compiler.

For a low-friction first run, provider user-global configuration may be
selected by default. Workspace configuration is discovered and reviewed as a
separate source. Executable workspace resources are never silently promoted
to a reusable global profile.

`ambient_live` is not part of v1.

### Local and hosted ingestion

Local and hosted ingestion use different outbound adapters behind the same
application capability:

```text
Desktop
  -> isolated local collector
  -> CollectorBundleAttestation
  -> brokered encrypted immutable artifact upload

Hosted
  -> inert decode of strict manifest bytes
  -> content-addressed blob staging
  -> validate complete closure and attestation
  -> immutable artifact publication
```

A hosted AR process must not walk arbitrary tenant filesystem paths.
Archive extraction is outside the trusted hosted AR boundary. Inbound adapters
decode bytes to deeply frozen inert data before application/domain use; Proxy,
getter, class instance, duplicate-key JSON, malformed UTF-8, and similar
executable object graphs are rejected.

Blobs are written to an expiring staging namespace. Publication occurs only
after the entire closure validates. Failure leaves no reachable partial
publication and records a typed garbage-collection intent.

Before authorization, ingestion is passive:

- no provider-native inspector;
- no plugin, hook, MCP, or provider startup;
- no model request;
- no credential injection;
- no provider-controlled or user-controlled network access;
- no dynamic package download.

Brokered transport to the configured artifact store is allowed through a
trusted outbound port. That port returns owned bytes, not arbitrary async
JavaScript objects.

Provider-native validation may run only after classification and authorization,
inside a constrained environment with the minimum required capabilities.

Logical path policy and target-platform materialization policy are separate.
Windows ADS/device-name/trailing-dot rules and macOS/Windows case and Unicode
behavior are platform concerns. A finite shared corpus is a regression suite,
not proof of full filesystem portability.

## Composition and provider extensibility

The orchestrator owns business scopes such as team, agent, task, and session
override. It translates them to an ordered list of opaque profile binding
references. AR never imports those orchestration concepts.

The generic composition vocabulary is:

```text
setting: absent | set(value) | reset-to-provider-default
resource: upsert(full definition) | disable | remove
```

`absent` is a no-op. `reset-to-provider-default` is an explicit tombstone.
`disable` preserves an existing full definition and may also suppress a
provider-default resource without inventing a fake definition. `remove`
erases the definition; a later full `upsert` explicitly re-adds and enables it.

Operations use a deterministic composite order key:

```text
bindingPrecedence
sourceSnapshotId
sourceLocalSequence
operationId
```

An identical key with different content fails closed. No global ordinal
allocator or stable-sort tie breaker is part of the contract.

Profile identity has two versioned digests:

- `auditRevisionDigest` covers the immutable authored operations and provenance;
- `effectiveSemanticDigest` covers the normalized effective provider setup.

Both identify their canonicalization version. Policy, grants, trust,
credentials, concrete routes, and authorization are excluded from both.
Cross-language canonicalization conformance is required before the contract is
published beyond TypeScript.

Provider-specific capability models are typed and namespaced. Closed core
unions such as `"claude" | "codex" | "opencode"` or
`"hook" | "mcp" | "plugin" | "skill"` are forbidden in extensible domain
contracts.

The provider boundary consists of small roles:

- `ProviderProfileCompiler`;
- `ProviderMaterializer`;
- `ProviderActivationAttestor`;
- `ProviderHostReusePolicy`;
- `ProviderStateBootstrapper`;
- provider capability descriptors and typed extension classifiers.

Adding an out-of-tree ACP or non-ACP provider must not require changes to the
Runtime Configuration domain. A trusted compiler must still classify the
security consequences of every provider extension. An unclassified executable
or externally connected capability fails closed.

ACP is a preferred provider-facing adapter, not an AR domain abstraction.
ACP v1 and ACP v2 use separate anti-corruption modules selected through
protocol negotiation and capability flags. OpenCode uses ACP for its primary
execution protocol and a broad typed native integration for capabilities not
represented faithfully by ACP.

## Review and freshness

User review and live enforcement are separate.

`ReviewedRuntimeSetup` contains stable, user-visible semantics:

- profile revision;
- provider and model;
- account identity without secrets;
- route, billing, and data-boundary semantics;
- requested tools and executable resources;
- workspace and requested access;
- effective setup provenance and semantic risk delta.

Its `ReviewFingerprint` excludes a concrete OAuth token or equivalent
credential refresh generation. It is computed from stable semantic IDs,
digests, and risk boundaries; display labels and presentation text are
excluded.

Transport input is strictly decoded to closed discriminated unions. Unknown
status, relation, field, or malformed structure fails closed before decision
evaluation and never appears raw in diagnostics.

Credential, route, capability-set, and target-host observations are atomic
consistency dimensions. Competing observations use monotonic owner revisions.
Different payloads at the same owner revision are ambiguous and hard-blocked;
they are not combined by field-level last-write-wins.

`ActivationPreconditions` are machine-enforced and may change without changing
the user's intended setup:

- profile and compiler revision;
- provider binary and capability-set revision;
- credential generation;
- concrete route revision;
- policy, trust, and resource-authorization revision;
- dependency attestation;
- target environment and host boot identity;
- materializer revision and materialization digest;
- execution-resource reservations and private fences.

Freshness rules:

| Change between review and start | Result |
| --- | --- |
| ambient preference drift | launch the exact reviewed revision if still available |
| equivalent credential refresh for the same account and route | rebind without review |
| account, billing route, data boundary, or provider identity change | `REVIEW_REQUIRED` |
| capability or permission expansion | `REVIEW_REQUIRED` |
| stricter policy | enforce automatically; reprepare or block if required |
| revoked credential, trust, grant, or authority | hard block |
| compatible host rematerialization with identical semantics | reprepare without review |
| binary/compiler/materializer change with semantic or risk delta | `REVIEW_REQUIRED` |
| unavailable or corrupt authoritative artifacts | `PROFILE_REVISION_UNAVAILABLE` |

There is no silent recapture, ambient fallback, or fallback to the newest
profile revision.

CLI and SDK use typed `RequiredDecision` values with reason, scope, expiry,
risk delta, and an idempotent resolution command. A boolean
`confirmationRequired` is insufficient.

## Activation consistency

`RuntimeActivationProcess` is an Agent Execution-owned durable process manager,
not a cross-context aggregate and not a shared transaction.

Candidate states are:

```text
requested
-> profile_compiled
-> reviewed
-> security_authorized
-> provider_access_reserved
-> execution_resources_reserved
-> materializing
-> attested
-> dispatching
-> running | blocked | reconciling | failed | cancelled
```

Every state transition follows:

```text
load state
-> validate revisions, expiry, and authority
-> persist state plus intent
-> commit
-> perform external action
-> persist outcome or ambiguous result
```

External provider, filesystem, network, NATS, or transport calls never execute
inside a database transaction. One transaction never crosses bounded contexts.
Retries are command-idempotent. Ambiguous provider acceptance is reconciled
before any retry.

Every external effect has a durable semantic effect identity. A provider host
and its dispatch claim are allocated under a database uniqueness constraint
for the owning operation and execution generation before process spawn.
Concurrent controllers use an affected-row-checked claim CAS. A losing
controller reconciles the canonical claim; it never spawns another host.

Process self-attestation is not the first durable identity. Recovery may begin
after the operating system child exists but before the guardian publishes its
PID or attestation. The preallocated host identity, spawn authority, process
boot evidence, and reconciliation protocol must converge that window without
blind retry.

A terminal or rejected operation always converges its command receipt. A
nonterminal operation or generation must retain an explicit reservation,
execution custody, or containment-required state. Cleanup is not allowed to
hide durable state-machine debt.

Temporal may later implement this process manager. It must replace the current
workflow-state implementation rather than become a second source of truth.

## Revocation and enforcement

Runtime Security records the decision. Agent Execution enforces it:

```text
AuthorityRevoked
-> RevocationRequested
-> ExecutionFenced
-> provider containment stopped
-> EffectsReconciliationRequired, when necessary
-> RevocationEnforced | EnforcementUncertain
```

The technical guarantee begins at `RevocationEnforced`, not at the instant a
policy document changes.

Authority cutoff is one Agent Execution transaction. It records the revocation,
marks the generation non-authoritative, fences execution custody, updates the
session slot, and appends the control event. It does not rotate a replacement
secret in a filesystem step before the transaction. A new private fence belongs
only to an explicitly authorized successor generation.

Canonical output append validates session authority, active generation and
slot, credential generation, execution custody, private fence, and applicable
expiry in one transaction. Output arriving after authority cutoff is rejected
even when process stop and revocation recovery have not run yet.

After authority cutoff:

- no new authorized operation or canonical output is accepted from the stale
  generation;
- late output is excluded from canonical feeds;
- redacted operational evidence is retained for diagnostics and audit;
- uncertain external effects are reconciled;
- a successor generation is never started automatically.

A successor requires an explicit operation, fresh authorization, and successful
activation precondition validation.

An external start can still land after authority cutoff because a provider
cannot join the state transaction. Such a stale effect is recorded and receives
an idempotent compensating stop. `RevocationEnforced` is persisted only after
guardian and provider death are proven by process identity plus boot identity,
or a typed `EnforcementUncertain` outcome is retained.

## Execution identity and recovery

The following identities are distinct:

```text
RuntimeSession
ExecutionGeneration
RuntimeOperation
ProviderHostInstance + bootIdentity
ProviderAccount
CredentialGeneration
```

`ProviderHostInstanceId` is not a PID. PID is diagnostic only.

Reattach stays in the same execution generation only when continuity of
authority, execution-custody identity, fence, provider binding, host instance,
and boot identity is proven. A process-manager controller may recover the same
durable generation under its existing authority. A new provider process,
execution-custody authority, private fence, incompatible binding revision, boot
identity, or unprovable provider continuity creates a successor generation.

`executionEpoch` is public, monotonic within a session, and diagnostic only.
It is never an authorization credential. Private fences protect
generation-authorized mutations and output append without blocking unrelated
control-plane changes.

The public API does not expose `ExecutionGenerationId`, private fences,
credential internals, provider process IDs, or dispatch records.

## Provider host lifecycle

V1 defaults:

- no cross-tenant host reuse;
- no cross-session host reuse;
- no cross-credential-generation reuse;
- reuse only inside the same `RuntimeSession` while custody continuity is
  proven;
- executable extensions cause the host to be destroyed or quarantined at the
  end of its allowed lifecycle;
- OpenCode mutable state uses a per-state-namespace single-flight bootstrap
  owner with lease, fencing, reconciliation, and quarantine.

Canonical host reuse revalidates the exact runtime session, credential
generation, custody fence, host state, PID, and process boot identity through
the real bootstrap path. A stopped, dead, cross-session, stale-generation, or
stale-custody host is never returned merely because its namespace matches.

Guardian and provider identities are tracked independently. Revocation and
cleanup must terminate and verify a surviving provider even when its guardian
has already died. A host is not marked stopped from intent alone.

Credential publication and deletion are both durable processes. Rejected,
unpublished, stale, and revoked ciphertext receives an idempotent garbage
collection intent and converges to processed or an explicit failure state.
Production encryption keys come from a `KeyProvider` capability; colocating a
file key with ciphertext is only a synthetic test adapter, never the production
design.

A future provider may enable broader reuse only after adapter conformance proves
complete reset and containment. A compatibility key is necessary but not
sufficient evidence of isolation.

## Artifacts and dependency modes

Artifact identity uses:

- opaque public IDs;
- tenant-scoped canonical digests;
- explicit canonicalization versions.

HMAC is used for semantic command fingerprints and idempotency conflict
detection, not as universal artifact or profile identity.

Dependency modes are:

- `hermetic`: all executable bytes are captured and verified;
- `host_bound`: external dependencies have exact provenance, digest, and
  launch-time attestation on a named target environment;
- `non_hermetic`: expert compatibility mode, deferred from v1 and normally
  prohibited in hosted execution.

Ambient `PATH` fallback, `package@latest`, runtime downloads, unpinned external
files, and silent package installation are forbidden in deterministic modes.

Materialization contains only authorized executable bytes. A forbidden hook or
plugin is omitted from the final tree, not merely written with
`enabled=false`.

Workspace write access uses a generic AR-owned lease. The orchestrator decides
whether to allocate another worktree or business execution environment; AR
enforces the granted filesystem scope and prevents unsafe concurrent writers.

## Persistence and event boundaries

Domain/application layers depend on semantic repositories and artifact-store
capabilities, not SQLite, PostgreSQL, Drizzle, filesystem CAS, or object-storage
types.

State transitions, application intent, and outbox records are persisted
atomically inside one bounded context. Blobs may be uploaded idempotently before
publication and garbage-collected later. Referenced artifacts are never
collected.

Domain events, cross-context integration events, and public runtime control
events are different types and schemas.

NATS JetStream is not part of AR v1. The orchestrator may translate AR runtime
events into its own integration events and publish those through its own NATS
adapters.

## AR and orchestrator boundary

The orchestrator owns:

- teams, roles, tasks, dependencies, assignments, and handoffs;
- team messages and product inbox policy;
- orchestration runs, execution plans, retries, compensation, and checkpoints;
- product approvals and eligible approvers;
- launch cohorts and partial or coordinated activation policy;
- worktree and board business policy.

AR owns:

- runtime profiles and provider-specific compilation;
- provider accounts, credentials, routes, and runtime access;
- provider processes, sessions, operations, execution generations, custody,
  fencing, cancellation, reattach, and recovery;
- runtime permissions, sandboxing, workspace enforcement, and output feeds.

`PreparedLaunch`, team launch atomicity, and `planTeamLaunch()` are not AR
domain concepts. The orchestrator stores opaque AR references and its own
observation projections.

The Runtime ACL in the orchestrator is stateless and implements narrow
consumer-owned capability ports. Protobuf, ConnectRPC, and public SDK schemas
are designed only after the domain and recovery transitions stabilize.

## DDD classification

| Concept | Classification | Owner |
| --- | --- | --- |
| `ProfileDefinition` | aggregate root | Runtime Configuration |
| `ProfileRevision` | immutable aggregate root | Runtime Configuration |
| `ProfileSourceSnapshot` | immutable record/value | Runtime Configuration |
| `ArtifactClosure` | value plus CAS references | Runtime Configuration |
| `CompiledProfilePlan` | immutable application/domain projection | Runtime Configuration |
| `CapabilityGrantPolicy` | aggregate root | Runtime Security |
| `ResourceAuthorization` | aggregate root or authority record with exact lifecycle | Runtime Security |
| `WorkspaceTrustDecision` | aggregate root | Runtime Security |
| `CredentialBinding` | aggregate root | Provider Access |
| `CredentialGeneration` | entity/version under credential lifecycle | Provider Access |
| `RuntimeSession` | aggregate root | Agent Execution |
| `ExecutionGeneration` | aggregate root | Agent Execution |
| `ProviderHostInstance` | aggregate root | Agent Execution |
| `RuntimeOperation` | aggregate root | Agent Execution |
| `RuntimeActivationProcess` | durable process manager | Agent Execution |
| recovery/revocation enforcement | durable process managers | Agent Execution |
| preparation/materialization receipts | technical evidence/read models | Agent Execution |

No folder or abstraction is created solely to imitate this table. A type is
introduced when it carries an invariant, lifecycle, or dependency boundary.

## Required spikes and gates

### Stage A: completed foundation evidence

1. **Composition algebra and out-of-tree provider**
   - exercise precedence, remove/re-add, reset, collision, provenance, and
     provider-specific typed extensions;
   - use one synthetic ACP and one synthetic non-ACP provider;
   - pass when no core enum or domain package changes for the new providers and
     every executable/connected extension is classified or rejected.

2. **Passive source ingestion and source authorization**
   - test malicious hooks/plugins, arbitrary paths, cross-tenant references,
     hostile archives, symlink/mount/path references, secrets, and oversized
     closures;
   - cover Desktop-to-host upload and hosted bundle ingestion;
   - pass when no provider/user code or network call runs, no credential enters
     the snapshot, and the hosted process never reads client source paths.

3. **Review and freshness matrix**
   - independently mutate preference, compiler, binary, credential, account,
     route, billing boundary, policy, trust, dependency, materializer, target
     host, and boot identity between review and activation;
   - pass when every case has exactly one typed result: launch, rebind,
     reprepare, review required, or hard reject.

Stage A completed with no failed hypothesis after adversarial hardening. Its
remaining partials are intentionally scoped:

- concurrent persisted ordering and cross-language canonicalization;
- correctness of real Claude, Codex, and OpenCode semantic classifiers;
- full NTFS/APFS path portability and secure platform-native Desktop collectors;
- universal secret detection, which is not achievable without provider-aware
  classification;
- durable artifact-store publication, key, backup, and garbage-collection
  behavior;
- real IPC/Connect parity and human usability.

These partials do not block the pure Runtime Configuration domain kernel.
They do block claims about production ingestion, provider conformance, public
cross-language contracts, or release readiness.

### Stage B: completed scoped execution foundation

4. **Activation crash, revocation, and execution fencing**
   - crash after every state commit and external call;
   - race start against revocation, takeover, cancellation, and late output;
   - pass when no stale dispatch starts after enforcement, no stale generation
     writes canonical output, retries are idempotent, orphan reservations are
     compensated, and ambiguous effects enter reconciliation.

   Completed on Linux with a synthetic provider and real controller subprocess
   crashes:

   - 46 of 46 scenarios passed;
   - 26 of 26 persisted crash points converged;
   - authority cutoff, late output, concurrent same-command handling, takeover,
     stale start compensation, terminal receipts, and custody debt were checked;
   - 909 producer and 760 independent verifier assertions passed in the final
     controller rerun.

5. **OpenCode bootstrap and credential lifecycle**
   - race first-use initialization, owner crash, lease expiry, and takeover;
   - exercise concurrent OAuth refresh, provider-written auth state, credential
     revocation, crash between refresh and publication, and reattach;
   - pass when one credential/state generation becomes canonical, stale secrets
     are never restored, and ambiguous state is quarantined or reconciled.

   The generic AR boundary and OpenCode process/bootstrap portion passed. The
   provider-auth portion remains intentionally partial:

   - actual OpenCode `1.18.5` completed ACP v1
     `initialize -> session/new -> session/close` over stdio;
   - host reuse, first-use single flight, exact spawn/reconcile windows,
     guardian-independent provider cleanup, credential CAS, revocation, and
     durable credential garbage collection passed;
   - 184 producer assertions and the independent pre-seal/post-seal verifier
     passed in the final controller rerun;
   - real OAuth refresh, provider-written credential import, and provider
     semantic equivalence were not tested and remain adapter conformance gates.

6. **Combined activation/OpenCode seam**
   - actual OpenCode process lifecycle was joined to durable runtime activation,
     execution fencing, explicit successor creation, and synthetic credential
     custody;
   - exact pre-self-attestation recovery and two-controller spawn races
     converged to one host and one provider;
   - a guardian-dead, provider-alive process was stopped through the same
     durable controller revocation path;
   - the final controller rerun passed 12 of 12 requirements with 133 producer,
     23 fault-evidence, 134 independent, and 420 sealed-evidence assertions.

Stage B is a `GO` for the scoped Linux, local stdio/ACP, SQLite-CAS foundation.
It does not prove release readiness or replace the gates below.

### Integration gates

- SDK/transport timeout after accepted command is reconciled by command ID
  without duplicate provider dispatch;
- exact runtime control/output cursor and replay conformance;
- real dedicated test credentials and routes, never user projects;
- OpenCode broad native-capability conformance plus ACP negotiation;
- binary/compiler upgrade and rollback with pinned active sessions;
- actual Desktop, CLI, embedded, and Connect parity;
- user testing for first run, stale review, missing dependencies, route change,
  and workspace write conflicts.

### Production platform gates

- Linux non-root containment against session escape and descendant survival;
- macOS process/filesystem/network containment;
- Windows Job Object plus filesystem/network containment;
- production `KeyProvider`, key rotation, crypto-erasure, and backup behavior;
- off-host signed evidence trust anchor;
- power-loss, disk-full, migration, backup/restore, PostgreSQL,
  and object-storage conformance;
- secure local collector distribution and target-host attestation.

## Deferred from v1

- `ambient_live`;
- cross-tenant or cross-session provider-host pooling;
- non-hermetic shell hooks and ambient dependency fallback;
- automatic dependency installation;
- cross-provider profile conversion;
- public profile marketplace;
- full ACP v2 behavior beyond negotiation boundaries;
- NATS inside AR;
- A2A coordination inside AR;
- microservice deployment of bounded contexts;
- handwritten Go/Rust SDKs;
- merged durable `session.events()` feed.

## Consequences

The model has more explicit lifecycle objects, but each one has one owner and
one reason to change. Profile editing stays independent from credentials and
security. Security decisions stay independent from provider process custody.
Execution can recover from crashes without pretending external actions are
transactional.

The first OpenCode slice requires more preparation than a single adapter, but
the resulting core can support Claude, Codex, ACP agents, non-ACP providers,
Desktop, hosted execution, and future SDKs without importing OpenCode semantics
into the domain.
