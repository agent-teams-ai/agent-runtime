---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn runtime validation

Owns Host-side copying and bounds checks for contained-turn caller input and
owner outcomes: identities, prompts, output chunks, submit and observe
projections, and contract-violation mapping. Access-authority identity strings
stay excluded from caller-facing copies.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
