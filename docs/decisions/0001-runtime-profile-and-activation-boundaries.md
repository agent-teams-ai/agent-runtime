# ADR-0001: Runtime profile and activation boundaries

Status: accepted for the architecture foundation

Date: 2026-07-26

ADR-0002 reconciles this ADR with the independently authored architecture
foundation documents. Where terminology or ownership differs, ADR-0002 is the
later normative decision.

ADR-0003 further refines target-specific cutoff, predecessor barriers,
business-effect identity ownership, and runtime-scope disposition. Where those
semantics differ, ADR-0003 is the later normative decision.

Implementation status: production runtime code has not started. The
architecture foundation is accepted, but production and multi-host readiness
remain explicitly unqualified. Evidence promotion is tracked in
`docs/architecture/evidence-traceability.md`; current qualification and open
gates are tracked in `docs/architecture/readiness.md`. Those documents do not
silently expand this ADR: only a rule named in this ADR or in the traceability
matrix's `Promoted architecture rule` column is normative.

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
`docs/spikes/runtime-profile-behavior.md`. Spike documents remain immutable
evidence references, not implementation specifications. The canonical index
is `docs/README.md`; evidence-to-rule links are maintained once in
`docs/architecture/evidence-traceability.md`.

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

### Deployment topology and extraction invariants

The initial topology is a strict modular control plane plus separately
provisioned hosting workers and provider processes. Runtime Configuration,
Runtime Security, Provider Access, and Agent Execution are the four v1 bounded
contexts in one control-plane deployable. Capacity is a typed application port
used by Agent Execution, not a fifth v1 bounded context. Agent runtimes do not
execute inside the control-plane process.

The modular monolith is a deployment choice, not permission to couple domains.
This topology and the following release-blocking rules are accepted
architecture invariants from the first production commit:

- each bounded context owns a separate package boundary with domain,
  application, ports, and adapters directed inward;
- each context owns its tables or schema namespace and migration stream even
  when contexts initially share one database server or SQLite file;
- cross-context SQL, ORM relations, repositories, aggregate mutation, and
  domain-entity imports are forbidden;
- every tenant-owned ID, lookup, repository key, command, event, artifact
  reference, cache/idempotency key, provider-state namespace, transcript, and
  output reference is tenant-scoped. Authentication and authorization establish
  that scope before owner data is returned; global lookup followed by
  authorization is forbidden. Physical content-addressed deduplication may
  share bytes internally but never grants a cross-tenant handle, visibility, or
  existence oracle;
- cross-context meaning crosses only versioned contracts. Commands are owned
  by the receiving context, integration events by the publishing context,
  queries by the read-model owner, and consumer projections by the consumer;
- a producing context persists its state and transactional outbox atomically;
  consumers use an idempotent inbox or equivalent command ledger;
- database, broker, process runner, `KeyProvider`, clock, ID generation, and
  artifact store remain focused ports rather than shared infrastructure
  services imported by domain code;
- contract tests cover every published command/event schema and adapter;
- CI enforces the dependency graph, public package exports, schema ownership,
  migration ownership, and forbidden cross-context imports.

The in-process command/event adapters must satisfy the same contracts later
used by RPC or a broker. Service-extraction constraints are accepted now;
service readiness is not claimed until implementation proves package and
schema boundaries, independent migrations, contract tests, and remote-adapter
failure behavior.

Published contracts use additive evolution by default, explicit schema
versions, consumer-first rollout, unknown-field tolerance where safe,
event upcasting, bounded version retirement, poison-message policy, and
expand/contract database migrations. A context extraction may change
transport, deployment, observability, and distributed-failure handling, but
must not move aggregate ownership. Each extraction still requires
version-skew, timeout, replay, ordering, migration, rollback, and
partial-failure conformance before deployment.

### Monotonic control time

Expiry, lease, TTL, retention, garbage-collection, and stale-generation
decisions never trust a timestamp supplied by a caller, provider adapter, or
event payload. Those values may be checked as assertions or retained as
observations, but authority comes from an injected monotonic control-time
capability restored from a durable, externally anchored high-water mark.

The mutable restore/advance capability is private to the startup and anchor
adapter. Domain and application consumers receive only a narrow, immutable
`MonotonicTimeView`; a resolver, verifier, allocator, gateway, or lifecycle
component cannot recover or mutate the underlying clock. Every time-sensitive
composition fails closed until the expected authority identity and high-water
generation are restored. Clock rollback, mismatched authority identity, stale
anchor, or restart without an anchor blocks new authority-bearing work.

This is a focused infrastructure port, not a shared Time aggregate, global
runtime-profile service, or fifth bounded context. Each context still owns the
meaning and lifecycle of its own expiry. Cross-context events can carry the
time that was observed, but never grant another context permission to advance
or override control time.

### Authority-state encapsulation

Authority-bearing aggregate state is private to its owning aggregate or
durable application process. Heads, lifecycle tombstones, leases, roots,
reservations, assignments, fences, and idempotency journals are not exposed as
mutable maps, records, ORM entities, or adapter DTOs. Read APIs return detached
immutable snapshots. Every mutation enters through an owner capability and an
expected-revision, expected-generation, or semantic-fingerprint check.

An exact replay returns the current authority meaning of the original command,
not an obsolete success word. Release, expiry, collection, or fencing marks the
related journal receipt terminal. A later replay may return historical
evidence, but it cannot recreate a root, lease, assignment, executable closure,
or dispatch/output authority. These encapsulation rules apply in the initial
in-process modular deployment exactly as they would across a remote service
boundary.

