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
production candidate report is intentionally informational and is not in
either gate.

## Invariants

The profile binds the exact immutable central identity and cannot widen scope
automatically. It has no file-count baseline, Git-history comparison, mutable
grandfather allowlist, regex source parser, wildcard exception, or future-state
metadata. Any extension, deviation, or exception requires an accepted ADR,
owner, rationale, and deterministic review trigger.

The checker defaults production behavior into declared feature or assembly
ownership, parses supported import and re-export syntax with pinned
`oxc-parser`, and fails closed for parser errors and nonliteral loading. It
checks layer direction, curated public/internal entrypoints, cross-feature deep
imports, declared runtime and type edges, cycles, nonempty declared layers, and
undeclared shared/common/utils/module ownership. Public feature entrypoints may
expose only their own contracts. Declared feature edges must connect declared
features and must correspond to observed imports; unused edge declarations are
rejected as future-state permissions.

All local feature dependencies are denied unless they follow an allowed
same-feature layer direction or use a declared cross-feature edge through the
target feature's public entrypoint. Package assembly and feature entrypoint
files accept only import/re-export grammar, and path aliases cannot bypass
these checks. Empty, comments-only, and `export {}`-only layer files do not make
a declared layer substantive.

Layer direction is default-deny. Domain code is inward-only and cannot import
public transport contracts. Application code may depend on domain code and
application-owned ports or models, but it also cannot import public transport
contracts. Contracts, domain, and application layers cannot import external
packages or Node builtins; adapters and composition own those integrations.

## Activation TODO and acceptance

The current report contains 40 diagnostics: six missing declared feature
entrypoints, 24 assembly deep imports, eight domain/application imports of
public transport contracts, and two application imports of Node builtins. The
estimated production cleanup is six new feature entrypoint files,
consolidation of 24 assembly import/re-export statements, replacement of the
eight forbidden contract dependencies with domain models or application-owned
ports, and two builtin integrations moved behind application-owned ports. That
work belongs to a production cleanup lane.

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
