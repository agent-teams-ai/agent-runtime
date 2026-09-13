---
type: feature
status: accepted
owner: "@agent-teams/runtime-configuration"
owner_document: ADR-0005
---

# Codex configuration inspection

Owns passive inspection of authorized Codex configuration sources. Public
transport DTOs stay in `contracts`; application models and outbound ports remain
inward-only; Node hashing, filesystem reads, TOML parsing, and semantic
classification stay in outbound adapters; one inbound adapter translates the
published inspect contract onto the use case. Feature-local composition wires
those adapters. Inspection never executes an observed binary or reads ambient
authentication state.

Package assembly reaches this feature through curated entrypoints: `index.ts`
for `.` and `internal.ts` for `./composition`.
