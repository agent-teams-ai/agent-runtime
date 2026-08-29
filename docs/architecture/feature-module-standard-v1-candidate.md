---
id: runtime.architecture.feature-module-standard-v1-candidate
type: architecture
status: active
owner: architecture
summary: Defines the scoped candidate adoption profile and activation boundary for Feature Module Standard v1.
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

# Feature Module Standard v1 candidate adoption

## Purpose

Agent Runtime is evaluating a scoped candidate profile of the immutable
`agent-teams.feature-module-standard` version `v1`. The central document is
owned by `agent-teams-ai/.github` at
`docs/architecture/feature-module-standard/v1.md`, Git blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`, with SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.

This is not a claim of repository-wide conformance or active scoped
conformance. The profile remains `candidate` while the checker reports
production violations.

## Ownership boundary

The machine-readable authority is
`architecture/feature-module-standard/candidate-profile.json`; its schema is
beside it. The candidate production scope contains only:

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
`pnpm test:feature-modules` for disposable conformance fixtures and
`pnpm architecture:feature-modules:candidate` for the stable current-tree
report. The fixture suite is blocking in `check` and `check:fast`; the
production candidate report is intentionally outside either gate. Its
candidate-only diagnostic allowance applies only to production policy
diagnostics; structural, profile, schema, scope, pin, authority, and active
status failures remain nonzero.

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

## Activation TODO and acceptance

The current report contains 52 diagnostics: six missing declared feature
entrypoints, 24 assembly deep imports, eight domain/application imports of
public transport contracts, two application imports of Node builtins, three
feature READMEs without declared owners, and nine package-level tests that must
move beside their scoped features. The estimated production cleanup is six new
feature entrypoint files, consolidation of 24 assembly import/re-export
statements, replacement of the eight forbidden contract dependencies with
domain models or application-owned ports, two builtin integrations moved
behind application-owned ports, three README ownership declarations, and nine
test relocations. The existing package export maps already satisfy the
candidate rule. That work belongs to a production cleanup lane.

Activation requires all of the following:

1. `pnpm test:feature-modules` passes.
2. `pnpm architecture:feature-modules:candidate` reports zero production
   diagnostics without exceptions, wildcarding, automatic widening, or scope
   changes.
3. An accepted ADR authorizes activation, candidate blockers become empty, and
   the profile records the exact passing fixture command plus zero-diagnostic
   candidate evidence.
4. A final integration change flips the profile from `candidate` to `active`
   and adds the active command to both `check` and `check:fast`.

Until all four conditions are reviewed and satisfied, diagnostics are a
candidate adoption report and must not be described as active conformance.
