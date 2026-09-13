---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn HTTP egress upstream

Owns projecting one Provider Access route endorsement into the broker upstream
route and detached Provider Access snapshot, plus the Node TLS transport bind.
Neither route nor snapshot is derived here. The Host catalog mints the route
from an endorsed profile id; the snapshot carries Provider Access facts
verbatim, including the opaque credential binding digest.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
