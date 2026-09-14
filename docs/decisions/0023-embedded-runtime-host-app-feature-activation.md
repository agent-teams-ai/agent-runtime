---
id: ADR-0023
type: adr
status: accepted
owner: architecture
summary: Activates Embedded Runtime as a host-app under Feature Module Standard v1 without rewriting ADR-0013 or moving host custody.
related:
  - ADR-0008
  - ADR-0013
  - ADR-0017
  - ADR-0018
  - ADR-0020
  - ADR-0021
  - ADR-0022
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: packages/apps/embedded-runtime/src/features/ordinary-session-runtime/README.md
---

# ADR-0023: Embedded Runtime host-app feature activation

Status: accepted

Date: 2026-09-14

## Context

ADR-0017 classified `packages/apps/embedded-runtime` as a `host-app` module and
left it pending. ADR-0013 requires a separate accepted decision for any scope
extension, and ADR-0017 requires every activation to carry its own accepted
authority. ADR-0022 records the host-app extra `src/composition/*.ts` assembly
grammar so those lifecycle files can be listed without rewriting the curated
`index.ts` / `composition.ts` import/re-export rule. ADR-0022 is not Host
activation. This is that activation authority for this one module.

The module already has twenty-five features under `src/features/`. Each feature
declares README ownership, curated `index.ts` and `internal.ts` entrypoints, and
the nonempty roles it actually owns. Feature tests live under `tests/features`
or `tests/package`. Public feature entrypoints expose only contracts; features
whose public surface depends on other production packages keep that surface on
`internal.ts` and extra assembly.

Host composition still re-exports those features from matching
`src/composition/*.ts` hops. Process lifecycle, readiness, rollback, and host
custody remain in that directory. Feature `adapters` and `composition` layers
already import those listed extra assembly files; that hop surface is the
existing Host composition boundary, not a new cross-feature public API.

## Decision

Activate `packages/apps/embedded-runtime/src` as a governed production root with
host-app role and exactly those twenty-five features.

`ordinary-session-runtime` declares `contracts`, `adapters`, and `composition`.
`contained-turn-access-authority`, `setup-inspection-planning`, and
`trusted-runtime-access-scope` declare `contracts` and `adapters`.
`contained-turn-cancellation-proof` and `contained-turn-runtime-access` declare
`contracts` and `composition`. `contained-turn-composition-types`,
`contained-turn-construction-failure`, `contained-turn-operation-ref`, and
`contained-turn-owner-contract-error` declare `contracts` only.
`contained-turn-runtime-validation` declares `composition` only. The remaining
features declare `adapters` only:
`contained-turn-authority-capability`, `contained-turn-current-authority`,
`contained-turn-current-egress-owners`,
`contained-turn-http-egress-authorities`, `contained-turn-http-egress-upstream`,
`contained-turn-http-provider-access`, `contained-turn-http-runtime-security`,
`contained-turn-linux-route-binding`, `contained-turn-provider-selection`,
`contained-turn-route-qualification`, `darwin-contained-turn-authority`,
`darwin-contained-turn-deployment`, `linux-codex-deployment`, and
`linux-codex-node-recipe`.

No empty `domain` or `application` layer is created. Host feature
implementations own adapters or feature-local composition; they do not own an
inward model independent of those adapters. An empty inward layer would be
ceremony that the standard explicitly does not require.

The live profile lists every extra Host `src/composition/*.ts` file as
`assemblyFiles` under ADR-0022. Curated `index.ts` and `composition.ts` stay
import/re-export only. Extra assembly files may contain behavior. Host-app
feature `adapters` and `composition` may import those listed extra assembly
files. Contracts, domain, and application still cannot. Deep feature imports
still fail closed.

The package public entry continues to expose only feature contracts. Runtime
factories remain behind `./composition` and the extra composition hops.
Observed module edges from Embedded Runtime onto other active production
modules are declared with their exact kinds.

This decision does not rewrite ADR-0013, ADR-0015, or ADR-0022. ADR-0013 remains
the profile-wide activation authority for the original three features.
Filesystem Custody stays on ADR-0019. Runtime Configuration stays on ADR-0020.
Runtime Security stays on ADR-0021. Host custody and process-lifecycle
implementations stay in extra composition; this decision does not move them.

## Consequences

Embedded Runtime is continuously checked against the pinned standard identity:
its layer direction, curated entrypoints, extra composition assembly listing,
README ownership, test placement, curated package export map, and declared
module and feature edges all now fail closed.

This decision adds no capability, changes no security boundary, and makes no
qualification claim about any provider or platform.
