---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn Linux route binding

Owns projecting one Provider Access route endorsement and trusted campaign
facts into the exact Linux exclusive-route binding. Provider Access fields are
transported, never derived. This projection approves no policy, reads no
database, renders no credential, and installs nothing; the route owner
re-validates every field it is handed.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
