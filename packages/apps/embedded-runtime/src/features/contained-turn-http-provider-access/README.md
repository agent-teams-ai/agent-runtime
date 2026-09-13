---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn HTTP Provider Access

Owns the Host HTTP Provider Access owner boundary: native async authorization
and observation, request-digest creation, and projection of owner receipts into
Agent Execution's HTTP consumer contract. Ordinary Promise-returning functions
are unsupported. Owner response data is inspected before projection.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