### Effective runtime composition and inheritance

There is no shared mutable `RuntimeProfile` aggregate or global profile
service. Agent Execution assembles an immutable effective activation view from
the owning contexts immediately before materialization:

- Runtime Configuration contributes a `ProfileRevision`, compiled plan,
  dependency closure, and explicit instruction-source intent;
- Runtime Security contributes workspace trust, capability grants, exact
  resource authorization, and instruction-source authorization;
- Provider Access contributes provider account, route, and credential
  generation references without exposing secret values;
- the Agent Execution-owned capacity binding contributes an opaque reservation
  receipt obtained through `ExecutionCapacityPort`;
- Agent Execution contributes the operation, session, binary revision,
  execution generation, budgets, custody fence, and materialization evidence.

This is a read model and signed launch input, not a new owner of those facts.
Each context-owned source remains owner-revisioned. The capacity binding has
its own reservation generation and expiry. Dispatch revalidates the complete
staleness vector.

The immutable `EffectiveActivationManifest` binds:

- every contributing owner revision and semantic digest;
- the resolved immutable profile bindings, Runtime Configuration-owned source
  precedence policy, source provenance, tombstones, and provider
  compiler/materializer revisions;
- the normalized environment projection, instruction snapshot, instruction
  composition policy, and target-platform canonicalizer revisions;
- provider account, route, credential-generation references, binary closure,
  workspace scope, budgets, required receipt set, reservation generation, and
  execution fence;
- target platform, worker boot identity, expiry, and canonicalization version.

It is a signed launch input and read model, never an aggregate or a second
source of truth. Its signature envelope binds the launch-authority key ID,
algorithm, signer revision, issued-at time, expiry, manifest digest, target
host and boot identity, and a single-use activation nonce. The worker verifies
the signature, trust-anchor revision, expiry, host binding, and replay state
before materialization. Production key custody and trust-anchor qualification
remain separate deployment gates.

The nonce is owned by the Agent Execution `LaunchTicketLedger`, not by the
worker or provider adapter. Before materialization, the worker atomically
consumes it through a compare-and-set operation bound to manifest digest,
target host and boot identity, worker identity, a unique
`MaterializationAttemptId`, preallocated host identity, execution generation,
and fence. Ticket state is:

```text
issued
-> consumed(materializationAttemptId)
-> materializing(materializationAttemptId, custodyFence)
-> spent

any ambiguous state -> reconcile_required
conflicting claimant -> replayed
```

Consumption establishes the only eligible claimant but is not executable
launch authority. That claimant must win a second affected-row-checked CAS to
`materializing`, bound to its current worker-custody lease and preallocated
host/spawn identity. Only that state transition grants the one-time start
claim. Exact duplicate consume or start requests return observation status,
not another executable claim. A conflicting replay fails closed. An unknown
commit is reconciled through ticket state, custody fence, and the preallocated
host/process identity; it is never resolved by spawning or materializing
again. This prevents both read-before-write races and duplicate execution by
identical retries.

Environment inheritance is default-deny. A provider materializer receives only
an allowlisted, typed `EnvironmentProjection`. Each entry binds a normalized
key, value type, source and precedence, target-provider meaning, and exactly
one of:

- immutable inline non-secret bytes plus digest and length;
- an immutable content-addressed non-secret value reference plus digest,
  length, and media type;
- an opaque credential binding plus expected credential generation.

The materializer can resolve referenced non-secret values only through an
`EnvironmentValuePort` that returns owned bytes from immutable storage. It
verifies digest and length immediately before exec. That port has no ambient
host-environment or arbitrary-filesystem lookup operation. Secret values are
injected only during final materialization through opaque Provider Access
bindings and never become profile bytes, manifest bytes, logs, or events.

`TargetPlatformCanonicalizer` maps semantic environment keys and materialized
paths to the exact provider, OS, filesystem, and environment namespace before
collision detection. Its revision is pinned in the manifest. Case folding,
Unicode normalization, Windows environment-key aliases such as `PATH`/`Path`,
device names, ADS, and trailing-dot behavior are target rules. Any many-to-one
mapping, ambiguous normalization, duplicate-at-equal-precedence, unknown key,
or unclassified entry fails closed before materialization.

Profile composition resolves `absent`, tombstone, disable, remove, and full
upsert semantics before authorization. A pinned session never re-reads ambient
environment, provider config, instructions, skills, hooks, MCP definitions, or
workspace settings. Any accepted change creates a new manifest and activation
generation.

Workspace instruction inheritance is also explicit. The authorized policy is
either `none` or an immutable collected instruction snapshot with provenance,
digest, size limit, and target provider semantics. Cwd, a provider session ID,
and the presence of ambient `AGENTS.md` or `CLAUDE.md` never grant inheritance
authority.

Instruction composition is a separate typed algebra, not string
concatenation:

```text
instruction:
  absent
  | append(snapshotRef)
  | replace(snapshotRef)
  | reset-to-provider-default
  | disable
```

