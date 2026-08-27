---
id: runtime.architecture.communication-boundaries
type: architecture
status: accepted
owner: architecture
summary: Separates runtime communication semantics from transports and orchestration policy.
related:
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
---

# Communication Boundaries

Status: accepted architectural direction as amended by ADR-0001, ADR-0002,
ADR-0003, and ADR-0004; detailed protocols remain open ADRs.

## Purpose

Communication is an independent architectural concern. An owner-local Agent
Runtime slice may proceed without resolving unrelated communication surfaces.
Before a slice publishes or consumes an external contract, or dispatches
provider effects, the owning decision must define the applicable schema,
compatibility, identity, recovery, and conformance behavior. ADR-0001 through
ADR-0004 already control accepted runtime semantics. Exact Published Language
representation remains deferred. Orchestrator inboxes and A2A product semantics
remain consumer-owned and are not prerequisites for an unrelated owner-local
slice.

Agent Runtime must
support local and hosted deployments, ACP-compatible and native agents, and
future consumers without making any transport or external protocol part of its
domain model.

The communication design must remain extensible to future agent-to-agent
integration, including A2A, without moving orchestration policy into Agent
Runtime.

## Ownership boundary

Agent Runtime owns:

- technical input delivery to a managed runtime session;
- provider connection and session bindings;
- runtime interaction requests that block technical execution;
- durable command receipts and ambiguous-outcome reconciliation;
- runtime control and output feeds;
- correlation with caller-owned opaque references;
- process custody, recovery, cancellation, and enforcement.

Agent Runtime does not own:

- team messages, task assignment, handoffs, or teammate inboxes;
- workflow routing or agent-to-agent coordination policy;
- business-level approvals;
- NATS subjects, streams, consumers, or delivery policy;
- A2A task semantics or ACP wire DTOs.

Those concerns belong to an orchestrator or another consumer. Agent Runtime
provides narrow runtime capabilities that their anti-corruption layers can
consume.

## Separate communication dimensions

The architecture must not collapse these dimensions into one message model:

1. Semantic intent: what the caller wants the runtime to do.
2. Command acceptance: accepted, rejected, stale, expired, unsupported, or
   uncertain.
3. Durable delivery: retries, deduplication, acknowledgement, ordering, and
   backpressure.
4. Provider interaction: ACP or provider-native session and prompt protocols.
5. Runtime observation: lifecycle, permissions, output, artifacts, and
   diagnostics.
6. Integration transport: Embedded, ConnectRPC, A2A, NATS, or future adapters.

A transport envelope is not a domain command. A provider update is not an
orchestration event. An ACP session is not an Agent Runtime session.

## Protocol roles

- The public Agent Runtime API exposes managed-runtime semantics through
  consumer-facing SDKs and Embedded or Connect transports.
- ACP is a first-class agent-facing protocol adapter. Separate v1 and v2
  translators may map negotiated ACP wire semantics into provider-neutral
  application capabilities. ACP v2 remains isolated while its protocol is
  Draft.
- Provider-native adapters remain available when ACP is absent, incomplete, or
  lossy.
- MCP supplies tools, resources, and client-owned context. It is not a runtime
  management protocol.
- A2A is a future integration protocol for communication between autonomous
  agent systems. It belongs outside the runtime domain and must enter through a
  consumer-owned anti-corruption layer.
- NATS JetStream belongs to orchestration delivery and integration adapters,
  not Agent Runtime core.

## Invariants

- Domain and application packages never import ACP, A2A, NATS, Connect, MCP,
  Protobuf transport DTOs, or provider SDK types.
- Protocol versions are selected and negotiated per connection.
- One runtime operation has exactly one command-authority protocol binding per
  capability. Multiple writers must never control the same provider session.
- Provider connection identity, provider session identity, runtime session
  identity, runtime operation identity, and operation dispatch identity are
  distinct.
- External message, tool-call, plan, terminal, and artifact identifiers are
  namespaced opaque references.
- Input acceptance is separate from execution completion.
- Provider replay is separate from Agent Runtime durable feed replay.
- Ordering guarantees are explicit per feed or aggregate; there is no implied
  global order.
- Commands expose uncertain outcomes for reconciliation after transport
  failure. Authority- and effect-bearing identities retain a terminal receipt
  or tombstone for at least their full retry, restore, provider-replay, and
  resurrection-prevention horizon. Expiry of an ordinary query or transport
  deduplication window never makes an old semantic effect safe to execute
  again.
- A target-specific prevention request may durably fence an original operation
  command before that command materializes a RuntimeOperation. Original command
  acceptance, the negative guard, and dispatch claim serialize in one Agent
  Execution authority store; target absence alone is not prevention evidence.
- Unknown permission outcomes and unregistered protocol extensions fail
  closed.
- Authentication, authorization, tenant and workspace scope, redaction,
  payload limits, and attachment access are enforced before side effects.
- Retries, timeouts, cancellation, backpressure, slow consumers, and retention
  expiry have explicit outcomes.
- Raw protocol passthrough is disabled by default. Extensions require typed
  registration, validation, redaction, and policy.

## Communication architecture to design

Before implementing each corresponding external communication surface,
dedicated ADRs must define:

1. The provider-neutral input, observation, interaction, configuration, and
   capability contracts.
2. ACP v1 support and ACP v2 Draft isolation, negotiation, feature flags, and
   conformance.
3. Provider runtime instance and connection sharing topology, including the
   blast radius of multiplexed sessions.
4. Runtime command receipts, idempotency scope, ambiguous outcomes, and
   reconciliation queries.
5. Control, output, terminal, log, and artifact feed ordering, cursors,
   retention, replay, and backpressure.
6. Permission request, authority decision reference, stale-decision rejection,
   enforcement intent, and enforcement reconciliation.
7. Attachment and artifact references without copying unbounded payloads into
   commands or events.
8. Local and remote authentication, authorization, workspace grants, and
   protocol-extension security.
9. The future A2A boundary: which context owns A2A tasks, how identities and
   capabilities map, and how A2A delivery is translated into runtime commands
   without exposing runtime internals.
10. Orchestrator inbox separation for direct messages, subscribed events, task
    notifications, and deferred delivery while an agent is busy.

These ADRs may choose different technologies. They must preserve the ownership
and dependency rules in this document.
