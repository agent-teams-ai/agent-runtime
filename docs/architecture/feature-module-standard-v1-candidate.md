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
  - ADR-0017
  - ADR-0018
  - ADR-0019
  - ADR-0020
  - ADR-0021
  - ADR-0022
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

This is scoped active conformance for exactly the six named features listed
below. It is not a claim of repository-wide conformance, and no unlisted package,
application, feature, experiment, or bounded context is included.

ADR-0017 additionally classifies every production module in the reviewed
workspace containers by its real role, so the profile describes what each module
is even while three of the six are checked.

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

The existing three-feature checker does not inspect behavior inside excluded
roots. Its reviewed feature identities and roots are hardcoded. It does detect a
new production package in a declared workspace container and rejects it until a
reviewed change classifies it, but classification is not conformance. A new
feature outside
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
- `packages/contexts/runtime-configuration/src/**`;
- `packages/contexts/runtime-security/src/**`;
- `packages/platform/filesystem-custody/src/**`;
- the package assembly files `src/index.ts` and `src/composition.ts` in those
  five packages;
- the features `runtime-installation-discovery`, `contained-agent-turn`,
  `contained-turn-access`, `stable-filesystem-custody`,
  `codex-configuration-inspection`, `claude-code-configuration-inspection`,
  `contained-turn-dispatch-authority`, `contained-turn-egress`,
  `provider-process-egress-authorization`, and
  `setup-source-inspection-authorization`.

Embedded Runtime, Module Kit,
experiments, and tooling other than this checker are explicitly out of scope. Foundation supplies package-level dependency evidence only; it
does not implement or prove this feature policy.

## Production module classification

The profile classifies every module under `packages/apps`, `packages/contexts`,
and `packages/platform` with exactly one role and one adoption state:

| Module | Role | Owner document | Adoption |
| --- | --- | --- | --- |
| Agent Execution | `bounded-context` | ADR-0005 | active under ADR-0013 |
| Provider Access | `bounded-context` | ADR-0005 | active under ADR-0013 |
| Runtime Configuration | `bounded-context` | ADR-0005 | active under ADR-0020 |
| Runtime Security | `bounded-context` | ADR-0005 | active under ADR-0021 |
| Embedded Runtime | `host-app` | ADR-0008 | pending |
| Filesystem Custody | `platform` | ADR-0017 | active under ADR-0019 |

All six modules expose `.` and `./composition` today. The set is a per-module
fact rather than a consequence of the role, which is what let Filesystem Custody
gain its composition entry and then its activation without the rule changing.

Each module declares its own curated export set from the two recognized assembly
entries `.` and `./composition`, matching what its manifest exposes today. Every
pending module stays an excluded root and is not checked as a feature module,
but its declared package name, role, owner document and curated export keys are
still compared with its real manifest, so the classification cannot drift into a
future-state promise.

## Dependencies between production modules

ADR-0018 governs every dependency between two active governed modules. The
profile declares it as a `moduleEdges` entry with its exact kind, `runtime` or
`type`, and both ends must be declared, distinct and active. A dependency on a
pending module is not governed by this rule, because a pending module's sources
stay outside the checked tree; activation is what brings it under the rule. The
import must resolve to one of the target module's curated assembly entries; any
other path inside the target, including a path inside one of its features, is
rejected as `FM_MODULE_DEEP_IMPORT`. Only the importing module's own
`composition.ts` or a feature's `adapters` or `composition` layer may hold such
an import: the public package entry still exposes only its own contracts.

A feature edge is correspondingly a relationship inside one module. Declaring one
between features of different modules is rejected.

Declared module edges follow the same discipline as feature edges: an unobserved
declaration is rejected as future-state permission, and observed edges are
checked for runtime and type cycles.

A production package that exists inside one of those containers and is not
classified fails the gate with `FM_UNCLASSIFIED_MODULE`. Activating a pending
module is a separate reviewed change to both the profile and the reviewed
registry in `scripts/architecture/feature-module-profile.mjs`, with its own
accepted authority; a profile edit alone cannot widen the checked tree.

## Outstanding work per pending module

Recorded here so a partially migrated module reads as transit rather than as a
contradiction. None of this is a conformance claim, and no gate asserts any of it.

Runtime Configuration is active under ADR-0020. Its two features,
`codex-configuration-inspection` and `claude-code-configuration-inspection`,
are continuously checked.

Runtime Security is active under ADR-0021. Its four features,
`contained-turn-dispatch-authority`, `contained-turn-egress`,
`provider-process-egress-authorization`, and
`setup-source-inspection-authorization`, are continuously checked. The remaining
pending module is:

