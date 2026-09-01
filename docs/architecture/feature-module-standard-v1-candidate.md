---
id: runtime.architecture.feature-module-standard-v1-candidate
type: architecture
status: active
owner: architecture
summary: Defines scoped active conformance for three Feature Module Standard v1 features.
related:
  - ADR-0005
  - ADR-0007
  - ADR-0013
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/**
  - enforcement: required
    pattern: scripts/architecture/check-feature-modules.mjs
---

# Feature Module Standard v1 scoped active adoption

## Purpose

Agent Runtime actively conforms to a scoped profile of the immutable
`agent-teams.feature-module-standard` version `v1`. The central document is
owned by `agent-teams-ai/.github` at
`docs/architecture/feature-module-standard/v1.md`, Git blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`, with SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.

This is scoped active conformance for exactly three named features. It is not a
claim of repository-wide conformance, and no unlisted package, application,
feature, experiment, or bounded context is included.

## Ownership boundary

The machine-readable authority is
`architecture/feature-module-standard/candidate-profile.json`; its schema is
beside it. The active production scope contains only:

- `packages/contexts/agent-execution/src/**`;
- `packages/contexts/provider-access/src/**`;
- the package assembly files `src/index.ts` and `src/composition.ts` in those
  two packages;
- the features `runtime-installation-discovery`, `contained-agent-turn`, and
  `contained-turn-access`.

Embedded Runtime, Runtime Configuration, Runtime Security, Filesystem Custody,
Module Kit, experiments, and tooling other than this checker are explicitly
out of scope. Foundation supplies package-level dependency evidence only; it
does not implement or prove this feature policy.

The deterministic syntax-aware checker is
`scripts/architecture/check-feature-modules.mjs`. Run
`pnpm test:feature-modules` for disposable positive and negative fixtures,
`pnpm architecture:feature-modules:candidate` for the stable zero-diagnostic
current-tree evidence, and `pnpm architecture:feature-modules:active` for the
blocking scoped conformance gate. The fixture suite and active checker run in
that order in both `check` and `check:fast`. Structural, profile, schema, scope,
pin, authority, gate-presence, and active-status failures remain nonzero.

## Invariants

The profile binds the exact immutable central identity and cannot widen scope
automatically. It has no file-count baseline, Git-history comparison, mutable
grandfather allowlist, regex source parser, wildcard exception, or future-state
metadata. Any extension, deviation, or exception requires exact diagnostic
paths and lines, an accepted ADR, owner, rationale, and deterministic review
trigger. Active authority must name ADR-0013 at its exact governed path and
enumerate every such record.

The checker defaults production behavior into declared feature or assembly
ownership, parses supported import and re-export syntax with pinned
`oxc-parser`, and fails closed for parser errors and nonliteral loading. It
checks layer direction, curated public/internal entrypoints, cross-feature deep
imports, declared runtime and type edges, cycles, nonempty declared layers, and
undeclared shared/common/utils/module ownership. It also verifies feature
README ownership, feature-test colocation, and the two curated package export
map entries. Public feature entrypoints may expose only their own contracts.
Public, internal, and package assembly entrypoints reject wildcard re-exports.
Declared feature edges must connect declared features and must correspond to
observed imports; unused edge declarations are rejected as future-state
permissions.

All local feature dependencies are denied unless they follow an allowed
same-feature layer direction or use a declared cross-feature edge through the
target feature's public entrypoint. Package assembly and feature entrypoint
files accept only import/re-export grammar. Configured TypeScript and package
aliases, package self-imports, `module.require`, and aliases returned by
`createRequire` cannot bypass these checks. Empty, comments-only, and
`export {}`-only layer files do not make a declared layer substantive.

Layer direction is default-deny. Domain code is inward-only and cannot import
public transport contracts. Application code may depend on domain code and
application-owned ports or models, but it also cannot import public transport
contracts. Contracts, domain, and application layers cannot import external
packages or Node builtins; adapters and composition own those integrations.

## Active conformance evidence

The scoped cleanup and relocation are complete. The deterministic fixture suite
passes, including positive active-manifest coverage and negative cases that
remove or reorder the active root gate. The exact candidate command reports
zero production diagnostics without exceptions, deviations, extensions,
wildcards, automatic widening, or scope changes.

ADR-0013 is accepted at its exact governed path and is pinned in the immutable
accepted-decision registry by the final SHA-256 of its accepted bytes. The
profile is `active`, has no blockers, binds its authority to ADR-0013, records
an empty exact governed-record set, and records these commands as evidence:

- fixture evidence: `pnpm test:feature-modules`;
- zero-diagnostic production evidence: `pnpm architecture:feature-modules:candidate`;
- blocking active gate: `pnpm architecture:feature-modules:active`.

This evidence proves conformance only for `runtime-installation-discovery`,
`contained-agent-turn`, and `contained-turn-access` within the two declared
production roots and assembly files. It does not prove repository-wide Feature
Module Standard conformance.
