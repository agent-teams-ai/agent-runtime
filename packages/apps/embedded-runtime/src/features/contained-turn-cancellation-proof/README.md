---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn cancellation proof

Owns Host-side cancellation proof classification for a contained turn. It
snapshots an untrusted owner outcome and maps it onto contract-violation,
not-found, nonterminal, mismatch, or terminal cancelled/failed/succeeded
without synthesizing cancellation from process disappearance.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
