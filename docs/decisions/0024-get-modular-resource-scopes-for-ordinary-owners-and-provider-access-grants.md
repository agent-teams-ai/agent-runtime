---
id: ADR-0024
type: adr
status: proposed
owner: architecture
summary: Admits @get-modular/resources 0.1.0 for ordinary Host owners and Provider Access grants, and @get-modular/conformance 0.1.0 as a development-only test dependency.
related:
  - ADR-0015
  - ADR-0016
  - ADR-0090
---

# ADR-0024: Get Modular resource scopes for ordinary owners and Provider Access grants

Status: proposed

Date: 2026-10-10

## Context

Train 0.3.0 adoption (AR-1a, AR-1b) moved the ordinary and passive Embedded
Runtime composition onto Get Modular Core and Assembly 0.3.0. The ordinary Host
still releases its resource owners (Runtime Security, Provider Access, Codex)
and its journal through a manual cleanup list whose reverse walk stops at the
first failure, so one failing release blocks every release behind it.

ADR-0015 keeps Core/Assembly imports in `composition.embedded-runtime`, and the
source policy admits only Core and Assembly there. No accepted decision admits `@get-modular/resources` or
`@get-modular/conformance`.

## Decision

Embedded Runtime consumes `@get-modular/resources` 0.1.0 together with Core and
Assembly 0.3.0: exact catalog version, retained archive, one installed copy.

Ordinary cleanup uses one scope tree per ordinary Host: an `ordinary-host` scope
holds the observation journal and a child `owners` scope; `owners` is the run
scope of the three owning modules, Runtime Security, Provider Access and Codex,
which are bound with `scoped()`. Owners release in reverse construction order and continue past a
failed owner. The journal closes only after the owners report a complete close.
The Host drain, including the ADR-0090 ordinary turn owner handoff, must
succeed before any owner is released. The turn and the raw Host stay outside the
scopes and remain closed by the Host drain.

`composition.provider-access.ordinary` may use resources for per-grant child
scopes with concurrent order. Domain, application and contracts layers never
import it.

`@get-modular/conformance` 0.1.0 is admitted as a development-only dependency of
the test code of the Agent Runtime packages that guard handles or smoke-test
composition roots (Embedded Runtime and filesystem-custody). Production code
never imports it, and the Foundation development-only assertion keeps it out of
runtime dependencies. It is pinned by exact catalog version and lock integrity,
with no retained archive. AR-1c adds it to Embedded Runtime only; a later change adds
it to filesystem-custody under this same decision.

This extends the ADR-0015 import rule by exactly these permissions.

ADR-0015's statement that no universal resource manager, reflective cleanup or new
lifecycle abstraction is admitted keeps applying to the passive slice. For the
ordinary Host owners and Provider Access grants named here, this decision narrowly
supersedes it: each owner's composition code registers its own cleanup by name in a
Host-owned scope tree, without reflection, discovery or lifecycle hooks, and close
policy stays in the Host.

ADR-0015 and ADR-0090 bytes stay unchanged. Contained-turn and Darwin deployment keep their
own cleanup until ADR-0016 is resolved.

Root deadline: none in this train. Releasing the resource owners keeps today's
behavior, because the owners bound their own I/O. A deadline (escalate, then
abandon) is added when an owner's release can block without its own bound, or on
owner request; prepared values are grace 5000 ms and abandon 5000 ms.

## Consequences

- Debt paths name implementation IDs, so a failed release is traceable to its
  module.
- A failing Provider Access release no longer blocks Runtime Security and Codex
  release; failed owners are retried and successful releases are not repeated.
- `complete: true` from a scope close means every cleanup returned without
  throwing; it is not proof of physical release.
- The conformance status rows closed by AR-1c and AR-2 in the Get Modular
  adoption document can move to their final state.
- The shared "inner complete, then outer" policy stays about 15 lines of Host
  policy in Embedded Runtime; it is revisited when a second Host needs the same
  helper.
