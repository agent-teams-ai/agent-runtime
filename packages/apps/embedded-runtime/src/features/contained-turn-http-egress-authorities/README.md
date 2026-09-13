---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn HTTP egress authorities

Owns binding already-implemented Provider Access credential materialization and
Runtime Security Ed25519 authorization into the four broker session ports they
own. It creates no key, listener, route, or authority. Disposal closes only the
newly created credential pairing, never Provider Access, Runtime Security, or
the Host reservation.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