Operations use the Runtime Configuration-owned source order defined below.
`append` preserves ordered snapshot boundaries and provenance. `replace`
suppresses all lower authored instruction snapshots and starts a new sequence.
`reset-to-provider-default` suppresses authored snapshots and exposes only a
pinned, classified, authorized provider default, or an empty sequence when no
such default exists. `disable` is a suppressing tombstone until a higher
`append` or `replace`. There is no content-based implicit deduplication:
repeating the same operation identity and digest is idempotent, while the same
identity with different bytes is a hard conflict. Per-snapshot and composed
byte/token budgets are checked before review and again before dispatch. The
manifest binds the ordered snapshot identities, digests, provenance,
tombstones, provider mapping, and `InstructionCompositionPolicy` revision.

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

Runtime Security also owns exact egress authorization. A signed
`EgressAuthorization` binds tenant, route, normalized destination, resolved
address set, TLS identity, observed peer, redirect hop, policy/key generation,
budgets, expiry, and monotonic-time authority. The enforcing gateway is a
narrow Runtime Security port with a platform/transport adapter. It revalidates
at the final dispatch boundary before request/application bytes and on every
redirect; profile environment and an attached network never grant egress.

Bound transports are authority-bearing adapter state. Rotation, revocation,
expiry, peer mismatch, or failed revalidation removes the transport from the
pool. Failed closure quarantines it for retry; it cannot return to reuse. This
gateway is not a new bounded context, and policy ownership does not move into
Agent Execution or Runtime Configuration.

### Provider Access

Provider Access owns provider identity, authentication, and route semantics.

Aggregate roots:

- `ProviderAccount`;
- `CredentialBinding`, which owns the monotonic generation sequence, current
  generation pointer, refresh/revocation state, and affected-row-checked
  generation CAS;
- `ProviderRouteBinding`.

`CredentialGeneration` is an immutable entity/version inside the
`CredentialBinding` aggregate. It cannot be independently advanced, revoked,
or published through a separate repository.

Credential refresh, revocation, generation CAS, provider-written auth state,
and route/account changes have a lifecycle independent from profiles and
process custody.

Concrete secrets never enter profile revisions, public setup projections,
logs, event payloads, artifact identity, or exported profile bundles.

### Agent Execution

Agent Execution owns technical activation and provider execution.

Domain identities and aggregate roots:

- `RuntimeSession`: logical managed agent session;
- `SessionExecutionAuthority`: the single strong-consistency boundary for the
  active session slot, current generation authority, cutoff revision, and
  canonical-output acceptance fence;
- `ProviderHostInstance`: provider host identity plus process boot identity;
- `RuntimeOperation`: durable unit of requested runtime work;
- effect-ledger entry rooted at `(TenantId, EffectId)`.

`ExecutionGeneration` is an entity and immutable historical record activated
or retired only by `SessionExecutionAuthority`.

Durable process managers and application state:

- `RuntimeActivationProcess`;
- `ExecutionReconciliationProcess`;
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

Agent Execution is one bounded context and deployable in v1, but it is not one
god-module. Its application layer has five enforced internal module boundaries:

- Session and Operation Lifecycle;
- Activation Process;
- Host Custody;
- Invocation and Effect Ledger;
- Transcript and Output Publication.

These modules communicate through narrow application contracts and immutable
IDs. They do not share mutable domain entities or import adapter DTOs. An
internal module may later become an extraction candidate only after its
ownership and remote-failure contract are independently qualified.

## Capacity application port

Runtime Capacity is not a bounded context in v1.

`RuntimeActivationProcess` obtains an opaque, typed execution-resource
reservation through the Agent Execution-owned `ExecutionCapacityPort`.
Agent Execution owns the reservation request, local binding, admission
decision, execution fence, and reconciliation state. The capacity adapter or
external allocator owns resource-pool truth and the actual lease. Runtime
Security separately owns the authorized workspace and capability scope.

The port contract includes:

- idempotent `ReservationId` and semantic request fingerprint;
- typed resource vector, tenant and workload class, target constraints, and
  deadline;
- reservation generation/fence, expiry, heartbeat policy, and immutable
  allocator receipt;
- affected-row-checked claim or equivalent compare-and-set ownership;
- explicit `granted`, `queued`, `rejected`, `expired`, `released`, and
  `reconcile_required` outcomes;
- bounded queue and per-tenant admission limits, fairness policy, and
  observable overload/backpressure;
- crash-safe reclaim and idempotent release without granting execution or
  credential authority.

Claim, quota update, output append, reclaim acknowledgement, renewal, and
release are distinct commands. Each uses its own request identity and semantic
fingerprint; exact replay returns the original current-meaning receipt, while
identity conflict or missing identity fails closed. Quota shrink is
non-preemptive. `reclaim_pending` still consumes capacity until an exact stale-
host fencing acknowledgement or quarantine transition permits a successor
with a strictly newer fence.

Fairness and overload are explicit policies, not incidental database ordering.
Any finite-starvation guarantee names its assumptions, including a fixed
finite eligible tenant set, a persistently queued operation, and a finite older
eligible set. Strict priority without a bounded escape is not the default.
Capacity expiry, fairness and reclaim use the injected monotonic control-time
view, never caller timestamps.

The Agent Execution `CapacityLeaseMonitor` owns heartbeat and renewal for an
accepted reservation while its host remains live and fenced. Renewal uses
`ReservationId`, reservation generation, allocator fence, and expected expiry
in an allocator CAS; an ambiguous renewal never extends the local deadline.
The active capacity binding and expiry participate in dispatch, effect, and
canonical-output acceptance.

