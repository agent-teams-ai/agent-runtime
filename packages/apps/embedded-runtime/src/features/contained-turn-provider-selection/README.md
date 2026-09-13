---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn provider selection

Owns capturing the tagged Host provider choice (Codex or Claude) through exact
own-data descriptors. Proxies are rejected before reflection so traps cannot
change between snapshots. The captured selection can later assert it is still
stable.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
