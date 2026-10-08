---
id: runtime.architecture.get-modular-train-1-migration
type: architecture
status: active
owner: architecture
summary: Index of the Get Modular train 1 migration briefs for Agent Runtime.
---

# Get Modular Train 1 Migration

Index of the Agent Runtime migration onto Get Modular train 1 (Core and Assembly 0.3.0, resources and conformance
0.1.0). Status: planning document. It authorizes no pull request merge, publication or gate change by itself; every
merge is done by the owner. Base of all facts: agent-runtime `origin/main` = `0ace1cce` (2026-10-04), get-modular
`origin/main` = `81063ad` (2026-10-04). Main moves within hours: every brief starts with its own "Re-verify before
start" section.

## Deliverables and order

| # | Deliverable | Brief | Depends on | Merges? |
|---|---|---|---|---|
| 0 | Docs PR that adds these briefs to agent-runtime | this index, section "Where the briefs live" | nothing | yes |
| 1 | Draft branch `draft/gm-train-030` on the R-1a bundle `get-modular-0.3.0-train-r1a` (all four archives), with a draft PR "do not merge" | `get-modular-train-1-draft-branch.md` | release PR reviewed and green, R-1a bundle packed from its final head (release question Q2 decided by the owner on 2026-10-08: option A) | never; closed after npm publication |
| 2 | npm publication of Core 0.3.0, Assembly 0.3.0, resources 0.1.0, conformance 0.1.0 (R-1b) | get-modular release brief | owner review of TEST-1 and of the draft branch result | owner only |
| 3 | AR-1a: CMS pin to `81063ad` (get-modular #142), Core and Assembly 0.3.0 | `get-modular-train-1-ar-1a.md` | 2 | yes |
| 4 | AR-1b: module identities, builder, root as a function of Assembly, graph gate | `get-modular-train-1-ar-1b.md` | 3 merged | yes |
| 5 | AR-1c: ADR-0024, resources 0.1.0 and conformance 0.1.0, scoped ordinary owners, drain race fix, smoke | `get-modular-train-1-ar-1c.md` | 4 merged; the owner approves the ADR-0024 text in the AR-1c PR before merge | yes |
| 6 | AR-2: per-grant Provider Access scopes | `get-modular-train-1-ar-2.md` | 5 merged (ADR-0024 accepted) | yes |

```text
REL reviewed, still open -> R-1a bundle from its head -> [draft branch: D0 + AR-1a + AR-1b + AR-1c + AR-2 commits]
-> owner sign-off -> REL merged -> R-1b (npm)
R-1b -> AR-1a -> AR-1b -> AR-1c -> AR-2 (one PR at a time, each with its own independent review)
after AR-2: AR architecture program lanes rebase; issue #189 (test debt) starts; train 2 decisions
```

Why this order (decided, not open):

- AR-1b (identities) goes before AR-1c (scopes): `scoped(implementationId, factory)` names module scopes after
  implementation IDs, and those names appear in debt paths. Renaming after scopes exist would rename debt paths too.
- AR-1b also turns the composition root into a function of `Assembly<C>`. `smoke` from `@get-modular/conformance`
  fails closed when a root binds factories outside the api it was given, and today `bindRuntimeSetup` calls
  `assemblyFor()` itself (`packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts:159`). The smoke
  tests themselves land in AR-1c, together with the first resources a module registers.
- Resources and conformance enter in AR-1c, where they are first used: `@get-modular/conformance` has peer
  dependencies on Core, Assembly and resources, and the workspace has `strictPeerDependencies: true`.
- AR-2 is last because it touches `packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts`,
  which the AR program plan also edits (STORE and ACCESS lanes); those lanes rebase after AR-2.
- The draft branch carries the commits of all four PRs. A real PR either cherry-picks them with the porting procedure
  in `get-modular-train-1-draft-branch.md` (section "Porting a draft commit") or re-implements from the brief; both end
  with a registry lockfile and no `file:` entries.

## Rules every brief repeats (owner decisions, stated as facts)

- Module = HOW, Host = WHEN, Get Modular = mechanism. Trusted in-process code only. Hooks, observation and plugins
  are out of scope; nothing is prepared for plugins.
- Agent Runtime has no deployed data: module IDs are renamed without data migration.
- Consumer Module Standard maintenance (workspace rule): before AR-1b, AR-1c and AR-2, compare the pinned standard
  with the current get-modular `main`; if it changed, stop, the owner decides on a pin step first. AR-1a performs the
  pin migration of this train to `81063ad` (#142), the same pin as the TEST consumer (planning decision 2026-10-04: the pin
  names the commit that defines the standard revision, so it does not depend on when the release PR merges; the
  release PR changes no standard byte, and AR-1a checks that).
- Gates are never deleted. A gate in the way is disabled with a comment (reason and restore condition) only where a
  brief says so. The gates disabled by AR-0 (#187) and AR-S (#190) stay disabled; this migration restores none of
  them, because none of their restore conditions depends on it.
- Commits only with the repository identity `iliya <iliyazelenkog@gmail.com>` from git config; never `-c` overrides,
  no co-author trailers; commit and PR texts describe only the change. GitHub texts in English, plain, regular dashes
  and quotes. No destructive git commands (`checkout --`, `restore`, `reset --hard`, `clean -f`, `stash drop`,
  `branch -D`). Force push only an own unshared branch.
- npm publication, rulesets, permissions, deleting shared branches (including `draft/gm-train-030` and its retries):
  owner only.
- Unit tests only for risky places; new or touched fakes are typed (`satisfies`, `FactoryDependencies`), no new
  `as never`. Package test files are not type-checked by any gate today (issue #189 adds that), so reviewers check
  typing by reading.
- Every PR: independent review, fixes, re-review; the owner merges with squash and `--match-head-commit` on the
  reviewed head. The commit structure inside each brief is for review and per-commit gates.

## Where the briefs live (decision)

agent-runtime governs `docs/` with docs-protocol (`architecture/foundation/docs-protocol.yaml`,
`architecture/foundation/document-authoring.yaml`). Delivery plans are `architecture` documents in
`docs/architecture/` (examples: `agent-runtime-architecture-program-plan.md`, `contained-agent-turn-v1-delivery-plan.md`).
The `architecture` type is a flat collection (`placement: collection`, `filename: slug`, `heading: title`), owner
`architecture`, reachability `manual-fixed-index` through `docs/architecture/README.md`. Subdirectories are not
allowed, and `research/` is ungoverned evidence, not authority. Therefore:

| File | `--id` | `--title` (= H1) |
|---|---|---|
| `docs/architecture/get-modular-train-1-migration.md` (this index) | `runtime.architecture.get-modular-train-1-migration` | `Get Modular Train 1 Migration` |
| `docs/architecture/get-modular-train-1-draft-branch.md` | `runtime.architecture.get-modular-train-1-draft-branch` | `Get Modular Train 1 Draft Branch` |
| `docs/architecture/get-modular-train-1-ar-1a.md` | `runtime.architecture.get-modular-train-1-ar-1a` | `Get Modular Train 1 AR-1a` |
| `docs/architecture/get-modular-train-1-ar-1b.md` | `runtime.architecture.get-modular-train-1-ar-1b` | `Get Modular Train 1 AR-1b` |
| `docs/architecture/get-modular-train-1-ar-1c.md` | `runtime.architecture.get-modular-train-1-ar-1c` | `Get Modular Train 1 AR-1c` |
| `docs/architecture/get-modular-train-1-ar-2.md` | `runtime.architecture.get-modular-train-1-ar-2` | `Get Modular Train 1 AR-2` |

Docs PR procedure (branch `docs/get-modular-train-1-briefs` from fresh `origin/main`):

1. `pnpm install --frozen-lockfile`, `pnpm docs:info`, `pnpm docs:find -- --text "Get Modular"`.
2. For each file: `pnpm docs:new -- --type architecture --id <id> --title "<title>" --owner architecture --summary "<one line>" --dry-run`.
   The destination must equal the table; the file name comes from the title slug. If the dry run reports another
   destination, stop and ask: the briefs cross-reference these paths. Then the same command with `--apply`. Keep the
   generated frontmatter; replace the generated body with the brief text. The H1 is exactly the title (the briefs
   already start with it).
3. Add one bullet per document to `docs/architecture/README.md` in the existing "Documents:" list.
4. In `docs/architecture/get-modular-adoption.md`, section "Status and authority", add one paragraph: the Consumer
   Module Standard revised for 0.3.0 at get-modular `81063ad` (SHA-256 `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`)
   is not yet reviewed here; AR-1a migrates the pin to `81063ad` (#142), the commit that defines this standard
   revision; until then any change to
   module boundaries, capability contracts, composition or lifecycle ownership in this repository must do that pin
   step itself.
5. Gates, each must exit 0: `pnpm docs:check`, `pnpm docs:protocol:check`, `pnpm docs:qualification`, commit,
   `pnpm check` on Linux. On macOS `test:sdk-growth:source` fails on unmodified `origin/main` (it reads
   `/proc/self/fd`), so run every step of the `check` chains except that one (the loop is in the AR-1a brief,
   section 2) and rely on Linux CI for it. Commit `docs(architecture): add Get Modular train 1 migration briefs`.

## Handoff inputs and placeholders

The briefs contain placeholders (`<fill>`) for release facts and owner answers. Before each handoff, one docs PR
`docs(architecture): fill <brief> handoff inputs` writes the owner answers and release inputs into that brief (and
nothing else). The implementer reads the brief only from `origin/main` after that PR merged; a brief with a
placeholder left is not executable.

After AR-2 merges, one docs PR marks these six documents as completed history (or supersedes them) per
docs-protocol, so they stop reading as active plans.

## Decisions recorded by this plan (2026-10-04)

- Root deadline for releasing the resource owners of the ordinary Host (Consumer Module Standard Host rule "Use one deadline at the
  root: escalate first, then abandon"): not added in AR-1c. The release keeps today's behavior (no deadline on owner
  release; the Host drain keeps its 1 s caller wait). It is recorded as outstanding work with a trigger: the first
  owner whose release can block without its own bound, or an owner request. The prepared values for that later step
  are grace 5000 ms and abandon 5000 ms (from the Runtime Security `statement_timeout` of 5000 ms and the Provider
  Access transaction bound of 4000 ms). Reusing the 1 s Host wait is rejected: it bounds only the caller's wait and
  would report healthy but slow database releases as incomplete.

## Owner decisions (2026-10-08)

- Publication gate for the draft branch (decided by the owner on 2026-10-08, option 1 of three): milestones M1 to M4
  green locally per the "Local full gates" block of each brief (`pnpm check` on Linux; on macOS every lane step except
  the known pre-existing macOS failure `test:sdk-growth:source`, which Linux CI covers). On the M4 head, the draft
  PR's required checks (`check`, `docs-protocol / docs-protocol-check`, `postgres-durability`, `runtime-macos`,
  `commit-author-identity`) and the job `install-build-runtime (Node 26.10.0)` of workflow `Node 26 Compatibility`
  are green; that job closes the "Node 26.10+ consumer" row of `release-intent.md` for Agent Runtime. Blocking
  findings (any one stops npm publication): (a) a public type of Core, Assembly, resources or conformance that forces
  a cast, `any`, `as never` or an explicit `prepare<R>()` argument, or infers wrongly; (b) a runtime defect in
  Assembly, resources or conformance reproduced with a minimal case (outcome, cleanup order, close and retry,
  `scoped()`, `smoke` or `isolate` verdicts); (c) a packaging defect (dependencies, peers, engines, exports, files;
  an install failure under `--strict-peer-dependencies` or `--engine-strict`; a Node 26.10 install, build or test
  failure caused by the archives); (d) any integrity mismatch between bundle, lockfile and retained copy. Not blocking
  npm: a defect in the standard's text (it blocks the AR-1a pin until a standard revision), an Agent Runtime defect
  (fixed on the draft branch and in its brief), a CI failure that passes on one re-run and is recorded.
- Release timing (get-modular release question Q2, decided by the owner on 2026-10-08, option A): the release PR
  stays open; the R-1a bundle is packed from its final head after review and CI; the owner merges the release PR
  after signing off the consumer checks. The release branch is updated without force pushes. For these briefs:
  `SOURCE_SHA` is the release PR head; `REL_SHA` (the merged release commit) exists only after the draft branch work.

No owner question remains open for these briefs.
