---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Setup-inspection planning

Owns Claude Code and Codex setup-inspection planners, setup-view builders, and
the opaque-reference digest used by Host runtime-access composition. Planners
remain inward Host helpers; they do not execute an observed binary or read
ambient authentication state.

Host composition reaches this feature through curated entrypoints: `index.ts`
for public types and `internal.ts` for composition. Matching `src/composition/`
files (`codex-setup-inspection-planner.ts`,
`claude-code-setup-inspection-planner.ts`, and `opaque-reference-digest.ts`)
re-export those entries so existing Host assembly imports keep working.
