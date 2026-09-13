---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn construction failure

Owns construction-failure cleanup for a contained-turn owner: dispose after a
failed construction without retaining cleanup credentials or stacks, and the
fixed cleanup-stage and owner-disposal diagnostics.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
