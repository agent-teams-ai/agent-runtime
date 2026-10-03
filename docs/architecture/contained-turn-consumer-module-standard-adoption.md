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
This separate contained-turn profile pins the same reviewed standard at commit
`9c722ceff4ede307d06d7a4b63fdebe615f54c53` and complete-document SHA-256
`33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
ADR-0016 proposes only the contained-turn seven-port classification as pending.
It does not weaken or duplicate the active passive setup Assembly claim.

The merged chronology retains two authentic review branches from the A3 pin
`ac49bb3374946330ec820591f8195a22d2c90900`, document SHA-256
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`:
the PR's [dynamic Host review](get-modular-adoption.md#reviewed-optional-dynamic-host-standard-pin-migration)
and subsequent zero-byte-delta pin review, and main's
[creation-cleanup review](get-modular-adoption.md#current-candidate-only-standard-pin-review).
Both select the shared exact `9c722` pin and complete-document bytes. The A3
reciprocal review and both exact deltas remain independently enforced history.
This does not adopt contained-turn or certify dynamic scope; G1 remains on hold,
passive and ordinary adoption stay active, and SDK external authority is pending.
Existing Host owners retain cleanup authority. The checker compares both current
profile identities, hashes the retained bytes, and authenticates both histories.
Fresh paired capture must bind the resolved SOURCE; historical reports remain
byte-identical on both branches.
Current paired migration evidence remains outstanding.

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
