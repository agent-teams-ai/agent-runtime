---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn operation ref

Owns the Host composition operation-ref shape: an operation id plus a trusted
composition scope. Callers pass this ref through Host assembly; it is not an
Agent Execution durable operation authority.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
