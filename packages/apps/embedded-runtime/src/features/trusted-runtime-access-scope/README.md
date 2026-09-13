---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Trusted runtime-access scope

Owns copying trusted Host runtime-access scope: Claude Code and Codex setup
observation scopes plus the contained-turn composition scope. Limits, identity
exclusions, and own-data copying stay in this feature. Ambient filesystem or
environment discovery does not live here.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
