---
type: feature
status: accepted
owner: "@agent-teams/agent-execution"
owner_document: ADR-0005
---

# Contained agent turn

Owns the provider-neutral contained-turn operation contract, durable operation
authority, ordered execution kernel, and owner-side runtime adapters. Public
contracts are curated through `index.ts`; private construction and adapter
exports are curated through `internal.ts` and the package composition surface.
Test-only owner-port assembly remains outside production source.
