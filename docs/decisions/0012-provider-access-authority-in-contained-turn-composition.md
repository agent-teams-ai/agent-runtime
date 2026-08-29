---
id: ADR-0012
type: adr
status: accepted
owner: architecture
summary: Corrects the closed contained-turn Pure DI dependency set to include Provider Access without changing other ADR-0009 invariants.
related:
  - ADR-0001
  - ADR-0009
  - ADR-0010
code_anchors:
  - enforcement: required
    pattern: experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json
---

# ADR-0012: Provider Access authority in contained-turn composition

Status: accepted

Date: 2026-08-29

## Context

Accepted ADR-0009 defines the closed trusted composition for Contained Agent
Turn V1. Its six-member dependency enumeration omits the Provider Access
collaboration that ADR-0001 assigns to a separate bounded context and that the
active delivery plan requires Agent Execution to consume explicitly. Hiding
those facts in the selected provider adapter would combine authorities and
make the dependency graph false.

ADR-0009 is immutable. This successor decision is reviewed against repository
base `40ddaedd0da009a6611988e3a8e9eb00857b05be` and corrects only that
enumeration. It does not reopen any other ADR-0009 decision or any ADR-0010
operation invariant.

## Decision

The ADR-0009 closed trusted composition clause is replaced only where it lists
the Pure DI factory dependencies. The exact closed, read-only dependency
object has these seven members:

```ts
Readonly<{
  operationStore: ContainedTurnOperationStore;
  security: ContainedTurnSecurityPort;
  providerAccess: ContainedTurnProviderAccessPort;
  workspace: ContainedTurnWorkspacePort;
  artifacts: ContainedTurnArtifactPort;
  custody: ProviderProcessCustodyPort;
  provider: ContainedTurnProviderPort;
}>
```

Exact closed membership is the invariant; the number seven is its consequence.
The factory remains synchronous, effect-free, resource-free, and Pure DI.

Provider Access owns provider account, access, route, credential-binding, and
credential-generation facts. Agent Execution owns provider adapter, binary,
and adapter capability-manifest revisions. Agent Execution also owns the
consumer-side `ContainedTurnProviderAccessPort`. Outer product composition
supplies an anti-corruption-layer adapter that maps the Provider Access feature
to that port without transferring fact ownership or importing Provider Access
domain types into the use case.

The seven-member object is supplied explicitly at composition. No registry,
service locator, dependency bag, Module Kit type, ambient lookup, or composite
provider god-port enters the use case. Provider Access facts cannot be hidden
inside the provider adapter, provider manifest, environment, or module
declaration.

Every other ADR-0009 invariant remains unchanged: the composition root selects
the exact provider adapter before factory construction; dependency discovery
and caller-supplied provider sessions remain forbidden; ordinary callers
receive only the trusted scope-bound `RuntimeAccessHandle`; capability
detachment, trusted-scope binding, durable cancellation meaning, Host disposal
and shutdown truth, identity/lifecycle separation, and the absence of a Module
Kit dependency all retain their original force.

## Consequences

- Agent Execution can resolve and revalidate exact Provider Access authority
  through its own narrow consumer port without owning Provider Access facts.
- The selected provider adapter remains responsible only for execution-facing
  adapter, binary, and capability-manifest revisions.
- Direct composition and any future separately admitted composition adapter
  must supply the same exact seven-member plain dependency object.
- ADR-0009 remains immutable evidence; this decision supersedes no clause other
  than its six-member composition enumeration.
