---
id: ADR-0015
type: adr
status: proposed
owner: architecture
summary: Proposes the Consumer Module Standard pin and classifies the existing seven-port composition as explicitly not adopted.
related:
  - ADR-0012
  - ADR-0013
code_anchors:
  - enforcement: required
    pattern: architecture/consumer-module-standard/profile.json
  - enforcement: required
    pattern: scripts/architecture/check-consumer-module-standard.mjs
---

# ADR-0015: Consumer Module Standard pending adoption

Status: proposed

Date: 2026-09-10

## Context

Agent Runtime already has the closed seven-port Pure DI composition accepted by
ADR-0012. It does not install Get Modular Core or Assembly and has no Assembly
declarations, bindings, or consumer profile. The central Consumer Module
Standard therefore describes Agent Runtime as planned rather than adopted.

The reviewed authority is `agent-teams-ai/get-modular` at exact commit
`f1ec0152c34715395685b349844a7d1c18a2f015`, path
`docs/architecture/common-assembly.md`, anchor `consumer-module-standard`.
The SHA-256 of the complete document bytes is
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
There was no earlier Agent Runtime pin, so this delivery introduces the current
authority directly and has no retained consumer migration delta.

## Proposal

Record the exact central pin only as proposed pending-adoption governance. The consumer
profile records no adopted boundary and no exception. It classifies the current
Embedded Runtime to Agent Execution composition as one exact legacy boundary,
`contained-agent-turn-seven-port`, with status `not-adopted` and mechanism
`static-pure-di`.

The legacy boundary has exactly these dependencies, in order:
`operationStore`, `security`, `providerAccess`, `workspace`, `artifacts`,
`custody`, and `provider`. Its materialized entrypoint, dependency declaration,
factory, two materialization call sites, owner, rationale, and review trigger
are fixed in `architecture/consumer-module-standard/profile.json`.

The blocking checker and rejecting fixtures run in both fast and full gates.
They reject authority drift, missing paths, inactive or no-op commands, slot or
call-site drift, unknown callers, unaccepted exceptions, forbidden Get Modular
imports, and any active-adoption claim while the required artifacts are absent.
This proposal does not authorize a runtime boundary change.

## Consequences

Agent Runtime can no longer acquire a new meaningful composition boundary in
the governed slice without adopting or explicitly classifying it. Existing FMS
scope and the seven-port runtime behavior remain unchanged.

Active adoption requires a later accepted delivery that pins exact reviewed
Core and Assembly packages, replaces the direct legacy wiring with one Assembly
root, and supplies independent parity, preparation, cleanup, isolation, typed
rejection, and packed-import evidence. A later HTTP interface must be profiled
from its final accepted contract rather than anticipated here.
