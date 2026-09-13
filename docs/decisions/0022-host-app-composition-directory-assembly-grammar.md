---
id: ADR-0022
type: adr
status: accepted
owner: architecture
summary: Lets an active host-app list extra src/composition/*.ts assembly files that may contain process-lifecycle behavior without rewriting ADR-0013 or activating Embedded Runtime.
related:
  - ADR-0008
  - ADR-0013
  - ADR-0017
  - ADR-0020
  - ADR-0021
code_anchors:
  - enforcement: required
    pattern: scripts/architecture/check-feature-modules.mjs
  - enforcement: required
    pattern: scripts/architecture/feature-module-profile.mjs
---

# ADR-0022: Host-app composition directory assembly grammar

Status: accepted

Date: 2026-09-12

## Context

ADR-0017 classified `packages/apps/embedded-runtime` as a `host-app` and left
it pending. The Feature Module Standard currently treats only `src/index.ts`
and `src/composition.ts` as package assembly, and those files may contain only
imports and named re-exports.

Host already folds feature implementations under `src/features/`. Host
composition still re-exports those features from matching
`src/composition/*.ts` files, and process lifecycle, readiness, rollback, and
host custody remain in that directory. Those lifecycle files contain behavior
and import sibling composition files, curated feature entrypoints, and Node
modules. Listing them as curated assembly would fail the import/re-export
rule. Leaving them unowned would fail `FM_BEHAVIOR_OUTSIDE_FEATURE` if the
module were activated.

ADR-0013 requires a separate accepted decision for any extension of this
grammar. This is that authority for host-app composition directory files. It
is not Host activation.

## Decision

An active host-app may list additional explicit `src/composition/*.ts`
assembly files beside the curated `index.ts` and `composition.ts` entries.
Bounded-context and platform modules still have only those two curated files.
Nested paths under `src/composition/` are rejected. Extra assembly files are
enumerated; the profile has no wildcard.

Curated `index.ts` and `composition.ts` stay import/re-export only. Extra
host-app composition assembly files may contain behavior, import sibling host
composition assembly files, import curated feature public or internal
entrypoints, and import Node or external modules. Deep feature imports still
fail closed.

This decision does not rewrite ADR-0013 or ADR-0015. It does not move host
custody or process-lifecycle implementations. Embedded Runtime remains
pending until a later accepted activation ADR, feature README metadata, and
`tests/features/` placement land.

## Consequences

The checker and reviewed profile validation enforce this grammar on fixtures
now. The live profile does not list extra Host composition files while
Embedded Runtime stays pending. Activating Host without those explicit extra
assembly files still fails closed.
