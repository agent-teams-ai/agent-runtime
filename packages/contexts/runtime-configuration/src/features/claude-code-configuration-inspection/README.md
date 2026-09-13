---
type: feature
status: accepted
owner: "@agent-teams/runtime-configuration"
owner_document: ADR-0005
---

# Claude Code configuration inspection

Owns passive inspection of authorized Claude Code settings sources. Public
transport DTOs and vocabulary constants stay in `contracts`; application models
and outbound ports remain inward-only; Node hashing, filesystem reads, JSON
parsing, and semantic classification stay in outbound adapters; one inbound
adapter keeps vocabulary parity with the published contract. Feature-local
composition maps those adapters onto the inspect use case. Inspection never
executes an observed binary or reads ambient authentication state.

Package assembly reaches this feature through curated entrypoints: `index.ts`
for `.` and `internal.ts` for `./composition`.
