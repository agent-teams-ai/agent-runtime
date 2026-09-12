---
id: ADR-0018
type: adr
status: accepted
owner: architecture
summary: Requires a declared, acyclic module edge and a curated assembly entry for every dependency between governed production modules.
related:
  - ADR-0013
  - ADR-0017
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: scripts/architecture/check-feature-modules.mjs
  - enforcement: required
    pattern: scripts/architecture/feature-module-edges.mjs
---

# ADR-0018: Declared production module edges

Status: accepted

Date: 2026-09-10

## Context

ADR-0013 governs two bounded contexts that do not consume each other, so the
checker never had to describe a dependency between two governed modules. Every
local import that left a feature was simply an undeclared local dependency.

That is not a tenable rule once a platform module is governed. Filesystem
Custody exists to be consumed: Agent Execution, Runtime Configuration and
Runtime Security all depend on it. Under the previous behavior, activating it
would have turned every one of those legitimate dependencies into a diagnostic,
which in practice means a platform module could never be activated while
anything used it.

The alternative of silently permitting any cross-module import would lose the
property the standard exists for. A module boundary that anyone may reach into
from anywhere is not a boundary.

## Decision

A dependency between two active governed production modules is allowed only when
all of the following hold, and is rejected otherwise. A pending module's sources
are outside the checked tree, so a dependency on one is not governed here at all;
it is governed by the module's own activation, which this standard requires
before the module may be consumed as a governed boundary:

- the profile declares a `moduleEdges` entry `from -> to` carrying the observed
  dependency kind, `runtime` or `type`, where both ends name declared production
  modules, are distinct, and are both active;
- the import resolves to one of the target module's declared curated assembly
  entries. Reaching any other path inside the target module, including a path
  inside one of its features, is rejected as `FM_MODULE_DEEP_IMPORT`;
- the importing file is the module's own `composition.ts` assembly file, or sits
  in the `adapters` or `composition` layer of its feature. The public package
  entry exposes only the module's own contracts, so it may not carry another
  module's surface, and neither may a feature entrypoint, a `contracts`, a
  `domain` or an `application` layer.

Declared module edges follow the same discipline as feature edges. An edge that
is declared but never observed is rejected as future-state permission, and
observed module edges are checked for runtime and type cycles.

Cross-module consumption is therefore explicit in the profile, kind-accurate,
acyclic, restricted to curated entries, and confined to the layers that own
outward integration.

## Consequences

A platform module can be activated and consumed without weakening the boundary.
The profile now states which modules depend on which, so a reader does not have
to infer the production dependency graph from imports.

Adding a new cross-module dependency becomes a reviewed profile change rather
than an import. Removing the last consumer of an edge makes the stale
declaration fail, so the declared graph cannot drift away from the real one.

No module is activated by this decision and no runtime behavior changes.
`moduleEdges` is empty until a delivery that actually needs an edge declares it.

One feature-level rule does change, in the same direction: a feature edge is now
explicitly a relationship inside one module. Declaring one between features of
different modules is rejected, because the cross-module rule decides such an
import first and the feature declaration could never be observed. The repository
profile declares no feature edges, so nothing currently relies on the previous,
unreachable permission.
