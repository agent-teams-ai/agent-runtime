---
id: ADR-0020
type: adr
status: accepted
owner: architecture
summary: Activates the Runtime Configuration bounded context as two Feature Module Standard v1 features without rewriting ADR-0013.
related:
  - ADR-0005
  - ADR-0013
  - ADR-0017
  - ADR-0018
  - ADR-0019
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/README.md
  - enforcement: required
    pattern: packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/README.md
---

# ADR-0020: Runtime Configuration feature activation

Status: accepted

Date: 2026-09-12

## Context

ADR-0017 classified `packages/contexts/runtime-configuration` as a
`bounded-context` module and left it pending. ADR-0013 requires a separate
accepted decision for any scope extension, and ADR-0017 requires every
activation to carry its own accepted authority. This is that authority for
this one module.

The module already has two features, `codex-configuration-inspection` and
`claude-code-configuration-inspection`. Each owns contracts, application
models and ports, inbound and outbound adapters, and feature-local composition.
Package assembly reaches them through curated `index.ts` and `internal.ts`
entrypoints. Feature tests live under `tests/features`. Neither feature has a
`domain` directory.

Codex and Claude inspection both read authorized configuration sources through
Filesystem Custody. That dependency is a runtime module edge, not a type-only
edge, and it cannot be declared until this module is active.

## Decision

Activate `packages/contexts/runtime-configuration/src` as a governed production
root with exactly those two features, each declaring the `contracts`,
`application`, `adapters`, and `composition` roles.

No `domain` layer is created. Inspection classifies observed configuration; it
does not own an invariant independent of the adapters that read those sources.
An empty domain layer would be ceremony that the standard explicitly does not
require.

The package public entry continues to expose only feature contracts. Runtime
factories remain behind `./composition`. The declared module edge
`runtime-configuration -> filesystem-custody` is `runtime` only.

This decision does not rewrite ADR-0013. ADR-0013 remains the profile-wide
activation authority for the original three features. Filesystem Custody stays
on ADR-0019. Runtime Security and Embedded Runtime remain pending.

## Consequences

Runtime Configuration is continuously checked against the pinned standard
identity: its layer direction, curated entrypoints, README ownership, test
placement, curated package export map, and the declared Filesystem Custody
runtime edge all now fail closed.

Inspection never executes an observed binary or reads ambient authentication
state. This decision adds no capability, changes no security boundary, and
makes no qualification claim about any provider or platform.
