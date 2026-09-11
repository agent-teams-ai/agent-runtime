---
id: ADR-0015
type: adr
status: accepted
owner: architecture
summary: Accepts the bounded passive setup Assembly construction contract without claiming delivered adoption.
---

# ADR-0015: Passive setup static Assembly adoption

Status: accepted

## Context

ADR-0008 accepted private embedded Runtime access using direct Pure DI.
Its retained L0 evidence and three exploratory benchmarks remain historical
HOLD results, not proof of a neutral composition problem. The owner accepts a
bounded static Assembly experiment for default passive setup under this later
decision. Acceptance authorizes implementation; it does not certify delivery.

## Decision

For default passive setup only, `createDefaultAgentRuntimeHost({ signal })`
becomes the single asynchronous production factory returning an
`AgentRuntimeHost`. Public Core compilation and Assembly preparation validate
one complete static profile before materialization. There is no production
selection switch, synchronous alternative bootstrap, or direct fallback.
`createAgentRuntimeHost(dependencies)` remains the internal synchronous final
leaf. An independent direct factory remains test-only; leaf bundle validation
continues to throw synchronously, while the default boundary rejects a Promise.

Seven cohesive handles represent security, installation discovery, Codex and
Claude configuration, Codex and Claude planners, and the Host root. Eight
required capability slots close both existing provider bundles; shared security
and discovery each materialize once. A missing trusted provider grant remains
`capability_unavailable`, not graph selection. Private parsers, readers, and
classifiers stay local to their feature factories.

Embedded Runtime owns only the outer composition adapter and construction
handoff. Owner-local features retain domain, application, authorization, and
port ownership. Core/Assembly imports stay in `composition.embedded-runtime`
under the existing strictClean source policy. ADR-0013's three-feature FMS
activation and checker remain unchanged; no whole-repository conformance is
accepted here. Meaningful new independently composed capabilities, alternative
implementations, and configurable cross-module relationships in the admitted
scope follow the consumer module standard, with exact accepted exceptions only.
Ordinary fixed helper dependencies do not become graph nodes.

Each attempt captures its own inputs and constructs fresh bindings. Compile or
prepare failure calls no product factory. Cancellation waits for pending
factory settlement; it never abandons work through an outer Promise race.
Before successful handoff the bootstrap owns the single created Host, including
an uncommitted root product, and awaits disposal exactly once on failed handoff.
After handoff the caller owns the unchanged Host lifetime; later startup abort
cannot dispose it. Factory-local acquisition failures remain factory-owned.
No universal resource manager, reflective cleanup, or new lifecycle abstraction
is admitted. Safe product diagnostics do not expose raw upstream errors,
cancellation reasons, paths, credentials, getters, or returned products.

### Narrow supersession and retained authority

This decision supersedes only ADR-0008's direct default-construction requirement
for this static passive slice. The current direct-reference name requirement
moves from `createDefaultAgentRuntimeHost` to the independent test-only direct
fixture. All access, capability, scope, detached-outcome, and Host invariants
remain in force. Host-custodied contained-turn composition remains direct under
its existing owner and is outside this adoption.

The historical L1 two-of-three promotion criterion is explicitly superseded
only as a prerequisite for this owner-authorized static slice. It remains a
gate for broader L1 platform adoption; L2-L5 remain no-go. No benchmark is
reclassified PASS, and no reduced-wiring or benefit claim is inferred. Separate
before/after measurements must record the actual benefit or lack of benefit.
Accepted ADR bytes, historical prompts, envelopes, and L0 evidence are immutable.

## Consequences

Production cutover is conditional on exact approved installable Core/Assembly
artifacts, packed consumer proof, independent direct parity, negative wiring
and boundary fixtures, cancellation/ownership checks, authenticated current
construction evidence, and exact integrated-source gates. The
[current adoption record](../architecture/get-modular-adoption.md) tracks these
requirements and the unresolved central standard pin. This decision does not
admit an unpublished workspace dependency or claim implemented adoption,
provider qualification, production readiness, or contained-turn migration.

Rollback replaces the release or reverts the adoption commit, preserving
already-published Host ownership. Failed construction never retries through a
direct production graph. Consumer standard authority complements FMS and local
product decisions; it cannot override security, ownership, or qualification.
