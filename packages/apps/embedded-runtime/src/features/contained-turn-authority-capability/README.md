---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Contained-turn authority capability

Owns binding a selected owner capability to one access-authority revision.
Trusted composition assigns the revision; rebinding requires a new composition
product. The owner still owns operation truth. This adapter only attaches
invocation authority to submit, observe, and cancel DTOs.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. The matching
`src/composition/` file re-exports those entries so existing Host assembly
imports keep working.
