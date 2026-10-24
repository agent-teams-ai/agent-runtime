---
id: ADR-0092
type: adr
status: accepted
owner: architecture
summary: Selects one runtime workspace provider library and scoped native adoption without changing runtime or product authority.
---

# ADR-0092: Provider implementation workspace library

Status: accepted

Accepted on 2026-10-21 by root technical review under the owner's existing
A–F implementation authorization. This accepts the bounded location and native
adoption contract; materialization and its qualification remain to be delivered.

## Context

[ADR-0091](0091-interactive-agent-session-synthetic-vertical-slice.md) selects an
ordinary external provider implementation library. Its initial repository and
package location cannot currently be consumed by the runtime's accepted
Foundation dependency policy: organization-scoped dependencies are workspace
packages, and external dependencies use exact registry catalog versions. A
separate Git repository does not require a separate daemon or a public registry,
but inventing another artifact delivery system is unnecessary for this slice.

The owner authorized the complete A–F extraction plan and its synthetic E2E.
The reviewed extraction checkpoint is
`bc644a5045219bd635d6ea7b3467b9f297033cdf`; its isolated Node 24.21.0 and
26.11.1 qualification covers the actual provider library, not this new layout.
The runtime baseline for this decision is
`be373520e5352633fcbe6db36f07aa214d56b57b`.

## Decision

### One implementation owner and ordinary workspace delivery

This is a narrow successor to ADR-0091's external repository/delivery choice.
Materialize the qualified implementation source as the private ordinary package
`@agent-teams/provider-implementations`, version `0.0.0`, at
`packages/platform/provider-implementations`. The runtime repository becomes its
sole editable source authority after the admitted materialization is delivered.
The standalone extraction checkout remains a frozen historical input, identified
by its exact commit and per-file digests. It is not a second live implementation.
Do not import its source, resolve a sibling checkout, or install its historical
contract archives in production. Source provenance excludes dependencies,
caches and generated build output and distinguishes unchanged relocation from
import-path, assembly, manifest and test-harness adaptations.

Keep Agent Execution's curated `interactive-contracts` subpath as the only
canonical provider SPI. The provider package declares a `workspace:*` type-only
peer on the real Agent Execution package. Agent Execution never imports the
concrete implementation package. Outer composition selects a concrete factory;
this decision does not add that selection to an existing Host or retire B.
There is no new contract package, process manager, daemon, durable store, business
queue, product tool authority or second runtime core.

Preserve the existing `./claude`, `./codex`, `./opencode` and `./session-io`
package APIs. Add genuine type-only root contracts and a curated factory
composition entry. Importing the public root must neither query an SDK nor start
a provider process. SDK DTOs and provider configuration remain outer adapter
types; no native model enters Agent Execution policy.

### Native feature and dependency adoption

The module's local architectural role is `platform`, owned and activated by this
decision. One cohesive `provider-session-implementation` feature owns the
technical implementations of the runtime's interactive session SPI. Its
`adapters/claude-sdk`, `adapters/codex-protocol`, `adapters/opencode-protocol`
and `adapters/provider-session-io` directories preserve their implementation
cohesion. The queue/feed helpers are fixed private mechanisms, not independent
features, Assembly nodes or new policy owners. A real contracts-only public
entry and implementation-only `internal.ts` entry retain the native FMS
separation. Curated package facades contain named import/re-export grammar only;
their exact files and exports are admitted, not a wildcard permission for extra
platform assembly code. No empty contract layer or fabricated abstraction is
required.

Adopt the actual source in the active FMS module/feature registry, its blocking
checker and rejecting fixtures. Preserve all existing modules and diagnostics.
Register the entire new package in Foundation source-dependency roots and exact
non-overlapping boundaries. Permit the type-only public Agent Execution SPI edge
and the selected adapters' real SDK/Node edges; reject inward concrete-provider
imports, runtime value imports of the type-only SPI, deep imports and unknown
source roots. Type-only public SPI imports remain permitted. The current
FMS v1 and reviewed CMS identities stay unchanged. This library is not a Host or
independently assembled resource owner; existing production Host adoption remains
separately governed.

Retain the qualified runtime dependency tuple in a named catalog:
Claude Agent SDK `0.3.305`, Zod `4.6.7`, Anthropic SDK `0.122.0`, MCP SDK
`1.30.0`. Other modules retain their existing catalog selections. Workspace
delivery removes the candidate's file-tar development dependency and filesystem
override. No dependency policy or reserved scope is relaxed. Keep the qualified
Node engine range `>=24.21.0 <25 || >=26.11.1 <27`.

The package is a genuine seventh production package, not a development-only
exception. Register its real clean/build/typecheck/behavior/package tests in the
required package census and preserve the previous roots, command leaves and
multiplicity. Add its curated declaration surface as initial-unreleased in
SDK-growth; do not replace frozen historical package evidence.

### Qualification and limits

Before delivery, prove strict installation against the actual workspace Agent
Execution package, canonical `DriverFactory` assignment, curated exports and
an isolated packed consumer without sibling source, source aliases or historical
contract tar dependencies. Run the transferred behavior and native protocol
fixtures under actual Node 24.21.0 and 26.11.1. Retain the exact source and archive
digests and separate relocation-only lines from changed/new implementation.
Run focused native FMS, Foundation, package-census and rejecting checks for the
new boundary; final required CI remains authoritative.

These are synthetic provider protocol and packaging qualifications. Real provider
authentication, native custody, deployment, complete donor parity, team behavior,
B retirement and production Host wiring are not established by this move.
Unchanged previously qualified SDK algorithms may reuse exact-byte evidence;
layout and workspace integration must earn their own evidence.

## Consequences

The implementation remains a separately named ordinary library while sharing
the runtime's normal workspace build and delivery. No public namespace,
registry publication, new artifact platform or duplicated editable driver is
needed. The package can later be extracted again by a separate delivery decision
without changing the consumer-owned SPI or its authority boundaries.

ADR-0091 and all predecessor accepted bytes remain unchanged. This decision
changes only implementation location, module activation and native package
adoption. Acceptance does not by itself transfer source authority; actual
blocking adoption precedes the materialization delivery.