At expiry or a durable `lease_lost` observation, Agent Execution atomically
cuts off the affected `SessionExecutionAuthority` slot, rejects new dispatch,
effects, and canonical output, and emits containment plus
`reconcile_required` intents. Already dispatched effects are reconciled rather
than declared cancelled. An exclusive allocator slot moves through
`reclaim_pending` and is not re-granted until host fencing/containment is
acknowledged or platform enforcement proves the stale generation cannot use
it; otherwise the slot is quarantined with a typed reconciliation state.

Capacity lease, credential custody, workspace authorization, and execution
custody are different types and must never share a universal `Lease`
abstraction.

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

Runtime Configuration owns the normative `SourcePrecedencePolicy`:

```text
ProviderDefaultSource
< UserGlobalSource
< WorkspaceSource
< ExplicitSource
```

The orchestrator selects opaque bindings and may express relative overlay
intent only among bindings in the same source category. It cannot submit a
numeric cross-category precedence. Runtime Configuration derives and validates
the category rank, rejects duplicate or incomparable overlay positions, and
records the policy revision. A caller-supplied order can therefore never place
user-global or provider-default content above workspace or explicit content.

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
override. It translates them to opaque profile binding selections and
same-category relative overlay intent. AR never imports those orchestration
concepts and never accepts their ordering as source precedence.

Before review, Runtime Configuration resolves every selected mutable
`ProfileDefinition` head to a `ResolvedProfileBinding` containing an immutable
`ProfileRevisionId`, `auditRevisionDigest`, `effectiveSemanticDigest`, source
category, and validated same-category overlay position. Review,
authorization, preparation, and the activation manifest accept only resolved
bindings. A definition's mutable selected revision is UX state and cannot be
dereferenced during activation.

The generic composition vocabulary is:

```text
setting: absent | set(value) | reset-to-provider-default
resource: upsert(full definition) | disable | remove
```

`absent` is a no-op. `reset-to-provider-default` is an explicit tombstone.
`disable` preserves an existing full definition and may also suppress a
provider-default resource without inventing a fake definition. `remove`
removes only the definition authored at that overlay and reveals the next
lower state. It does not suppress a lower or provider-default resource.

Resource composition follows this truth table:

| Lower state | Higher `remove` | Higher `disable` | Higher `upsert(full)` |
| --- | --- | --- | --- |
| absent | absent | disabled tombstone | enabled full definition |
| enabled full/default | lower state remains visible | all lower/default definitions suppressed | higher full definition enabled |
| disabled tombstone | lower tombstone remains | higher tombstone | higher full definition explicitly re-enables |

`remove` is therefore an authored-definition deletion, while `disable` is the
only suppressing tombstone. A later full `upsert` explicitly re-adds or
re-enables the resource. Compilers must apply the same table to provider
defaults and prove omitted disabled resources are absent from executable
materialization.

Operations use a deterministic composite order key:

```text
sourceLayerRank
validatedSameCategoryOverlayPosition
sourceSnapshotId
sourceLocalSequence
operationId
```

`sourceLayerRank` is derived only from the pinned
`SourcePrecedencePolicy`; it is never caller supplied. An identical key with
different content fails closed. No global ordinal allocator or stable-sort tie
breaker is part of the contract.

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

Every provider extension classifier conforms to one versioned
`ProviderExtensionClassifierContract`. For each supported settings, hook, MCP,
plugin, skill, instruction, environment, or provider-native extension it
declares:

- source category, merge/reset/remove/disable semantics, and conflict rules;
- immutable artifact and executable dependency closure;
- environment and instruction projections;
- provider-neutral capability and typed resource-claim mapping;
- authorization class and authoritative-interception or broker strategy;
- materialization and fail-closed omission proof.

A provider is not substitutable for an effectful capability merely because it
can parse or display that extension. Missing fields, unknown extension
versions, or an unqualified interception strategy fail closed in conformance
and at activation.

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

Activation-process states are:

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
-> activated | blocked | reconciling | failed | cancelled
```

`activated` is the successful terminal of activation, not the terminal of the
runtime operation it started. `blocked` is terminal only for the current
activation attempt and carries a typed `RequiredDecision` or hard-reject
reason.

`RuntimeOperation` has a separate state algebra:

```text
requested
-> accepted
-> executing
-> completing
-> succeeded | failed | cancelled | outcome_indeterminate

any nonterminal state
-> reconcile_required
-> executing | completing | succeeded | failed | cancelled
   | outcome_indeterminate
