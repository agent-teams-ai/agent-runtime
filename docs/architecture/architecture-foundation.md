# Accepted Architecture Foundation

Status: accepted as amended by ADR-0001, ADR-0002, and ADR-0003

This document and ADR-0001 were created on parallel sibling branches. ADR-0002
reconciles their terminology and ownership. The module, dependency, API,
protocol, and quality rules below remain accepted; bounded-context and
execution-authority ownership follows the normative ADRs.

## Product boundary

Agent Runtime is a provider-neutral managed runtime for coding agents. It owns
safe technical execution and exposes narrow runtime capabilities to
orchestrators, desktop applications, CLIs, and other consumers.

Agent Runtime owns:

- runtime sessions and provider session bindings;
- runtime operations and technical dispatch records;
- process custody, cancellation, recovery, fencing, and reattachment;
- runtime permissions and elicitation requests;
- provider connectivity, credential custody, and managed profiles;
- installation, compatibility inspection, and runtime instances;
- durable control and output feeds, artifacts, logs, and usage observations;
- provider-neutral capability discovery and negotiation.

Agent Runtime never owns:

- teams, teammates, tasks, boards, inboxes, handoffs, or workflow routing;
- team prompts, role briefings, task retry policy, or visible-reply policy;
- product approvals, task attribution, review policy, or merge policy;
- NATS subjects, streams, consumers, or orchestration delivery policy;
- Temporal or LangGraph workflow semantics.

Consumers integrate through typed, consumer-owned ports and anti-corruption
layers. Agent Runtime publishes its own versioned runtime language and SDK.

## Architectural style

The system is a headless event-driven modular monolith using:

- Clean Architecture and Dependency Inversion;
- Hexagonal Architecture with narrow inbound and outbound capabilities;
- balanced strategic and tactical DDD;
- feature-owned vertical slices inside bounded contexts;
- SOLID modules and explicit composition roots;
- durable state transitions, outbox dispatch, and replayable observations.

DDD is used where runtime behavior has real invariants. Empty layers, marker
interfaces, generic repositories, and abstractions created only to satisfy a
folder template are prohibited.

## Initial bounded contexts

### `runtime-configuration`

Owns portable non-secret profile definitions, immutable revisions, source
capture, composition, compiled plans, provenance, and profile artifact roots.

### `runtime-security`

Owns capability and workspace-trust policies, source and invocation
authorization decisions, egress authorization, revocation decisions, and
exceptional operator-capability policy.

### `provider-access`

Owns provider accounts, credential references and generations, routes,
authentication flows, provider catalogs, and provider capability facts.

### `agent-execution`

Owns runtime sessions and operations, execution authority and generations,
provider hosts, technical dispatch and effect identity, custody, cancellation,
reattachment, recovery, canonical output, and terminal publication.

The earlier `runtime-interaction` concept remains an explicit collaboration:
Agent Execution owns permission/elicitation request lifecycle and technical
enforcement; Runtime Security owns the authorization decision.

The earlier `runtime-observation` concept remains a rebuildable read-only
projection and a set of owner-local publication modules. It may own query
schemas, indexes, retention, and presentation, but never operation/effect truth
or canonical-output acceptance.

The earlier `runtime-environment` concept remains application/adaptor
vocabulary split across profile compilation, authorization, credential
binding, host custody, compatibility, materialization, and workspace
enforcement. It is not a shared domain owner.

`runtime-capacity` remains a typed Agent Execution port. It becomes a bounded
context only when resource-pool truth, scheduling, quotas, or allocation
lifecycle evolve independently.

## Feature structure

The default structure is:

```text
packages/contexts/<context>/
  src/
    features/
      <capability>/
        contracts/
        domain/
        application/
          ports/
            inbound/
            outbound/
        adapters/
          inbound/
          outbound/
        composition/
        tests/
    composition/
    published-language/
```

A feature owns its aggregates, invariants, use cases, mappings, adapters,
persistence schema, migrations, and tests. Context-level composition may own
connections, pools, and lifecycle resources, but not feature behavior.

Folders that have no content are not created. A small feature may use fewer
layers while preserving the same dependency direction.

## Dependency rules

- Domain imports only domain code from the same bounded context.
- Application imports its domain and capability interfaces.
- Adapters depend inward on application contracts.
- Composition roots are the only modules allowed to wire concrete adapters.
- Bounded contexts communicate through published language, integration events,
  and anti-corruption layers.
