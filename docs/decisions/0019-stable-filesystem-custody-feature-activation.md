---
id: ADR-0019
type: adr
status: accepted
owner: architecture
summary: Activates the Filesystem Custody platform module as one cohesive Feature Module Standard v1 feature with a contracts-only public entry.
related:
  - ADR-0013
  - ADR-0017
  - ADR-0018
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: packages/platform/filesystem-custody/src/features/stable-filesystem-custody/README.md
---

# ADR-0019: Stable filesystem custody feature activation

Status: accepted

Date: 2026-09-10

## Context

ADR-0017 classified `packages/platform/filesystem-custody` as a `platform`
module and left it pending: its behavior sat directly in the `src` root, with no
feature boundary, no layer separation, and a single package entry that exposed
factories, error classes and Node-specific descriptor types together.

ADR-0013 requires a separate accepted decision for any scope extension, and
ADR-0017 requires every activation to carry its own accepted authority. This is
that authority for this one module.

## Decision

Activate `packages/platform/filesystem-custody/src` as a governed production
root with exactly one feature, `stable-filesystem-custody`, declaring the
`contracts` and `adapters` roles.

The feature stays undivided. Path lineage capture and comparison, opening a path
under a custody boundary, descriptor-relative mutation capability resolution,
no-replace directory publication, directory process locking, and the Darwin
native Host descriptor primitives all depend on the same qualified native
binding and the same descriptor identity rules. Splitting them would create
boundaries that cannot be exercised or replaced apart from each other.

`contracts` carries only portable shapes: path lineage and its component
identity, the custody boundary pair, the publication outcome, and the mutation
capability disposition. They name no Node type, including the ambient platform
union, which is spelled out locally so a consumer of the published declarations
needs no Node type definitions; an adapter asserts at compile time that the local
union stays equal to the runtime's own. The package public entry exposes these
contracts and nothing else.

Narrowing the public entry is a consumer-visible change. Every factory, error
class and Node-specific descriptor type now reaches consumers through
`./composition` only. The previous checkpoint moved every caller there first, so
no caller breaks at either step, but an external caller that reached for the
public entry's runtime surface would.

`adapters` carries the real Node and native implementation. The Node-specific
descriptor surface, `StableFilesystemHandle` and `StableFilesystemStats`, stays
there rather than in `contracts`, because a `Buffer` and `BigIntStats`
projection is an implementation surface and not a portable transport contract.
Production consumers reach it through the package `./composition` entry, which
is the same division Agent Execution and Provider Access already use.

No `domain` or `application` layer is created. The feature carries no invariant
independent of the platform it mediates, and an empty layer would be ceremony
that the standard explicitly does not require.

The qualified native artifact keeps its existing emitted path at the package
`dist` root, and exactly one module resolves it for the three loaders that need
it. Relocating the C and header sources under the feature adapters is a separate
delivery, because the provider candidate qualification pins the current source
and output paths.

## Consequences

Filesystem Custody is continuously checked against the pinned standard identity:
its layer direction, curated entrypoints, README ownership, test placement and
curated package export map all now fail closed. Its tests are owned by the
feature, and one package test qualifies the packed archive and the split between
the public and composition entries.

Descriptor identity, path lineage comparison, close-once handling, publication
ambiguity reporting and explicit platform refusal are unchanged. This decision
adds no capability, changes no security boundary, and makes no qualification
claim about any provider or platform.

Embedded Runtime, Runtime Configuration and Runtime Security remain pending
under ADR-0017. Their activation needs its own accepted decision.
