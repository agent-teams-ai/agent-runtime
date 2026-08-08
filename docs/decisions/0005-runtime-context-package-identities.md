---
id: ADR-0005
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0005: Runtime context package identities

Status: accepted for implementation scaffolding

Date: 2026-08-08

## Context

ADR-0002 fixes the four v1 bounded contexts and requires separate package,
schema, migration, and transaction ownership. Deterministic scaffolding also
needs stable target IDs, repository paths, and private package names. Those
technical identities were not previously protected by an accepted immutable
decision.

## Decision

The initial bounded-context package identities are:

| Context | Target ID | Repository path | Private package name |
| --- | --- | --- | --- |
| Runtime Configuration | `runtime-configuration` | `packages/contexts/runtime-configuration` | `@agent-teams/runtime-configuration` |
| Runtime Security | `runtime-security` | `packages/contexts/runtime-security` | `@agent-teams/runtime-security` |
| Provider Access | `provider-access` | `packages/contexts/provider-access` | `@agent-teams/provider-access` |
| Agent Execution | `agent-execution` | `packages/contexts/agent-execution` | `@agent-teams/agent-execution` |

ADR-0005 is the owner document used by Foundation scaffolding. The target
catalog may repeat these values only as executable configuration. Changing a
target ID, path, package name, role, or context set requires a new accepted ADR;
the accepted baseline protects this decision from in-place mutation.

Scaffolding creates a package only with its first accepted vertical slice. It
does not authorize empty packages, speculative layers, cross-context imports,
or shared domain entities.

## Consequences

- package identity is stable before implementation without creating code;
- source-dependency boundaries use these identities after materialization;
- renaming or splitting a context is an explicit migration decision;
- the four packages remain private until a separate Published Language or
  public-package decision proves external compatibility requirements.
