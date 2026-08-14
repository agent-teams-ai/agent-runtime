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

## Accepted

- [ADR-0001: Runtime profile and activation boundaries](0001-runtime-profile-and-activation-boundaries.md)
- [ADR-0002: Architecture reconciliation, tenancy, and operator recovery](0002-architecture-reconciliation-tenancy-and-operator-recovery.md)
- [ADR-0003: Runtime cutoff barriers and scope disposition](0003-runtime-cutoff-barriers-and-scope-disposition.md)
- [ADR-0004: Pre-materialization dispatch prevention](0004-pre-materialization-dispatch-prevention.md)
- [ADR-0005: Runtime context package identities](0005-runtime-context-package-identities.md)
- [ADR-0007: Deterministic documentation governance](0007-deterministic-documentation-governance.md)

## Superseded

No superseded decisions.
