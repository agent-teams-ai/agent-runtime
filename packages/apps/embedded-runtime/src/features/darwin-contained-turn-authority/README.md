---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Darwin contained-turn authority

Owns the private Darwin acknowledgement join under contained-agent-turn. It
captures deployment data and ports without executing accessors or Proxy traps,
then binds Darwin route-enforcement authority, store methods, and claimed
acknowledgement. This is a fixed direct owner, not a Module Kit node.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
