---
id: runtime.architecture.consumer-module-standard-adoption
type: architecture
status: active
owner: architecture
summary: Declares the exact pending Consumer Module Standard scope and its blocking verification.
related:
  - ADR-0012
  - ADR-0015
code_anchors:
  - enforcement: required
    pattern: architecture/consumer-module-standard/profile.json
  - enforcement: required
    pattern: scripts/architecture/check-consumer-module-standard.mjs
---

# Consumer Module Standard adoption

## Purpose

Agent Runtime pins the Get Modular Consumer Module Standard at exact commit
`f1ec0152c34715395685b349844a7d1c18a2f015` and complete-document SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
ADR-0015 accepts this pin as pending governance only. Agent Runtime does not yet
claim an adopted Assembly composition.

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
- Pending status cannot be changed while Assembly package, declaration,
  binding, typed, parity, failure, lifecycle, and packed-consumer evidence is
  absent.
- The legacy entrypoint, dependency declaration, factory, two call sites, and
  exact ordered slot set must match the profile.
- Domain and application code cannot import Get Modular Core or Assembly.
- Both `check` and `check:fast` execute the rejecting fixtures followed by the
  blocking checker.
- A new caller of the legacy factory fails until the relationship is adopted or
  classified by a later accepted decision.

The final HTTP API is outside this recorded legacy factory. Its exact interface
must be classified from the integrated contract in the delivery that owns it.
