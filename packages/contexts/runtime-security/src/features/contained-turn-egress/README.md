---
type: feature
status: accepted
owner: "@agent-teams/runtime-security"
owner_document: ADR-0005
---

# Contained-turn egress

Owns signed first-write egress authorization, route binding, and the transport
exchange for a contained turn. Public types stay in `contracts` or the package
assembly surface; domain policy and host identity stay inward-only; application
use cases and outbound ports remain inward-only; Node clocks, signing, and
security primitives stay in outbound adapters. Feature-local composition builds
the gateway. Package assembly reaches this feature through curated `index.ts` /
`internal.ts` entrypoints.