Embedded Runtime is the host application. Its activation waited on the
accepted asynchronous setup assembly work, which has since landed. The setup
view's Claude Code and Codex reference-digest computation is now behind an
outbound `OpaqueReferenceDigest` port with a Host adapter, so
`features/setup-inspection-planning/build-claude-code-setup-view.ts` and
`features/setup-inspection-planning/build-codex-setup-view.ts` no longer import
`node:crypto` directly, and the package boundary now rejects that import from
unowned application files. Runtime-access coordination now lives under
`src/features/contained-turn-runtime-access/` with curated `index.ts` /
`internal.ts` entrypoints. Public runtime-access DTOs live in that feature as
`runtime-access.ts`; the package root and Host composition re-export them, so
callers do not import a leftover `src/contracts/` tree. Host composition still
re-exports the feature runtime entry from
`src/composition/contained-turn-runtime-access.ts`, so existing composition
imports keep working. The implementation is not yet an inward `application/`
layer: it still imports Host composition helpers, so it stays at the feature
root rather than under `application/`. HTTP Provider Access now lives under
`src/features/contained-turn-http-provider-access/` with curated `index.ts` /
`internal.ts` entrypoints. Host composition re-exports that feature entry from
`src/composition/contained-turn-http-provider-access.ts`, so existing
composition and test imports keep working. The implementation stays at the
feature root rather than under `application/`: it still imports Agent
Execution composition types, which L0 treats as an inward leak from
`application/`. Provider Access current-authority selection now lives under
`src/features/contained-turn-current-authority/` and the Runtime Security HTTP
binding under `src/features/contained-turn-http-runtime-security/`, each with
curated `index.ts` / `internal.ts` entrypoints. Host composition re-exports
those feature entries from the matching `src/composition/` files, so existing
composition and test imports keep working. Both implementations stay at the
feature root rather than under `application/`: they still import Agent
Execution composition types (and Runtime Security composition types for the
HTTP binding), which L0 treats as an inward leak from `application/`. External
input/output validation now lives under
`src/features/contained-turn-runtime-validation/` with curated `index.ts` /
`internal.ts` entrypoints. Host composition re-exports that feature entry from
`src/composition/contained-turn-runtime-validation.ts`, so existing composition
and test imports keep working. The implementation stays at the feature root
rather than under `application/`: it still imports Host composition helpers,
which L0 treats as an inward leak from `application/`. HTTP egress owners,
authorities and upstream now live under
`src/features/contained-turn-current-egress-owners/`,
`src/features/contained-turn-http-egress-authorities/` and
`src/features/contained-turn-http-egress-upstream/`, each with curated
`index.ts` / `internal.ts` entrypoints. Host composition re-exports those
feature entries from the matching `src/composition/` files, so existing
composition and test imports keep working. The implementations stay at the
feature root rather than under `application/`: they still import Agent
Execution, Provider Access and Runtime Security composition types, which L0
treats as an inward leak from `application/`. Access authority, cancellation
proof and construction-failure cleanup now live under
`src/features/contained-turn-access-authority/`,
`src/features/contained-turn-cancellation-proof/` and
`src/features/contained-turn-construction-failure/`, each with curated
`index.ts` / `internal.ts` entrypoints. Host composition re-exports those
feature entries from the matching `src/composition/` files, so existing
composition and test imports keep working. The implementations stay at the
feature root rather than under `application/`: cancellation proof still
imports Host composition helpers, which L0 treats as an inward leak from
`application/`. Darwin contained-turn authority and deployment now live under
`src/features/darwin-contained-turn-authority/` and
`src/features/darwin-contained-turn-deployment/`, each with curated
`index.ts` / `internal.ts` entrypoints. Host composition re-exports those
feature entries from the matching `src/composition/` files, so existing
composition and test imports keep working. The implementations stay at the
feature root rather than under `application/`: they still import Host
composition helpers, which L0 treats as an inward leak from
`application/`. The Linux Codex Node recipe now
lives under `src/features/linux-codex-node-recipe/` with curated `index.ts` /
`internal.ts` entrypoints. Host composition re-exports that feature entry from
`src/composition/linux-codex-node-recipe.ts` and
`src/composition/linux-codex-node-recipe-consumption.ts`, so existing
composition and test imports keep working. The implementation stays at the
feature root rather than under `application/`: it still imports Host
composition deployment types, which L0 treats as an inward leak from
`application/`. Linux Codex contained-turn owner, deployment authority, and
deployment resources now live under `src/features/linux-codex-deployment/`
with curated `index.ts` / `internal.ts` entrypoints. Host composition
re-exports those feature entries from
`src/composition/linux-codex-contained-turn-owner.ts`,
`src/composition/linux-codex-deployment-authority.ts`, and
`src/composition/linux-codex-deployment.ts`, so existing composition and test
imports keep working. The implementations stay at the feature root rather
than under `application/`: they still import Host composition helpers or
Agent Execution / Provider Access / Runtime Security composition types, which
L0 treats as an inward leak from `application/`. Linux route binding, product
route qualification, provider selection, access authority, and cancellation
proof now live under matching `src/features/` directories with curated
`index.ts` / `internal.ts` entrypoints. Host composition re-exports those
feature entries from the matching `src/composition/` files, so existing
composition and test imports keep working. The implementations stay at the
feature root rather than under `application/`: they still import Host
composition helpers or Agent Execution / Provider Access composition types,
which L0 treats as an inward leak from `application/`. Authority binding,
construction-failure cleanup, composition observation types, operation refs,
and owner-contract errors now live under matching `src/features/` directories
with curated `index.ts` / `internal.ts` entrypoints. Host composition
re-exports those feature entries from the matching `src/composition/` files,
so existing composition and test imports keep working. The implementations
stay at the feature root rather than under `application/`: they still import
Host composition helpers, which L0 treats as an inward leak from
`application/`. Trusted runtime-access scope copying now lives under
`src/features/trusted-runtime-access-scope/` with curated `index.ts` /
`internal.ts` entrypoints. Host composition re-exports that feature from
`src/composition/trusted-runtime-access-scope.ts`, so existing composition
and test imports keep working. The implementation stays at the feature root
rather than under `application/`: it still imports Host composition helpers
and application scope types, which L0 treats as an inward leak from
`application/`. Claude Code and Codex setup-inspection planners plus the
opaque-reference digest now live under
`src/features/setup-inspection-planning/` with curated `index.ts` /
`internal.ts` entrypoints. Host composition re-exports those feature entries
from the matching `src/composition/` files, so existing composition and test
imports keep working. The implementations stay at the feature root rather
than under `application/`: they still import application ports, which L0
treats as an inward leak from `application/`. Process lifecycle,
readiness and rollback stay in composition. Host tests that
previously imported unpublished Agent Execution, Provider Access, and Runtime
Security `dist/` and `tests/` package subpaths now use the curated
`./composition` export when the symbol is public, or Host-local
`tests/support/external/` copies of unpublished fixtures. Foundation
`packageExports` claims for those three packages now match the curated `.` and
`./composition` maps. Packed-consumer Agent Execution and Provider Access
public composition types no longer mention `pg`; callers pass a structurally
compatible pool. Runtime Security package assembly now reaches its four
features through curated `index.ts` / `internal.ts` entrypoints; the contained-turn
egress gateway factory lives in the feature composition root so package
`composition.ts` is import/re-export only. The module stays pending. Each Host
feature now declares accepted README metadata owned by `@agent-teams/embedded-runtime`
and ADR-0008. Activating it still requires `tests/features/` placement, an
explicit extra Host `src/composition/*.ts` `assemblyFiles` list, and a
separate accepted activation ADR. ADR-0022 records the host-app extra
composition assembly grammar so those remaining steps do not have to change the
curated `index.ts` / `composition.ts` import/re-export rule.

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
map entries. Package-owned tests under `tests/package/` may load repository
architecture tooling at `scripts/architecture/*.mjs` in two forms: a
string-literal relative specifier whose canonical path is that directory, or a
dynamic `import()` whose only string literal is that repo-relative path. The
checker classifies both as external tooling. The dynamic form is the
Foundation-compatible load: a relative specifier into the root package is a
cross-package edge and a runtime cycle, while a computed `import()` stays a
declared dynamic runtime reference. Feature tests, production sources,
nonliteral loaders without that exact literal, helpers outside `tests/package/`,
and relative paths that canonicalize outside that directory still fail closed.
Public feature entrypoints may expose only their own contracts.
Public, internal, and package assembly entrypoints reject wildcard re-exports.
Declared feature edges must connect declared features and must correspond to
observed imports; unused edge declarations are rejected as future-state
permissions.

