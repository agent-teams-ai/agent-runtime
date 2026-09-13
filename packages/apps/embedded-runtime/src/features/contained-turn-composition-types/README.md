---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn composition types

Owns the Host observation and submit outcome shapes used by contained-turn
composition: owner turn observations, observation outcomes, and submit outcomes
including conflict, unsupported, and denied cases. These types stay Host-local
and do not replace Agent Execution contracts.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
