---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn current egress owners

Owns Host projection of current egress owners from Runtime Security dispatch
heads and Provider Access route endorsements. Repository optional-head envelopes
are translated here; Runtime Security remains the authority schema owner.
Borrowed capabilities do not transfer disposal.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
