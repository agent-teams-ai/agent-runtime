---
name: docs-authoring
description: Use when creating, changing, reorganizing, or reviewing governed documentation in this repository.
---

# Documentation Authoring

Protocol: `agent-teams.docs-protocol/v1`.

## Required workflow

- Read the current types, owners, placement, metadata, and index policy with `pnpm docs:info`.
- Search first with `pnpm exec docs-protocol find --consumer . --profile architecture/foundation/docs-protocol.yaml --text "QUERY" --json`.
- Reuse or relate existing authority instead of creating a competing source.
- Preview with `pnpm exec docs-protocol new --consumer . --profile architecture/foundation/docs-protocol.yaml --type TYPE --id ID --title "TITLE" --owner OWNER --summary "SUMMARY" --dry-run --json`.
- Review the exact destination, metadata, relations, anchors, diagnostics, and returned planDigest; retain that digest as DIGEST.
- Apply with `pnpm exec docs-protocol new --consumer . --profile architecture/foundation/docs-protocol.yaml --type TYPE --id ID --title "TITLE" --owner OWNER --summary "SUMMARY" --apply --expect "DIGEST" --json` after review, including the identical optional slug, relations, anchors, and metadata from preview.
- When reachability is `manual-required`, insert the exact returned `markdownLink` into the returned `indexPath`; index documents marked not-required need no link mutation.
- Inspect affected authority with `pnpm exec docs-protocol context --consumer . --profile architecture/foundation/docs-protocol.yaml --id ID --json` after the index is current.
- Run `pnpm exec docs-protocol check --consumer . --profile architecture/foundation/docs-protocol.yaml --json` and resolve diagnostics.
- For edits, preserve canonical frontmatter and sidecar ownership; use the repository's governed review flow rather than bypassing the create-only writer.
- For accepted authority, record supersession explicitly instead of silently rewriting history.
- Finish with the full consumer gate `pnpm docs:protocol:check` after the index is current.

## Rules
- Never invent owners, types, statuses, paths, or metadata outside `docs:info`.
- If dependencies are absent, use only `pnpm install --frozen-lockfile`; never use npx, dlx, or latest tags.
- Keep preview and apply inputs identical.
- Stop when recovery is required; use `pnpm docs:doctor` before `pnpm docs:recover`.
- Resolve required anchors and blockers before apply.
- Do not bypass repository scripts or hand-edit transaction evidence.
