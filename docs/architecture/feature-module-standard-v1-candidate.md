---
id: runtime.architecture.feature-module-standard-v1-candidate
type: architecture
status: active
owner: architecture
summary: Defines scoped active conformance and mandatory standards for every new production feature.
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

## New production features

Every new production feature MUST strictly follow organization Feature Module
Standard v1, including in currently excluded packages. This is a prospective
repository-wide authoring obligation, separate from the existing active
conformance claim for exactly three features in two roots under ADR-0013.
Existing exclusions describe existing unqualified code; they do not permit new
nonconforming capabilities. The authoring obligation does not itself widen the
active profile or certify existing non-adopted behavior.

The obligation covers real new capabilities in every context, platform,
integration, SDK, and testing module, and application-owned behavior. Application
executables should remain thin composition roots, without absorbing behavior
owned by a production module. Adding a capability inside an existing legacy
feature, function, or file does not evade this rule. Review semantic behavior,
not just new directories. Ordinary helpers and behavior-preserving refactors
are not automatically new features or composition graph nodes.

Before implementation, record the semantic owner, module architectural role,
feature boundary, and the current standard ID, version, canonical path and
content digest from the identity above. Identify concrete topology and scope
changes, dependency edges, public surfaces, and compatibility decisions. Compare
the consumer pin with the canonical standard. Identity changes require explicit
review and retained pin/delta evidence before adoption.

Use the smallest substantive layers appropriate to the role. Domain invariants
and domain types stay in domain; transport-independent inputs and outputs are
application models; external contracts stay outer. Domain and application must
not import transport or SDK DTOs. Preserve feature-owned ports, adapters, tests,
and curated entrypoints. Do not invent ceremonial aggregates, empty layers,
one feature per class, or a new module merely to isolate a folder.

The same feature delivery MUST adopt the feature in the appropriate local
profile and topology, with actual blocking enforcement and disposable positive
and rejecting fixtures in both fast and full gates. Evidence must cover the
adopted role and ownership, allowed layers and entrypoints, and rejection of
unowned production behavior, deep imports, undeclared edges or cycles, empty
layers, and undeclared modules or exceptions. Include semantic review because
static discovery alone cannot detect every capability hidden in legacy code.

The existing three-feature checker does not automatically scan excluded roots.
Its reviewed feature identities and roots are hardcoded. A new feature outside
that scope, or one requiring checker evolution, needs explicit scoped adoption
through a new or superseding accepted ADR, with exact paths, ownership,
compatibility decisions, and deterministic evidence. Preserve ADR-0013 bytes
and its historical scope; merely appending to its fixed profile is insufficient.
Implement the necessary checker and gate changes in that feature delivery.
Do not suppress diagnostics, widen blanket exclusions, grandfather new code, or
use green CI for the old scope as proof that the new feature conforms.

A new feature MUST NOT be called implemented or merge-ready until its declared
conformance gate passes for the actual delivered scope. Record exact commands,
results, fixtures, authority and profile identities, and remaining limitations.
If adoption or enforcement is unproven, record the exact outstanding work and
keep the feature pending; pending is not permission to ship a violating feature.
Dependencies on existing non-adopted behavior require narrow explicit boundaries,
with honest ownership and scope evidence. They do not require migrating every
legacy capability, and cannot exempt the new capability from conformance.

For meaningful composition boundaries, also read the canonical Get Modular
[Consumer Module Standard](https://github.com/agent-teams-ai/get-modular/blob/03a7df64bc5e9939f7b51694a80a7f3d61453f98/docs/architecture/common-assembly.md#consumer-module-standard).
Its composition requirements apply inside an explicitly accepted Host scope;
this authoring rule does not mandate installing Assembly everywhere. Review
current upstream against the consumer pin before adoption or boundary changes,
retain exact revision/digest and delta evidence, and update affected profiles,
guidance and rejecting tests together. Keep adoption pending until any required
migration and enforcement are complete. Meaningful boundaries must be adopted
or explicitly classified under that contract; fixed feature-local helpers remain
static imports and typed factories.

At the 2026-09-09 review, Runtime main `245dcb05206b53f7727786d5a94236350e5ca194`
had no Consumer Module Standard/Assembly adoption pin. The linked Get Modular
revision was reviewed with whole-document SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`;
the central Feature Module Standard v1 matched the existing pin above. These are
review facts, not Assembly adoption. Initial composition adoption must record
the absence of a prior pin and accept the reviewed revision through a scoped ADR,
consumer profile and actual conformance evidence.

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
