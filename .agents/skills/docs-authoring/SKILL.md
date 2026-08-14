---
name: docs-authoring
description: Create, discover, or validate governed Agent Runtime documentation.
---

# Documentation authoring

Protocol: `agent-teams.docs-protocol/v1`.

1. Run `pnpm docs:info` before choosing a document type or owner.
2. Search first with `pnpm docs:find -- <filters>`.
3. Select only a reported type and one of its reported owners.
4. Preview with `pnpm docs:new -- <intent> --dry-run`.
5. Review the destination, metadata, relations, code anchors, and index route.
6. Repeat `--code-anchor` as strict JSON `{ "enforcement", "pattern" }` values.
7. Write with `pnpm docs:new -- <same-intent> --apply` only after review.
8. Manually add the reported link to the reported index in the same change.
9. Run `pnpm docs:check`, then the repository verification gate.

Use `pnpm docs:doctor` to inspect an interrupted write and
`pnpm docs:recover` only for the recovery action it reports.

Never edit accepted ADRs, frozen evidence, transaction journals, or recovery
state by hand. Never run runtime, provider, agent, provisioning, terminal, or
smoke flows to validate documentation. Use only static checks and disposable
documentation fixtures.
