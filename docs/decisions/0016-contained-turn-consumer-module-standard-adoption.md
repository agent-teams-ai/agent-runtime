---
id: ADR-0016
type: adr
status: proposed
owner: architecture
summary: Proposes a scoped pending classification for the contained-turn seven-port composition.
related:
  - ADR-0012
  - ADR-0013
  - ADR-0015
code_anchors:
  - enforcement: required
    pattern: architecture/consumer-module-standard/contained-turn-profile.json
  - enforcement: required
    pattern: scripts/architecture/check-consumer-module-standard.mjs
---

# ADR-0016: Contained-turn Consumer Module Standard pending adoption

Status: proposed

Date: 2026-09-10

## Context

Agent Runtime has the closed seven-port Pure DI contained-turn composition
accepted by ADR-0012. ADR-0015 separately adopts Get Modular Core and Assembly
for passive setup only. The contained-turn composition remains direct and must
stay explicitly classified without broadening the passive Assembly graph.

The reviewed authority is `agent-teams-ai/get-modular` at exact commit
`f1ec0152c34715395685b349844a7d1c18a2f015`, path
`docs/architecture/common-assembly.md`, anchor `consumer-module-standard`.
The SHA-256 of the complete document bytes is
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
ADR-0015 and `architecture/get-modular/consumer-profile.json` own the active
standard pin. This proposal reuses that authority for one narrower legacy seam.

## Proposal

Record proposed pending-adoption governance only for contained-turn. The scoped
profile records no adopted boundary and no exception. It classifies the current
Embedded Runtime to Agent Execution composition as one exact legacy boundary,
`contained-agent-turn-seven-port`, with status `not-adopted` and mechanism
`static-pure-di`.

The legacy boundary has exactly these dependencies, in order:
`operationStore`, `security`, `providerAccess`, `workspace`, `artifacts`,
`custody`, and `provider`. Its materialized entrypoint, dependency declaration,
factory, two materialization call sites, owner, rationale, and review trigger
are fixed in `architecture/consumer-module-standard/contained-turn-profile.json`.

The blocking checker and rejecting fixtures run in both fast and full gates.
They reject authority drift, missing paths, inactive or no-op commands, slot or
call-site drift, unknown callers, unaccepted exceptions, forbidden inward Get
Modular imports, and an unsupported contained-turn active-adoption claim. This
proposal does not authorize a runtime boundary change.

## Consequences

Agent Runtime can no longer acquire a new meaningful composition boundary in
the governed slice without adopting or explicitly classifying it. Existing FMS
scope and the seven-port runtime behavior remain unchanged.

Contained-turn adoption requires a later accepted delivery that replaces the
direct legacy wiring with one Assembly root and supplies independent parity,
preparation, cleanup, isolation, typed rejection, and packed-import evidence.
The already accepted passive setup adoption remains unchanged. A later HTTP
interface must be profiled from its final accepted contract rather than
anticipated here.
