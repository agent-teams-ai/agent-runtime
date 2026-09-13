---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn HTTP Runtime Security

Owns the inert Host binding of an already-owned Runtime Security Ed25519
candidate into Agent Execution's HTTP consumer contract. Runtime Security keeps
policy reads, signer, and disposal. This binding creates no key, listener, or
authority and adds no feature port.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
