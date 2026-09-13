---
id: ADR-0021
type: adr
status: accepted
owner: architecture
summary: Activates the Runtime Security bounded context as four Feature Module Standard v1 features without rewriting ADR-0013.
related:
  - ADR-0005
  - ADR-0013
  - ADR-0017
  - ADR-0018
  - ADR-0019
  - ADR-0020
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/README.md
  - enforcement: required
    pattern: packages/contexts/runtime-security/src/features/contained-turn-egress/README.md
  - enforcement: required
    pattern: packages/contexts/runtime-security/src/features/provider-process-egress-authorization/README.md
  - enforcement: required
    pattern: packages/contexts/runtime-security/src/features/setup-source-inspection-authorization/README.md
---

# ADR-0021: Runtime Security feature activation

Status: accepted

Date: 2026-09-12

## Context

ADR-0017 classified `packages/contexts/runtime-security` as a
`bounded-context` module and left it pending. ADR-0013 requires a separate
accepted decision for any scope extension, and ADR-0017 requires every
activation to carry its own accepted authority. This is that authority for
this one module.

The module already has four features: `contained-turn-dispatch-authority`,
`contained-turn-egress`, `provider-process-egress-authorization`, and
`setup-source-inspection-authorization`. Dispatch, egress, and provider-process
egress each own contracts, domain, application, adapters, and feature-local
composition. Setup-source inspection owns contracts, application, adapters, and
composition and has no `domain` directory. Package assembly reaches them through
curated `index.ts` and `internal.ts` entrypoints. Feature tests live under
`tests/features`.

Setup-source inspection reads authorized paths through Filesystem Custody. That
dependency is a runtime module edge, not a type-only edge, and it cannot be
declared until this module is active.

## Decision

Activate `packages/contexts/runtime-security/src` as a governed production root
with exactly those four features. Dispatch, egress, and provider-process egress
declare the `contracts`, `domain`, `application`, `adapters`, and `composition`
roles. Setup-source inspection declares `contracts`, `application`, `adapters`,
and `composition` only.

No empty domain layer is created for setup-source inspection. Path-scope
authorization classifies observed sources; it does not own an invariant
independent of the adapters that read those sources. An empty domain layer
would be ceremony that the standard explicitly does not require.

The package public entry continues to expose only feature contracts. Runtime
factories remain behind `./composition`. The declared module edge
`runtime-security -> filesystem-custody` is `runtime` only.

This decision does not rewrite ADR-0013. ADR-0013 remains the profile-wide
activation authority for the original three features. Filesystem Custody stays
on ADR-0019. Runtime Configuration stays on ADR-0020. Embedded Runtime remains
pending.

## Consequences

Runtime Security is continuously checked against the pinned standard identity:
its layer direction, curated entrypoints, README ownership, test placement,
curated package export map, and the declared Filesystem Custody runtime edge
all now fail closed.

This decision adds no capability, changes no security boundary, and makes no
qualification claim about any provider or platform.
