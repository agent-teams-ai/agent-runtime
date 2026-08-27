---
id: ADR-0008
type: adr
status: accepted
owner: architecture
summary: Defines the private scope-bound Agent Runtime entrypoint and direct composition boundary.
related:
  - ADR-0001
  - ADR-0002
  - ADR-0005
blocked_by: []
code_anchors:
  - enforcement: required
    pattern: packages/apps/embedded-runtime/**
supersedes: []
superseded_by: []
---

# ADR-0008: Private embedded Runtime access entrypoint

Status: accepted

Date: 2026-08-27

## Context

Agent Runtime's first production slice is a passive Codex setup inspection.
It composes narrow queries owned by Agent Execution, Runtime Configuration,
and Runtime Security. ADR-0005 intentionally reserves one package per bounded
context, so the cross-context application entry must not become a fifth
business context or a shared domain package.

The first consumer is an embedded, trusted application on the same Node.js
process boundary. A public SDK, transport protocol, dynamic module graph, or
runtime lifecycle API would create contracts that no external consumer yet
requires.

## Decision

The private embedded application package is
`packages/apps/embedded-runtime`, with private package identity
`@agent-teams/embedded-runtime`. It owns only trusted scope binding,
cross-context anti-corruption mapping, application query composition, and
resource disposal. Domain behavior, adapters, and persistence remain in their
owning bounded-context packages.

The consumer-visible root export contains only detached capability contracts
and `RuntimeAccessHandle`. AR-1 exposes exactly
`RuntimeAccessHandle.codexSetup.inspect`. The handle contains no connection,
credential, repository, context handle, module identity, container resolver, or
lifecycle method.

The package's private `./composition` export exposes `createAgentRuntimeHost`
to the trusted application composition root. `AgentRuntimeHost` binds a
trusted, immutable runtime access scope and returns a scope-bound
`RuntimeAccessHandle`. Scope is supplied by trusted composition and cannot be
overridden in an inspection request. The Host is internal assembly and custody;
ordinary capability consumers never receive it.

Composition uses owner-local `FeatureModuleFactory` functions and exact plain
typed dependency objects. It has no service locator, dependency registry,
module graph, container, registration ordering, or asynchronous effect during
graph construction. A future validated module adapter may provide the same
dependency objects without changing the product capability API.

Host disposal is idempotent, bounded, and invalidates every handle created by
that Host. AR-1 normally owns no long-lived resource, but the disposal contract
prevents later resource custody from leaking into capability DTOs. Cancellation
of `codexSetup.inspect` cancels only the local observation; it does not mean
durable runtime cancellation.

The package exports no private TypeScript DTO as Published Language. A public
SDK, local IPC, or network transport requires a new decision after a real
external consumer establishes process placement, trust, streaming,
compatibility, and cancellation requirements.

## Consequences

- Codex setup inspection can ship through direct Pure DI without waiting for a
  dynamic module ownership decision.
- Cross-context application composition has one explicit physical owner while
  the four bounded contexts retain their language and invariants.
- Replacing direct composition later is limited to the composition adapter;
  `RuntimeAccessHandle` and owner-local use cases remain unchanged.
- The private package is not a general facade, SDK, transport, plugin host, or
  fifth bounded context.
- `prepare`, `start`, `ready`, `drain`, `stop`, runtime installation, provider
  execution, and saved-profile persistence remain outside AR-1.
