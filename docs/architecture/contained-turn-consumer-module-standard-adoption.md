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
`f1ec0152c34715395685b349844a7d1c18a2f015` and complete-document SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
ADR-0016 proposes only the contained-turn seven-port classification as pending.
It does not weaken or duplicate the active passive setup Assembly claim.

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
