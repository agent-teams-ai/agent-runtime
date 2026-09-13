---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Linux Codex deployment

Owns trusted Linux Codex deployment infrastructure after committed claim:
route-enforcement bind, HTTP egress evidence, and the private Linux
deployment-authority join. The recipe supplies pinned Engine, tools, image,
journals, and native files through existing contracts. No workspace,
environment, credential discovery, migrations, or qualification flags live
here. Process lifecycle and host custody stay in Host composition.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
