---
type: feature
status: accepted
owner: "@agent-teams/provider-access"
owner_document: ADR-0005
---

# Contained turn access

Owns the Provider Access facts and one-time dispatch-consumption authority used
by a contained agent turn. Public transport DTOs stay in `contracts`; domain
and application policy remain inward-only; adapters validate and detach data
at runtime boundaries; feature-local composition wires the Pure DI factories.

## Ordinary grant release

The ordinary Provider Access owner keeps one `pa-grants` resource scope with
`order: "concurrent"`, and each consumed grant gets one child scope named
`grant:<grantId>`. The child holds one cleanup that calls the grant's `retire()`,
so the domain retirement protocol (broker close, rendering, capture and guard
disposal, store retire) stays in one entry. When a grant is both retired and
settled, its child is closed and detaches from the parent, so released grants do
not accumulate in a long-lived owner. `dispose()` closes the grant scope: every
unreleased grant retires concurrently, a failed retirement is isolated, and a
later `dispose()` retries only the grants that failed. The failure is reported as
the same flat `ORDINARY_PA_UNAVAILABLE` error as before; a debt path has the shape
`["pa-grants", "grant:<grantId>", "retire"]`. The scope never leaves Provider
Access, and the limit of 64 live grants stays in the owner.
