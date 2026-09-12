---
id: ADR-0017
type: adr
status: accepted
owner: architecture
summary: Classifies every production module by its real role, keeps four of them explicitly pending, and rejects unclassified production packages.
related:
  - ADR-0005
  - ADR-0008
  - ADR-0013
code_anchors:
  - enforcement: required
    pattern: architecture/feature-module-standard/candidate-profile.json
  - enforcement: required
    pattern: scripts/architecture/check-feature-modules.mjs
---

# ADR-0017: Feature Module Standard production scope roles

Status: accepted

Date: 2026-09-10

## Context

ADR-0013 accepted Feature Module Standard v1 for exactly three features inside
Agent Execution and Provider Access, and required a separate accepted decision
for any later scope extension. That decision deliberately left the remaining
production packages unnamed: Embedded Runtime, Runtime Configuration, Runtime
Security, and Filesystem Custody were only listed as out of scope prose.

Two consequences follow from that shape. The profile could not describe what
those packages actually are, so a reader could not tell an intentionally
excluded module from a forgotten one. And a newly created production package
was invisible to the gate, because the checker only ever walked the two
declared production roots.

ADR-0005 fixes the identities of the four bounded contexts. ADR-0008 owns the
Embedded Runtime host application entrypoint. No accepted decision owned the
Filesystem Custody platform package. ADR-0013 names it only as out of scope,
and ADR-0005 does not mention it, even though it exists at
`packages/platform/filesystem-custody` and is consumed by Agent Execution.

## Decision

Each production module in the reviewed workspace containers
`packages/apps`, `packages/contexts`, and `packages/platform` is classified in
`architecture/feature-module-standard/candidate-profile.json` by exactly one of
three roles:

- `bounded-context` for Agent Execution, Provider Access, Runtime
  Configuration, and Runtime Security, whose identities remain owned by
  ADR-0005;
- `host-app` for Embedded Runtime, whose private access entrypoint remains
  owned by ADR-0008;
- `platform` for Filesystem Custody at `packages/platform/filesystem-custody`
  with the private package name `@agent-teams/filesystem-custody`. This
  decision is that module's owner document. Changing its path, package name, or
  role requires a new accepted decision.

Roles are a local adoption mapping. They record what each module already is;
they are not a claim about the content of the immutable central standard.

Each classified module also declares its own curated package export set, drawn
from the two recognized assembly entries `.` and `./composition`. The set is a
per-module fact about the current manifest, not a consequence of the role, and a
pending module's declaration is compared with its real manifest so it cannot
record a future intention. A module carries an adoption state of `active` or
`pending`, and an `active` module must name the accepted decision that
authorized its activation. Agent Execution and Provider
Access remain `active` under ADR-0013 with their three existing features and
unchanged governed roots. Embedded Runtime, Runtime Configuration, Runtime
Security, and Filesystem Custody are `pending`; they must stay excluded roots
and are not checked as feature modules until their own reviewed activation.

A production package that physically exists inside a declared workspace
container and is not classified fails the gate with `FM_UNCLASSIFIED_MODULE`.
A classified module whose manifest does not carry the exact declared package
name, role, owner document, and curated export keys fails the gate. Active
modules are verified through the full package policy; pending modules are
verified against their manifest alone, because their sources stay outside the
checked tree. Experiments and tooling stay
outside the containers and remain excluded exactly as before.

This decision does not widen the checked tree. Activating any pending module is
a separate reviewed change that moves its adoption state, adds its features,
adds its source root, removes its exclusion, and carries its own accepted
authority. Editing the profile alone cannot do it, because the reviewed
registry in `scripts/architecture/feature-module-profile.mjs` must agree.

## Consequences

The profile now answers what every production module is, not only which two are
checked. A new package under a declared container is rejected until someone
decides its role, so silent production surface growth is no longer possible.

Filesystem Custody gains an accepted owner document for the first time, which
also gives its future scaffolding target a legitimate authority reference.

No feature, layer, export, runtime behavior, security boundary, or
qualification claim changes here. The active conformance evidence still proves
only the three features accepted by ADR-0013.