- One bounded context never loads or mutates another context's aggregate
  through its repository.
- Domain, application, and public SDK code never import provider DTOs, ACP,
  MCP, A2A, NATS, ConnectRPC, database, ORM, Electron, or framework types.
- Public DTOs, SDK models, domain models, persistence models, and provider DTOs
  are separate types.
- Technology names belong in adapters and composition, not domain vocabulary.

Capability interfaces use concise capability names such as `Clock`,
`IdGenerator`, `RuntimeSessionLifecycle`, or `SecretStore`. The `Port` suffix
is optional and must not be added mechanically.

## Runtime identity and execution model

These identities are distinct:

- runtime installation and runtime instance;
- provider connection and credential generation;
- runtime session and provider session binding;
- session execution authority and execution generation;
- runtime operation, provider invocation reference, and operation dispatch
  record;
- permission request, elicitation request, artifact, and feed entry.

`RuntimeSession` owns logical session lifecycle and control-plane state.
`SessionExecutionAuthority` is a separate consistency boundary keyed by runtime
session identity. It owns the current `ExecutionSlot`, monotonic
`executionEpoch`, current `ExecutionGeneration`, execution custody, and private
session execution fence. This separation prevents execution fencing from
blocking independent session control-plane changes.

`ExecutionGeneration` represents one continuous period of execution authority
for a runtime session. It is not an operating-system process and is not a
retry. It references a provider runtime instance, provider session binding, and
its canonical predecessor where applicable.

`RuntimeOperation` represents one accepted caller intent, such as submitting
input for provider execution. It may survive a provider restart and span
multiple execution generations. A long-lived execution generation may process
multiple sequential runtime operations.

`ProviderHostInstance` identifies a managed process, daemon, or remote runtime
custody target using an AR instance identity and boot identity. PID is
diagnostic metadata only. The earlier `ProviderRuntimeInstance` name is not a
second identity or owner. `ProviderInvocationRef` is an optional opaque
provider run or turn identity.

`OperationDispatchRecord` records a technical attempt to perform an external
side effect. It is internal application/infrastructure state, not a domain
aggregate or Published Language term. Dispatch records do not create a second
business meaning for an operation.

There is no universal `ExecutionAttempt` aggregate.

Input acceptance, provider acceptance, execution activity, completion, and
observation are separate facts. A transport timeout never proves rejection.
Ambiguous outcomes are durable and require reconciliation rather than blind
retry.

State dimensions remain orthogonal where combining them would produce an
invalid mega-enum. Public `executionEpoch` is monotonic diagnostic information.
Private execution fences are enforcement credentials and never appear in
public events.

The detailed authority state diagram and transition invariants are defined in
[Execution generation model](execution-generation-model.md).

## Concurrency and external effects

- Each aggregate has one writer at a time through a per-context command lane.
- Command lanes perform only load, invariant validation, persistence, outbox
  append, and commit.
- Provider, network, NATS, filesystem, and process calls never run inside a
  database transaction or single-writer lane.
- External effects are invoked from durable dispatch intents after commit.
- Every state-changing command has an idempotency identity and a canonical
  semantic fingerprint.
- The same command ID with a different semantic payload is a conflict.
- Operation, permission, custody, credential, and installation concurrency use
  typed revisions and fences. There is no universal `Lease` or fence type.
- A stale process cannot append observations after custody has moved.

## Persistence

Persistence is behind semantic atomic-write capabilities. Application code
does not expose a generic ORM transaction or a repository bag.

Accepted direction:

- SQLite for local and desktop deployments;
- PostgreSQL for hosted deployments;
- Drizzle inside persistence adapters only;
- relational aggregate state as the operational source of truth;
- transactional outbox and durable command receipts;
- append-only control/output/audit records where replay is required;
- no event sourcing by default.

Each bounded context owns its tables, migrations, inbox, outbox, and
repositories. Transactions do not cross bounded contexts. Cross-context
consistency uses durable events and process managers.

The exact Drizzle version and local SQLite driver remain provisional until
implementation. They must be pinned and re-evaluated against the current
stable releases. ORM types and generated schemas must never escape an adapter.

## Feeds and events

- Domain events describe committed domain facts.
- Integration events are versioned published-language contracts.
- Provider events are external observations translated through an ACL.
- Control, output, logs, and artifacts have separate feeds, cursors, ordering,
  retention, and gap semantics.
- Sequence numbers are allocated atomically per feed. `MAX(sequence) + 1` is
  prohibited.
