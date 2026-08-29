---
id: ADR-0013
type: adr
status: proposed
owner: architecture
summary: Proposes scoped candidate adoption of immutable Feature Module Standard v1 without claiming conformance.
related:
  - ADR-0005
  - ADR-0007
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: scripts/architecture/check-feature-modules.mjs
---

# ADR-0013: Feature Module Standard v1 candidate adoption

Status: proposed

Date: 2026-08-29

## Context

ADR-0005 defines private runtime package identities and ADR-0007 governs
deterministic documentation. Neither decision adopts an organization feature
module policy. The current production tree predates curated feature
entrypoints, so immediately claiming conformance or wiring a new gate would
misrepresent the repository and block unrelated lanes.

The organization standard is immutable at
`agent-teams-ai/.github:docs/architecture/feature-module-standard/v1.md`, Git
blob `d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.

## Decision

Propose a Phase A candidate profile and deterministic syntax-aware checker for
only Agent Execution and Provider Access source, their package assembly files,
and the three named features in the local adoption document. Candidate status
records diagnostics but does not establish active conformance.

The profile cannot use baselines, history, grandfather lists, regex parsing,
wildcards, future-state declarations, or automatic scope widening. Extensions,
deviations, and exceptions are closed by default and require an accepted ADR
with an owner, rationale, and deterministic review trigger.

Layer direction is default-deny: domain is inward-only, and neither domain nor
application may import public transport contracts. Application dependencies
remain limited to domain code and application-owned ports or models. Public
feature entrypoints expose only their own contracts, and unused declared edges
are rejected rather than retained as future-state permissions.

The production checker stays outside `check` and `check:fast` while diagnostics
remain. A later reviewed decision may accept activation only after the fixture
suite passes, the exact candidate scope reaches zero diagnostics without
exceptions or widening, the profile changes to `active`, and the active command
is wired into both gates.

## Consequences

Phase A makes policy gaps reproducible without changing production packages or
claiming repository-wide conformance. Current assembly and missing-entrypoint
violations remain visible for other cleanup lanes. Embedded Runtime, Runtime
Configuration, Runtime Security, Filesystem Custody, Module Kit, experiments,
and unrelated tooling remain out of scope.

Because this ADR is proposed, it does not independently authorize production
behavior, exceptions, or activation.
