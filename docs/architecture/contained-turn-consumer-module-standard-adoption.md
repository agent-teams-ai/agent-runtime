---
id: runtime.architecture.contained-turn-consumer-module-standard-adoption
type: architecture
status: active
owner: architecture
summary: Classifies the contained-turn seven-port boundary pending a separately accepted Assembly migration.
related:
  - ADR-0012
  - ADR-0015
  - ADR-0016
code_anchors:
  - enforcement: required
    pattern: architecture/consumer-module-standard/contained-turn-profile.json
  - enforcement: required
    pattern: scripts/architecture/check-consumer-module-standard.mjs
---

# Contained-turn Consumer Module Standard adoption

## Purpose

Agent Runtime's passive setup adopts the Get Modular Consumer Module Standard
under ADR-0015 and the active `architecture/get-modular/consumer-profile.json`.
Both profiles pin the independently retrieved merged main commit
`b70ba39304ac71964175c42a77309406a7c30ca2`, complete-document SHA-256
`11a389b223506dc303fa986a7a37350b847013d85beb2de9d74cb8c97363e824`.
The [current review](../../architecture/get-modular/evidence/capability-map-cms-pin-review.json)
retains the full delta, exact document bytes and official main retrieval identity.
Pin verification does not establish new adoption or production qualification.
ADR-0016 proposes only the contained-turn seven-port classification as pending.
It does not weaken or duplicate the active passive setup Assembly claim.

The descriptor-union recipe preserves complete feature maps and their early
conflict checks; existing valid manual maps remain supported. This migration
changes no production map, declaration, slot or lifecycle owner. Observation
remains unselected, so the included load-cleanup guidance adds no contained-turn
capability. The seven-port seam remains pending under its existing authority.

The merged chronology retains two authentic review branches from the A3 pin
`ac49bb3374946330ec820591f8195a22d2c90900`, document SHA-256
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`:
the PR's [dynamic Host review](get-modular-adoption.md#reviewed-optional-dynamic-host-standard-pin-migration)
and subsequent zero-byte-delta pin review, and main's
[creation-cleanup review](get-modular-adoption.md#historical-candidate-only-standard-pin-review).
Both historically select the shared exact `9c722` pin and complete-document bytes,
now retained separately as `consumer-module-standard-9c722ce.md`. The A3
reciprocal review and both exact deltas remain independently enforced history.
This does not adopt contained-turn or certify dynamic scope; G1 remains on hold,
passive and ordinary adoption stay active, and SDK external authority is pending.
Existing Host owners retain cleanup authority. The checker compares both current
profile identities, hashes the retained bytes, and authenticates both histories.
Fresh paired capture must bind the resolved SOURCE; historical reports remain
byte-identical on both branches.
Current paired migration evidence remains outstanding.

The [reviewed successor checkpoint](get-modular-adoption.md#reviewed-smart-ci-prerequisite-successor-checkpoint)
advances both live identities together and explicitly bridges this historical
head. Its normative document delta does not change consumer behavior or adoption.
Passive CI helpers require no descriptor, resource, run-input or lifecycle scope.
Successor-wide production conformance is not established; the current adoption
record lists the exact declaration, namespace, implementation-ID and conformance
gaps without changing production wiring. Contained-turn remains pending.

## Ownership boundary

The governed production roots are Embedded Runtime and Agent Execution. The
only classified relationship is the existing Host-owned direct Pure DI call
from `contained-turn-feature-composition.ts` to the contained-turn feature
factory. ADR-0012 owns its exact seven dependencies. Feature-local parsers,
mappers, DTOs, helpers, and fixed factories remain implementation details, not
separate graph nodes.

The profile records zero adopted boundaries and one legacy boundary with status
`not-adopted`. It records no exceptions. Provider Access and Runtime Security
remain consumer-owned ports at the seven-port seam; this profile does not move
their fact ownership.

## Invariants

- The central document and organization FMS identities are immutable pins.
- Pending status cannot be changed until a separately accepted contained-turn
  migration supplies its own declaration, binding, parity, failure, lifecycle,
  and packed-consumer evidence.
- The legacy entrypoint, dependency declaration, factory, two call sites, and
  exact ordered slot set must match the profile.
- Domain and application code cannot import Get Modular Core or Assembly.
- Both `check` and `check:fast` execute the rejecting fixtures followed by the
  blocking checker.
- A new caller of the legacy factory fails until the relationship is adopted or
  classified by a later accepted decision.

The final HTTP API is outside this recorded legacy factory. Its exact interface
must be classified from the integrated contract in the delivery that owns it.
