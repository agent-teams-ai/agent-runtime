---
id: ADR-0093
type: adr
status: accepted
owner: architecture
summary: Extracts the unchanged provider Session SPI into a dependency-free workspace contract with compatibility reexports.
---

# ADR-0093: Provider Session contracts package

Status: accepted

Accepted on 2026-10-21 for the owner's accepted two-stage migration P1.2 and
stage-1 section 4.3. This is a bounded successor to ADR-0092's package coupling;
it does not authorize Host implementation, migration, publication or activation.

## Context

The provider library's erased Agent Execution peer still forces packed consumers
to install the execution engine, PostgreSQL and Filesystem Custody. The accepted
legacy-host direction requires independent package installation and compilation.

## Decision

Move the unchanged fourteen public Session SPI definitions to the ordinary private
workspace package `@agent-teams/provider-session-contracts`, version `0.0.0`, at
`packages/platform/provider-session-contracts`. The semantic owner remains the
provider-neutral consumer Session contract. Its architectural role is `platform`;
one `provider-session-contracts` feature contains only `contracts`. It exports
only named types through the root. It has no runtime dependencies, peers, SDK,
engine, database, filesystem custody, Team or Task models. The private scope shape
needed by `OpenConfig` retains its existing tenant/project/session/generation fields.

The provider implementation and Agent Execution depend directly on this package.
Agent Execution's existing `interactive-contracts` subpath and internal outbound
port reexport these same definitions; no editable copy of the SPI remains there.
Public behavior, fields and the fourteen old exported names remain unchanged.
Only the legacy import retains its compatibility path. No SDK DTO moves inward.

Adopt the actual eighth production package in Foundation roots, native Feature
Module Standard v1 topology, SDK-growth and the product package census. Preserve
all previous roots, tests, immutable ADRs and historical qualification bytes.
The new contracts boundary permits no package, builtin or runtime-value imports;
provider/runtime consumers may import only its public types. Curated internal
assembly files contain named type reexports only. It introduces no Host,
resources, lifecycle, Assembly graph or configurable composition boundary.

The reviewed FMS identity remains v1, blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.
CMS upstream `7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333` was compared with the
consumer's `ddf1e0b0053f546f12ca70190b237b4f7e78d09d` document. Its only added
paragraph governs observation-load drain ownership, which this extraction does
not use or change. Existing Host adoption and its pin remain outside this
contracts-only delivery; no new CMS composition claim is made.

## Consequences

A clean external consumer installs actual contracts/provider archives and builds
under strict TypeScript without Agent Execution, PostgreSQL, custody or fork
packages. A separate compatibility consumer checks equality of all fourteen old
SPI types and the empty runtime exports. Existing synthetic provider protocol
fixtures continue to exercise implementations. No live agents, credentials,
external model APIs or real user projects are involved.

This decision changes package ownership and install closure only. Historical
provider qualification remains bound to its earlier bytes, and this extraction's
artifacts and source must earn their own scoped evidence. No native provider,
Host, Team, CLI, frontend migration or production qualification is implied.
