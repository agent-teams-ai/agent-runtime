---
id: runtime.decisions.index
type: index
status: active
owner: architecture
summary: Lifecycle index for Agent Runtime architecture decisions.
related:
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0005
  - ADR-0006
  - ADR-0008
  - ADR-0009
  - ADR-0010
blocked_by: []
code_anchors:
  - enforcement: required
    pattern: architecture/decisions/accepted-decisions.json
---

# Architecture Decision Index

Architecture decisions use stable `ADR-NNNN` identities. Accepted decisions are
immutable evidence; a later change uses an explicit superseding decision.

## Proposed

- [ADR-0006: Orthogonal runtime-operation state and effect continuity](0006-orthogonal-runtime-operation-state-and-effect-continuity.md)
  remains the broader design proposal. ADR-0010 accepts only its narrow V1
  subset without mutating this document.

## Accepted

- [ADR-0001: Runtime profile and activation boundaries](0001-runtime-profile-and-activation-boundaries.md)
- [ADR-0002: Architecture reconciliation, tenancy, and operator recovery](0002-architecture-reconciliation-tenancy-and-operator-recovery.md)
- [ADR-0003: Runtime cutoff barriers and scope disposition](0003-runtime-cutoff-barriers-and-scope-disposition.md)
- [ADR-0004: Pre-materialization dispatch prevention](0004-pre-materialization-dispatch-prevention.md)
- [ADR-0005: Runtime context package identities](0005-runtime-context-package-identities.md)
- [ADR-0007: Deterministic documentation governance](0007-deterministic-documentation-governance.md)
- [ADR-0008: Private embedded Runtime access entrypoint](0008-private-embedded-runtime-access-entrypoint.md)
  introduced the private scope-bound handle with the AR-1 Codex query. Current
  traceability in
  [readiness](../architecture/readiness.md#profiles-settings-and-environment)
  records the sibling `RuntimeAccessHandle.claudeCodeSetup.inspect`
  implementation under the same private composition boundary. That additive
  query does not qualify a Claude executable, provider route, production
  collector, deployment, or any access, trust, installation, or execution
  capability; ADR-0008 remains immutable historical authority.
- [ADR-0009: Contained turn private access and Host shutdown boundary](0009-contained-turn-private-access-and-host-shutdown-boundary.md)
  adds the trusted contained-turn handle, durable-cancellation meaning, and
  Host-shutdown truth boundary without changing ADR-0008.
- [ADR-0010: Contained Agent Turn V1 operation authority](0010-contained-agent-turn-v1-operation-authority.md)
  accepts the narrow one-attempt operation contract while preserving the
  broader proposed ADR-0006 as design input.

## Superseded

No superseded decisions.