- Replay and live tail read from the same durable log. In-memory notifications
  may wake a reader but are never the source of truth.
- There is no global event ordering guarantee.
- Unknown provider variants are preserved as redacted raw artifact references
  rather than silently discarded.

NATS JetStream is not part of Agent Runtime v1. It belongs to orchestrator
inbound and outbound adapters. Agent Runtime's own public stream is durable and
resumable independently of NATS.

## Public API and SDK

Application inbound capabilities are the primary entry point. A handwritten
SDK is a consumer-facing adapter over parallel backends:

```text
RuntimeClient
  sessions
  operations
  observations
  interactions
  recovery
  providers
  environment
       |
  shared internal RuntimeChannel
       |
  Embedded backend or Connect backend
```

The planned cross-process published language uses Protobuf with Buf
compatibility checks and ConnectRPC transport. Domain modeling and recovery
semantics are completed before `.proto` contracts are frozen.

Only one evolving `v1` exists before the first stable public release. After
stabilization, breaking compatibility is controlled by SemVer, protocol
negotiation, capability negotiation, and blocking Buf checks.

The TypeScript SDK is first. Generated clients remain low-level; the
handwritten SDK provides idiomatic capabilities. Multi-language SDK generation
is enabled by the wire contract but deferred until needed.

## Provider and protocol adapters

- ACP is a first-class agent-facing protocol adapter, not the domain model.
- Provider-native protocols remain available for management, reconciliation,
  and capabilities ACP does not expose reliably.
- A provider integration implements narrow capabilities, never one broad
  adapter interface.
- One provider session binding has one command authority for each capability.
- Two protocols must never submit the same prompt, cancellation, or permission
  decision concurrently.
- Changing command authority requires a recovery barrier, a new binding
  revision, and resolution of in-flight ambiguous operations.
- A2A is a future consumer integration boundary outside Agent Runtime domain.
- MCP supplies tools and context; it is not a runtime management protocol.

## Security

- Security is enforced by code, sandboxing, scoped capabilities, and grants,
  never by a system prompt.
- Workspace trust is explicit and scoped to canonical workspace identity.
- Paths use canonical real paths and platform-aware case handling.
- Secrets are represented by references and generations. They never appear in
  domain events, logs, fingerprints, command receipts, or public DTOs.
- Runtime endpoints are authenticated, including localhost endpoints.
- Filesystem, terminal, MCP, attachment, and URL operations enforce scope,
  limits, redaction, and audit before side effects.
- Provider errors become a stable runtime error taxonomy with redacted
  diagnostics.
- Raw protocol passthrough is disabled by default.

## Legacy migration

The existing `777genius/ar`, orchestrator, and desktop OpenCode code are
behavioral donors and compatibility oracles, not the new core.

- Preserve valuable invariants, parsers, cross-platform algorithms, fixtures,
  and characterization scenarios.
- Adapt code only after assigning its correct owner and layer.
- Do not copy team, task, board, delivery, or orchestration semantics into
  Agent Runtime.
- Do not migrate active legacy sessions. The new runtime starts a new version
  with new sessions.
- Legacy compatibility is a temporary consumer-side migration scaffold, not a
  permanent runtime bounded context.

## Automated architecture and quality gates

CI must enforce:

- forbidden dependency directions and provider/framework imports;
- feature public entrypoints and bounded-context isolation;
- no cross-context repository access;
- no provider DTOs in domain, application, or public SDK;
- deterministic generation and migration checks;
- secret scanning and redaction fixtures;
- platform persistence conformance;
- bounded-context capability conformance;
- runtime published-language/API conformance;
- provider adapter conformance.

File-size defaults:

- domain and application: target 300 lines, hard limit 500;
- adapters: target 400 lines, hard limit 600;
- tests: hard limit 800;
- generated code and immutable migrations: excluded.

An exception requires a narrow architecture waiver with owner, reason, and
removal condition. A file-size waiver does not waive dependency rules.

## Deferred or open

The following are intentionally not fixed by this document:

- provider-specific recovery algorithms beyond the accepted execution
  generation transitions;
- command receipt retention periods and feed retention periods;
- exact Protobuf messages and Connect service layout;
- ACP v2 Draft schemas and unstable behavior;
- Temporal, LangGraph, A2A, and NATS implementations;
- multi-language SDK release schedule;
- promotion of runtime security or runtime capacity to separate services;
- microservice extraction.

Each item requires a dedicated ADR based on implemented invariants and
measured needs.
