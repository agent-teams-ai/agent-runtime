---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn access authority

Owns the composition-only contained-turn access-authority snapshot: revision,
project, and tenant facts copied once into a frozen record. The snapshot is
never an operation CAS and never a caller DTO. Identity strings in the reserved
authority namespace stay excluded from caller projections.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
