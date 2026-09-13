---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn current authority

Owns trusted private selection between legacy and current contained-turn
authority dependencies. It snapshots Provider Access and Runtime Security
ports without invoking getters or Proxy traps, then binds the matching Agent
Execution composition ports. Omission retains the legacy candidate binding.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