```

`succeeded` requires the provider terminal observation, proven output-drain
barrier, every required business/effect receipt, and durable publication of
the canonical operation result. Provider success text, process exit, tool
status, `SubagentStop`, or transport completion is never sufficient alone.
`reconcile_required` is durable and nonterminal; it cannot be hidden by retry,
cleanup, or timeout. `failed` and `cancelled` are terminal only after every
possibly accepted command and effect has a verified disposition; otherwise
the operation remains `reconcile_required`.

`outcome_indeterminate` is a truthful terminal result for irreducible
uncertainty. It requires authority cutoff, canonical-output fencing,
containment assurance, exact closure receipts, and permanent no-retry
tombstones for unknown semantic effects. It never means that an effect failed
or did not occur. If execution or descendant containment is still uncertain,
the operation remains `reconcile_required`.

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

Every separately mediated external effect has an AR-owned `EffectId` allocated
before dispatch. A contained-unmediated turn has one coarse turn-level
`EffectId`; AR does not invent identities for invisible provider-internal
effects. `EffectId` identifies its semantic business effect across transport
attempts, controller failover, reconciliation, and successor execution
generations. It is unique within the tenant, is bound permanently to one
immutable semantic fingerprint and resource-claim set, and is never
regenerated merely because a fence or generation changes. Reconciliation of
the same possibly committed effect reuses the ID; a new intended effect
receives a new ID.

Each dispatch or recovery try has a distinct `EffectAttemptId` and `CommandId`
bound to the `EffectId`, authorization-decision digest, admission receipt,
generation, fence, and provider correlation data. The ledger enforces a unique
`(tenantId, EffectId)` claim. Reuse with a different semantic fingerprint is a
hard conflict that fails closed into reconciliation. At most one committed
outcome can be published. When a provider cannot accept or expose the
idempotency identity, acceptance uncertainty forbids retry until a
provider-specific reconciliation proves disposition.

A provider host and its dispatch claim are allocated under a database
uniqueness constraint for the owning operation and execution generation before
process spawn. Concurrent controllers use an affected-row-checked claim CAS. A
losing controller reconciles the canonical claim; it never spawns another
host.

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

Authority cutoff is one transaction on the `SessionExecutionAuthority`
aggregate. It records the revocation reference, closes the active slot,
advances the cutoff revision and canonical-output fence, and appends the
outbox/control event atomically. It does not mutate the separate
`ExecutionGeneration`, `RuntimeOperation`, or `ProviderHostInstance`
aggregates in that transaction.

Generation fencing, provider containment, operation reconciliation, and
technical cleanup react idempotently to the committed cutoff. They may finish
later, but stale canonical output is rejected immediately against the
authority aggregate. A replacement secret or private fence belongs only to an
explicitly authorized successor generation and is never rotated in a
filesystem step before the cutoff transaction.

Canonical output append validates the `SessionExecutionAuthority` aggregate's
active generation, slot, pinned credential-generation reference, execution
custody and capacity-binding references, private fence, cutoff revision, and
applicable expiries in one Agent Execution transaction. It does not query or
mutate another bounded context. Output arriving after authority cutoff or
capacity expiry is rejected even when process stop and recovery have not run
yet.

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

For OpenCode, one host also has one serialized prompt lane per session. AR
validates the owning tenant, runtime session, workspace grant, and active
operation before forwarding `load`, `resume`, `prompt`, `cancel`, or `close`;
OpenCode `cwd`, project filtering, and possession of a session ID are not
authorization evidence.

The same rule applies to Codex and Claude. A scoped macOS probe resumed a
Codex thread by explicit ID from a different synthetic workspace. Provider
session identity is therefore only an adapter routing hint. Agent Execution
authorizes every resume against tenant, runtime session, workspace grant,
credential generation, execution generation, and custody fence.

ACP terminal response and OpenCode SQLite are provider observations, not the
canonical output or operation receipt. Agent Execution owns provider-acceptance
projection, output drain, retry and wall-time budgets, late-output handling,
and incomplete-effect reconciliation.

Provider stop owns the full cgroup or equivalent descendant set. Killing the
OpenCode PID alone is insufficient. The Linux ACP adapter uses OS-selected
ephemeral ports (`--port 0`) unless an atomic leased-port adapter is separately
required and qualified.

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

### Provider adapter normalization and invocation authorization

Provider SDK hooks, ACP methods, tool names, session IDs, status enums, and
transport DTOs remain inside provider anti-corruption adapters. Runtime
Security and Agent Execution never depend on Claude `PreToolUse`, Codex
`turn/start`, OpenCode ACP updates, `subagent_type`, or provider tool-use
IDs as domain abstractions.

Runtime Security owns the provider-neutral
`InvocationAuthorizationPort.authorize(InvocationAuthorizationRequest)`
contract.

Agent Execution supplies an immutable trusted `InvocationScope` containing
tenant, runtime session, operation, execution generation, workspace, and
current authority references. The provider adapter receives that scope as
read-only application context but cannot create, normalize, or override it.
Provider payload fields that resemble owner IDs remain untrusted correlation
data.

The adapter produces only a `NormalizedProviderInvocation`:

- namespaced requested capability and immutable resource revision;
- typed provider-neutral resource claims and requested effect class;
- normalized semantic input digest over the request and resource claims;
- requested child-profile/resource reference when the invocation launches
  another agent;
- provider observation/correlation data that carries no authority.

The application service combines the trusted `InvocationScope` and
`NormalizedProviderInvocation` into an `InvocationAuthorizationRequest`.
Inbound decoding rejects any attempt by adapter or provider payload to replace
scope fields.

Typed resource claims expose the policy-relevant semantics rather than hiding
them behind a digest. Applicable claim families include canonical filesystem
scope and operation class, normalized network destination and route class,
process/executable and command class, child-profile reference, and
credential/resource binding. Unknown or lossily normalized resource semantics
fail closed.

The adapter cannot supply authorization revision, expiry, provenance, grants,
or trust. The Runtime Security application service resolves those owner facts
into an internal `InvocationAuthorizationContext` and evaluates policy through
domain services. This context never crosses the provider adapter boundary.

The result is an immutable `InvocationAuthorizationDecision` with an exact
allow or deny reason, authorized constraints, decision revision, expiry, and
audit identity and digest. Runtime Security records this decision at the
authorization boundary. Authorization evaluation is side-effect-free except
for its idempotent audit record. It does not own runtime budget consumption,
duplicate suppression, queueing, capacity, provider process custody, or effect
reconciliation.

Agent Execution separately owns
`ExecutionAdmissionPort.admit(AuthorizedInvocationAttempt)`. Agent Execution
creates one durable AR `InvocationAttemptId` for the observed invocation and
binds it to the request fingerprint and authorization-decision digest.
Admission validates operation state, child-launch count, semantic duplicate
key, runtime budgets, tool-host capacity binding, execution fence, deadline,
and cancellation state. It is idempotent by `InvocationAttemptId`: an exact
replay returns the same receipt without consuming budget or capacity twice;
the same ID with a different fingerprint is a hard conflict. An authorization
allow does not imply admission, and an admission receipt cannot expand
authorization. Both receipts are required before dispatch.

Queues do not preserve authority indefinitely. The admission receipt has its
own expiry and binds the exact authorization decision identity, digest,
constraints, request fingerprint, capacity generation, and execution fence.
Immediately before actual dispatch, Runtime Security revalidates the decision
identity and request digest and returns a short-lived
`AuthorizationDispatchToken` bound to its current revision and constraints.
Agent Execution then performs a local dispatch-claim CAS that validates that
token, decision and admission expiry, authorized constraints, current
`SessionExecutionAuthority` cutoff, operation state, cancellation state,
capacity generation, and fence. The two contexts do not share a transaction;
revocation's technical cutoff remains the `RevocationEnforced` protocol
defined above. An expired, revoked, stale, or constraint-mismatched attempt is
reauthorized and re-admitted or rejected; it is never dispatched from the old
queue receipt.

Turn admission and effect authorization are distinct. A provider adapter
publishes a versioned `AdapterCapabilityManifest` declaring, per effectful
path, one of:

```text
mediated_authoritative_interceptor
| mediated_ar_owned_broker
| contained_unmediated_effect
| unsupported
```

A mediated effectful capability is enabled only when its exact
provider/binary path has a qualified authoritative interceptor before provider
dispatch, or every effect is forced through an AR-owned broker/sandbox that
enforces the typed resource claims.

`contained_unmediated_effect` is a different, coarse-grained contract. It may
support a separately authorized turn only when the entire worst-case effect
scope is explicitly granted and enforced by containment. The turn receives
one coarse AR `EffectId` and a `ContainmentExecutionReceipt` bound to the
authorized scope, binary revision, containment policy, host custody, terminal
observation, and drain result. It never claims that provider-internal effects
were individually intercepted or receipted. Unsupported or unqualified paths
are omitted or disabled.

The capability manifest derives an immutable `RequiredReceiptSet` for the
activation manifest and operation terminal barrier. Mediated paths require
their individual effect receipts. A contained-unmediated path requires its
coarse containment receipt instead. A terminal transition cannot silently
weaken or substitute that set.

The Claude adapter installs exactly one AR-owned authoritative `PreToolUse`
interceptor for authorization and admission. The materializer does not install
other matching hooks into the provider's parallel pre-tool pipeline. Approved
user hooks run downstream of the successful claim as separate ledgered AR
operations in least-privilege workers and cannot call the admission port.
Pure observers consume the resulting AR event rather than racing the provider
hook. Codex turn admission before `turn/start` does not prove interception of
later model-generated shell, patch, or MCP effects. OpenCode ACP and native
tool paths are likewise qualified independently. No adapter claims equivalent
pre-dispatch semantics without revision-specific evidence.

Provider-specific allowlists remain adapter mappings. For example, Claude
`subagent_type` is mapped to an AR-owned child-profile/resource reference;
it is not a universal field. Provider prose, configured agent definitions,
available tool lists, annotations, and approval callbacks never grant
authority or admission.

### Normalized operation and effect contract

Provider messages are observations. AR normalizes them without pretending
different providers have equivalent terminal, cancellation, resume, or effect
semantics.

Agent Execution requires independent evidence for:

- provider acceptance;
- provider terminal observation;
- process/host custody outcome;
- output-drain completion;
- business/effect receipts;
- transcript/session publication when resumability is required.

Only `succeeded` and canonical successful-result publication require a proven
complete adapter-stream drain. Transport failure, drain timeout, cancellation
uncertainty, a malformed stream, or a stream that cannot prove completion
transitions durably to `reconcile_required` without claiming a drain barrier.
Provider success text, exit code, RPC completion, tool result, `SubagentStop`,
session load, or local transcript presence is insufficient for success.

Each effectful dispatch carries an AR-owned `OperationId`, `EffectId`,
`EffectAttemptId`, `CommandId`, semantic fingerprint, authorization decision,
admission receipt, and execution fence. Provider thread, turn, item, agent,
parent-tool, and tool-use IDs are correlation data, never authority or
idempotency keys.

The Invocation and Effect Ledger module durably records effect and attempt
claims, semantic fingerprint, resource claims, fence, committed outcome,
result publication, and reconciliation. A transport failure after dispatch
enters `reconcile_required`; it is never blindly retried. Successful terminal
publication waits for the output-drain barrier and all required effect
receipts.

### Child operations, tools, and transcripts

Every provider child agent is a separate AR `RuntimeOperation` bound to its
parent operation, child-profile authorization, admission receipt, execution
fence, budget, capacity binding, and cancellation state. Provider call count,
assistant-message grouping, background flags, and child stop events are
observations rather than concurrency controls or terminal receipts.

Each child has an explicit `ChildJoinPolicy`:

```text
joined | custody_transferred
```

`joined` is the default. Parent success requires every joined child to reach a
verified terminal state and contribute its required receipts to the parent's
terminal barrier.

`custody_transferred` is completed only by an Agent Execution-owned
`ChildCustodyTransferProcess`:

```text
offered -> accepted -> effective
        -> rejected | reconcile_required
