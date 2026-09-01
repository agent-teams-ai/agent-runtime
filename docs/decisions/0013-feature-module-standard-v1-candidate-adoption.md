---
id: ADR-0013
type: adr
status: accepted
owner: architecture
summary: Accepts Feature Module Standard v1 for exactly three scoped features without claiming repository-wide conformance.
related:
  - ADR-0005
  - ADR-0007
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: scripts/architecture/check-feature-modules.mjs
---

# ADR-0013: Scoped Feature Module Standard v1 adoption

Status: accepted

Date: 2026-08-29

## Context

ADR-0005 defines private runtime package identities and ADR-0007 governs
deterministic documentation. Neither decision adopts an organization feature
module policy. The scoped production cleanup and test relocation defined by the
delivery plan now produce zero diagnostics for the three reviewed features. Acceptance must
therefore describe only that exact boundary and must not imply repository-wide
conformance.

The organization standard is immutable at
`agent-teams-ai/.github:docs/architecture/feature-module-standard/v1.md`, Git
blob `d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.

## Decision

Accept the immutable Feature Module Standard v1 for exactly these existing
features and no others:

- `runtime-installation-discovery` in Agent Execution;
- `contained-agent-turn` in Agent Execution;
- `contained-turn-access` in Provider Access.

The governed production roots remain only the Agent Execution and Provider
Access `src` trees, with only their package `index.ts` and `composition.ts`
assembly files. The exact active layout, exclusions, local language and
packaging mappings, and ownership records are declared in
`architecture/feature-module-standard/candidate-profile.json`. Embedded
Runtime, Runtime Configuration, Runtime Security, Filesystem Custody, Module
Kit, experiments, unrelated tooling, every other bounded context, and every
other feature remain outside this decision. This is scoped active conformance,
not repository-wide conformance.

The profile may not use baselines, history, grandfather lists, regex parsing,
wildcards, future-state declarations, automatic scope widening, extensions,
deviations, or exceptions for this activation. Its extension, deviation, and
exception sets are empty, so the activation authority records an empty exact
governed-record set. Any later scope extension or policy exception requires a
separate accepted decision and deterministic evidence.

Layer direction remains default-deny: domain is inward-only, neither domain
nor application may import public transport contracts, application
dependencies are limited to domain code and application-owned ports or models,
and public feature entrypoints expose only their own contracts. Wildcard
entrypoint and assembly re-exports, unused edges, missing README ownership,
incorrect scoped test placement, non-curated package exports, configured alias
bypasses, `module.require`, and `createRequire` aliases remain rejected.

Activation is authorized only with zero diagnostics from the exact candidate
command, a passing deterministic fixture suite, an active profile bound to this
accepted ADR at its exact governed path, and the active checker immediately
after the fixture suite in both root gates. Removing or reordering either gate
must fail deterministic checker fixtures.

## Consequences

The three named features and their two owning package roots are continuously
checked against the exact pinned standard identity. Their relocated tests are
owned by their semantic feature or package surface, and both PostgreSQL tests
remain in the focused PostgreSQL command.

No provider, kernel, persistence, canary, Module Kit, or other bounded-context
behavior is authorized or changed by this decision. A green active check proves
only the profile boundary above; it cannot be cited as repository-wide Feature
Module Standard conformance.
