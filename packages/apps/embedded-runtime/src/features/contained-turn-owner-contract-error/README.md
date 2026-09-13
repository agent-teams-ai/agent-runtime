---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn owner-contract error

Owns the Host owner-contract violation error and its closed code set, including
duplicate or invalid operation ids, malformed owner outcomes, invocation
failure, and operation-id mismatch.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
