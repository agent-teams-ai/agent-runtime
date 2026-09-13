---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn route qualification

Owns the fail-closed Host product-route gate against the repository
qualification registry. Only an exact whole-tuple promotion to implementation
or deployment with attached evidence qualifies. Missing, unreadable, or
policy-drifted registries qualify nothing; wildcards and scoped entries never
pass.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