All local feature dependencies are denied unless they follow an allowed
same-feature layer direction or use a declared cross-feature edge through the
target feature's public entrypoint. Curated package assembly files (`index.ts`
and `composition.ts`) and feature entrypoint files accept only import/re-export
grammar. An active host-app may list additional explicit
`src/composition/*.ts` assembly files; those files may contain behavior, import
sibling host composition assembly files, import curated feature entrypoints, and
import Node or external modules. Deep feature imports still fail closed.
Bounded-context and platform modules cannot list extra assembly files. The live
profile does not list extra Host composition files while Embedded Runtime stays
pending. Configured TypeScript and package
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

ADR-0013, ADR-0017, ADR-0018, ADR-0019, ADR-0020, ADR-0021 and ADR-0022 are accepted at their exact governed
paths and are pinned in the immutable accepted-decision registry by the digest
Foundation computes over their accepted bytes and metadata. The profile is
`active`, has no blockers, binds its profile-wide activation authority to
ADR-0013, names the two ownership decisions, records each module's own activation
authority on the module, records an empty exact governed-record set, and records
these commands as evidence:

- fixture evidence: `pnpm test:feature-modules`;
- zero-diagnostic production evidence: `pnpm architecture:feature-modules:candidate`;
- blocking active gate: `pnpm architecture:feature-modules:active`.

This evidence proves conformance only for `runtime-installation-discovery`,
`contained-agent-turn`, `contained-turn-access`, `stable-filesystem-custody`,
`codex-configuration-inspection`, `claude-code-configuration-inspection`,
`contained-turn-dispatch-authority`, `contained-turn-egress`,
`provider-process-egress-authorization`, and
`setup-source-inspection-authorization` within the five declared production
roots and assembly files. It does not prove repository-wide Feature Module
Standard conformance: Embedded Runtime remains pending.
