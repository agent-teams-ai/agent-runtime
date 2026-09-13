---
type: feature
status: accepted
owner: "@agent-teams/runtime-security"
owner_document: ADR-0005
---

# Provider-process egress authorization

Owns V2 provisional and final provider-process egress grants, current-egress
ownership, and parent-wrapper boundary checks. Public transport DTOs stay in
`contracts`; application models and outbound ports remain inward-only; Node
digesting and signing stay in outbound adapters. Feature-local composition
wires those adapters. Package assembly reaches this feature through curated
`index.ts` / `internal.ts` entrypoints.
