---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Darwin contained-turn deployment

Owns private Embedded Runtime composition for the Darwin contained-agent-turn
profile: the single production Provider Access / Runtime Security / Agent
Execution authority root on Darwin. Construction captures deployment only;
acquisition starts with bridge take. The internal session-returning port never
leaves this root. Process lifecycle and host custody stay in Host composition.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
