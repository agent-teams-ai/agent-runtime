---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn runtime access

Owns the Host runtime-access surface for a contained turn: submit, observe, and
cancel against an authority-bound capability, plus the caller-facing setup and
turn view DTOs. Lifecycle abort racing stays in Host composition. Owner
invocation failures remain contract violations rather than synthesized
cancellation.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
