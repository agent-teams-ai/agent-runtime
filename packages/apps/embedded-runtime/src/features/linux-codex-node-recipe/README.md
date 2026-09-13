---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Linux Codex node recipe

Owns the private Linux Codex app recipe consumed by deployment infrastructure.
Selection supplies approved facts, directory pins, and native-file custody,
never an already-built recipe. Agent Execution constructs Engine identity,
Linux lifecycle, journals, and route inspection; Host still constructs
private-root custody, network, listener, route lease, and finalizer.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