```

The old owner retains capacity, cancellation, containment, and output custody
through `offered` and `accepted`. Acceptance proves the new owner's authority
and active capacity, cancellation, containment, and output-publication claims
and produces a short-lived `ChildCustodyAcceptanceToken`. The token binds the
identity, revision, fence, expiry, and semantic digest of every accepted claim,
the proposed new owner, child operation, expected old owner/fence, and proposed
new fence.

Immediately before handoff, those claims are revalidated. The `effective`
transition uses one affected-row-checked CAS on the child's current custody
owner and fence and accepts only a current, unexpired matching composite token.
That transaction advances the fence, installs the new owner, persists the
`ChildCustodyTransferReceipt`, and appends its outbox event. A stale,
expired, revoked, or mismatched token leaves the old owner in custody and moves
the transfer to re-acceptance or `reconcile_required`; it never installs the
new owner. Only after `effective` may the old owner release its claims.
Unknown commit is reconciled from the child's canonical owner and fence, never
by repeating a blind handoff.

The parent terminal barrier accepts only an `effective` transfer receipt,
which names the new owning session/operation, claims, authority revision,
generation, and fence. A provider background/detached flag is only an
observation and never transfers custody.

Parent cancellation fans out through AR-owned child-operation and tool-host
fences. Parent abort or provider-process exit does not prove an already
running handler, remote service, or detached descendant stopped. The Host
Custody module verifies the complete platform-specific containment boundary.

Effectful MCP tools and hooks execute only in separately provisioned
least-privilege workers or sidecars, never inside the modular control plane.
The worker process runner owns the complete descendant tree. Tool timeout,
hook signal, stdio closure, and process exit remain separate from the verified
effect receipt.

Claude stream state distinguishes `StopCurrent`, `CancelQueued`,
`StopAll`, and host termination. Codex same-thread turns are explicitly
serialized until the adapter proves another safe contract. OpenCode prompts
are serialized per provider session. These are adapter policies behind the
same provider-neutral operation port, not shared domain assumptions.

The external transcript adapter wraps opaque provider entries in
authenticated AR envelopes bound to tenant, logical placement, runtime
session, provider/binary revision, credential generation, and execution
generation. Append is idempotent by entry identity and has explicit ordering,
completeness, compare-and-set publication, subkey-tree support, and retention
capabilities. Local transcript durability, successful mirror publication, and
multi-host resume readiness are separate states.

Cross-revision resume requires a durable `TranscriptCompatibilityDecision`
with exactly one outcome:

```text
exact_compatible | migratable | read_only_inspectable | incompatible
```

Only `exact_compatible` resumes directly. `migratable` requires an explicit,
idempotent, audited codec migration that preserves the original envelope and
publishes a new derived revision. `read_only_inspectable` can support audit or
export but not provider resume. `incompatible` fails closed. Provider subkeys,
partial trees, unknown entries, and mixed codec revisions never trigger an
automatic best-effort resume.

Exact provider observations, tested revisions, counterexamples, and remaining
qualification scope are referenced in
`docs/architecture/evidence-traceability.md` and the underlying spike
documents.

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

OpenCode conformance observed a cold OAuth launch contacting npm registry
before the equivalent warm launch contacted only `chatgpt.com`. Required
OpenCode plugin bytes are therefore prepared and pinned before provider launch;
autoupdate and model-fetch disable flags do not prove hermetic startup.

The later immutable-container follow-up showed two more closure requirements.
OpenCode writes config metadata before it checks whether dependency installation
is needed, so deterministic images precreate the complete root-owned config
tree rather than granting it runtime write access. OpenCode also downloads its
declared ripgrep version when no compatible `rg` is present, so helper binaries
are part of `BinaryRevision`, not ambient host tooling.

A provider `BinaryRevision` therefore pins and attests the primary executable,
compatible helper executables, base image, config layout and modes, prepared
dependency metadata, capability-set/compiler revisions, adapter-contract
revision, invocation-normalization schema, interception-capability manifest,
provider-extension classifier contract, operation/effect projector,
terminal-semantics projector, and transcript/session codec revision. A newer
stable helper or adapter component does not mutate that closure. It creates a
new closure and passes its own compatibility and rollback qualification.

`BinaryRevision` identity is the digest of this complete immutable executable
closure, not a mutable alias, newest-version pointer, or rollout head. Runtime
Configuration may reference the closure and compatibility requirements, but
Agent Execution Host Custody owns registration, rollout head, compatible-worker
placement, assignment lease/root, drain, deprecation, rollback retention,
tombstone, and garbage collection.

A session pins one accepted closure ID for its lifetime. New assignment and
continuation are different decisions: drain may allow a pinned continuation
while denying new placement. Collection is blocked by the current head,
rollback retention, an active session lease, or assignment root. Release
atomically removes the assignment root/lease and terminalizes its command
journal; later exact replay returns inactive historical evidence and cannot
recreate executable authority. A collected tombstone cannot be resurrected by
registration replay or mutable artifact substitution.

Materialization contains only authorized executable bytes. A forbidden hook or
plugin is omitted from the final tree, not merely written with
`enabled=false`.

Workspace write access uses a dedicated `WorkspaceWriteLease` capability with
its own scope, writer identity, fence, expiry, renewal, release, and
reconciliation lifecycle. The orchestrator decides whether to allocate
another worktree or business execution environment; AR enforces the granted
filesystem scope and prevents unsafe concurrent writers.

## Persistence and event boundaries

Domain/application layers depend on semantic repositories and artifact-store
capabilities, not SQLite, PostgreSQL, Drizzle, filesystem CAS, or object-storage
types.

State transitions, application intent, and outbox records are persisted
atomically inside one bounded context. Blobs may be uploaded idempotently before
publication and garbage-collected later. Referenced artifacts are never
collected.

Database replication is durability/availability infrastructure, not execution
authority. Before promoting a standby, an external controller fences the old
writable process and every client route that could still reach it. The new
authority generation is durably advanced before accepting writes or output.
An unknown synchronous-commit result is reconciled through the original
command identity and fingerprint, never a blind new command. Rejoin or rewind
does not by itself prove the absence of split brain; production qualification
requires an external HA/fencing topology and its own failure campaign.

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
| `ResolvedProfileBinding` | immutable resolved value | Runtime Configuration |
| source and instruction composition policies | versioned domain policies | Runtime Configuration |
| `EnvironmentProjection` | immutable typed launch projection | Agent Execution |
| `EffectiveActivationManifest` | signed immutable read model | Agent Execution |
| launch ticket and nonce-consumption ledger | durable single-use launch claim | Agent Execution |
| `CapabilityGrantPolicy` | aggregate root | Runtime Security |
| `ResourceAuthorization` | aggregate root with exact expiry/revocation lifecycle | Runtime Security |
| `WorkspaceTrustDecision` | aggregate root | Runtime Security |
| `InvocationAuthorizationDecision` | immutable authority decision | Runtime Security |
| `EgressAuthorization` | signed immutable per-dispatch authority decision | Runtime Security |
| `CredentialBinding` | aggregate root | Provider Access |
| `CredentialGeneration` | immutable entity/version inside `CredentialBinding` | Provider Access |
| `RuntimeSession` | aggregate root | Agent Execution |
| `SessionExecutionAuthority` | aggregate root and output-authority consistency boundary | Agent Execution |
| `ExecutionGeneration` | entity and immutable history inside `SessionExecutionAuthority` | Agent Execution |
| `ProviderHostInstance` | aggregate root | Agent Execution |
| `BinaryRevision` | immutable complete executable closure identity | Agent Execution / Host Custody |
| binary rollout head and lifecycle registry | private aggregate/application state | Agent Execution / Host Custody |
| worker binary assignment root and lease | authority-bearing lifecycle state | Agent Execution / Host Custody |
| `RuntimeOperation` | aggregate root | Agent Execution |
| `EffectId` and effect ledger entry | durable semantic identity and aggregate root scoped by tenant | Agent Execution |
| execution admission and capacity binding | application decision/receipt | Agent Execution |
| `CapacityLeaseMonitor` | durable application process | Agent Execution |
| `WorkspaceWriteLease` | dedicated fenced application capability | Agent Execution |
| `ChildCustodyTransferReceipt` | immutable custody-transfer evidence | Agent Execution |
| `ChildCustodyTransferProcess` | durable process manager | Agent Execution |
| `RuntimeActivationProcess` | durable process manager | Agent Execution |
| `ExecutionReconciliationProcess` | durable owner-local process manager, not a source of truth | Agent Execution |
| recovery/revocation enforcement | durable process managers | Agent Execution |
| preparation/materialization receipts | technical evidence/read models | Agent Execution |

No folder or abstraction is created solely to imitate this table. A type is
introduced when it carries an invariant, lifecycle, or dependency boundary.

## Evidence promotion and readiness

Exact campaign facts remain in `docs/spikes/`. Their relationship to
normative architecture rules is maintained in
`docs/architecture/evidence-traceability.md`. Current qualification status,
platform scope, and open production gates are maintained in
`docs/architecture/readiness.md`.

Evidence never becomes a universal provider or platform claim automatically.
A promoted rule states the smallest provider-neutral invariant supported by
the observation. Provider-specific behavior remains in its anti-corruption
adapter. An untested platform, transport, credential route, binary revision,
or failure domain remains unqualified even when another adapter passed.

Production implementation may begin only for slices whose domain ownership is
settled here. Deployment readiness still requires the implementation,
contract, migration, containment, recovery, and revision-specific gates named
in the readiness document.

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
- physical microservice deployment before an extraction trigger and
  distributed-failure qualification; service-extraction constraints are
  immediate, service readiness is earned per context;
- handwritten Go/Rust SDKs;
- merged durable `session.events()` feed.

## Consequences

The model has more explicit lifecycle objects, but each one has one owner and
one reason to change. Profile editing stays independent from credentials and
security. Security decisions stay independent from provider process custody.
Execution can recover from crashes without pretending external actions are
transactional.

Provider adapters depend inward on provider-neutral authorization, admission,
operation, custody, transcript, and effect ports. Runtime Security and Agent
Execution never import provider hook or transport vocabulary. The five
internal Agent Execution modules localize reasons to change without forcing
premature physical services.

The first OpenCode slice requires more preparation than a single adapter, but
the resulting core can support Claude, Codex, ACP agents, non-ACP providers,
Desktop, hosted execution, and future SDKs without importing OpenCode semantics
into the domain.
