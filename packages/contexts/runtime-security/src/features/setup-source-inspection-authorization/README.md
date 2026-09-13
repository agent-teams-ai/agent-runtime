---
type: feature
status: accepted
owner: "@agent-teams/runtime-security"
owner_document: ADR-0005
---

# Setup-source inspection authorization

Owns authorization of trusted setup configuration sources and installation
candidates, including Claude Code path scope. Public transport stays in
`contracts`; application path algebra and outbound ports remain inward-only;
Node path canonicalization and identity digests stay in outbound adapters.
Feature-local composition wires those adapters. Inspection authorization never
executes an observed binary. Package assembly reaches this feature through
curated `index.ts` / `internal.ts` entrypoints.
