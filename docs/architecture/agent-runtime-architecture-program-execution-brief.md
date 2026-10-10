---
id: runtime.architecture.architecture-program-execution-brief
type: architecture
status: active
owner: architecture
summary: Self-contained execution brief for the remaining cards of the Agent Runtime architecture program, with preconditions, card instructions, review checklists and stop conditions.
---

# Agent Runtime Architecture Program: Execution Brief

Version of 2026-10-10, written against agent-runtime main `aca6cbe7` (product and CI facts unchanged since `44846323`). Sibling execution plans that run first or in parallel: the [Get Modular train 1 migration](get-modular-train-1-migration.md) (AR-1a, AR-1b, AR-1c, AR-2) and the [issue #189 test debt briefs](test-debt-189-plan.md). This brief tells an implementer how to execute the cards of the [architecture program plan](agent-runtime-architecture-program-plan.md). It does not authorize anything beyond what section 8 lists.

Authority order: the owner decisions log (`research/architecture-critique-2026-10/round2/decisions-log-2026-10-02.md`) wins over the plan, and the plan wins over this brief. When two of them disagree, or when anything is ambiguous, stop and ask. Do not settle a design question alone.

## 1. Re-verify before every card

Main moves fast: between 2026-10-04 and 2026-10-07 it received 48 CI commits that changed which files are frozen. Before a card starts, run these checks on a fresh clone and compare with the facts in this brief and in the plan (sections 2.3 and 5.0). If anything differs, stop and report the difference before writing code.

```sh
git clone https://github.com/agent-teams-ai/agent-runtime.git   # full history, never --depth
cd agent-runtime
git log -1 --format='%H %cd'
git diff --stat aca6cbe7..origin/main -- scripts/ci scripts/docs architecture package.json pnpm-workspace.yaml .github/workflows 'packages/*/*/package.json'
node --version            # must print v24.21.0
cat .node-version         # 24.21.0
node -p "require('./package.json').packageManager"   # pnpm@11.18.0
grep -n 'df9260b0' scripts/ci/conformance.ts scripts/ci/full-contract.json
grep -n "fixed six roots" scripts/ci/package-execution.ts
gh api repos/agent-teams-ai/agent-runtime/rules/branches/main --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

Expected on 2026-10-08: the baseline literal at `scripts/ci/conformance.ts:263` and `scripts/ci/full-contract.json:2`; the six-package check at `scripts/ci/package-execution.ts:115`; required checks `check`, `docs-protocol / docs-protocol-check`, `postgres-durability`, `runtime-macos`, `commit-author-identity`.

For cards in other repositories, run the same kind of check there before starting (expected heads, checked on 2026-10-10, in parentheses):

- Engineering Foundation, `agent-teams-ai/engineering-foundation` (`94e0c320`): `git log -1`; `packages/engineering-foundation/src/capabilities/public-api-compatibility/application/rules.ts:47` still requires "an ADR-backed breaking-change entry"; `docs/architecture/executable-capabilities.md:82-86` still holds the extraction admission rule; pnpm 11.20.0.
- get-modular, `agent-teams-ai/get-modular` (`c6ec622f`; the standard file hashes to `49d08b6d...`, equal to the agent-runtime pin): `git log -1`; `docs/architecture/common-assembly.md:44-45` ("Feature Module Standard v1 ... remains the sole authority") and `:526-527` ("No wildcard, blanket directory exemption or automatic legacy inventory expansion") unchanged; pnpm 11.20.0.
- `agent-teams-ai/.github` (`66d6d3d`): `git log -1`; `tools/feature-module-standard/check.mjs:60, 79-88` (published status and six markers); Feature Module Standard v1 blob `d0bfff20`; pnpm 11.18.0.

Also check, per card:

- the owner questions the card depends on (plan section 4.2) are answered in the decisions log;
- every `file:line` the card cites still points at the same code;
- for ACCESS-AUTH-FILE and ACCESS-REFRESH-GUARD: the latest stable `openai/codex` release (`gh release list -R openai/codex --exclude-pre-releases --limit 3`) and whether `codex-rs/login/src/auth/storage.rs`, `codex-rs/login/src/token_data.rs`, `codex-rs/login/src/auth/manager.rs` (`should_refresh_proactively` and its constants) and `codex-rs/app-server/src/request_processors/account_processor.rs` changed since `rust-v0.161.0`.

If the default `node` on PATH is not 24.21.0 (a newer system build is common), put the Node 24.21.0 bin directory first on PATH for every command; shell state may not persist between commands, so prefix each one.

## 2. Goal

Make the Codex ordinary path of agent-runtime a clean, modular reference architecture and move the reusable parts into libraries, without new features. Wave 1 is merged (plan #192, SEAM-1 #193, STORE-1b #191, STORE-1c #194). This brief covers wave 2 and the first cards of wave 3.

## 3. Ordered work list

Cards in different repositories can run in parallel, each in its own clone and pull request. agent-runtime pull requests merge one at a time.

**Wave 2a, ready now:**

| # | Card | Repository | Role | Plan section |
|---|---|---|---|---|
| 1 | DOCS-1 parts (a) and (b) | agent-runtime | integrator | 5.2 |
| 2 | EF-SURFACE | Engineering Foundation | worker C | 5.2 |
| 3 | STANDARD-1c | Engineering Foundation | worker C | 5.2 |
| 4 | STANDARD-1d | Engineering Foundation | worker E | 5.2 |
| 5 | EF-README | Engineering Foundation | worker E | 5.2 |
| 6 | CMS-REF (draft now; merge after train 1 AR-2 and before train 2 T2-5) | get-modular | worker D | 5.2 |
| 7 | STANDARD-1a | `agent-teams-ai/.github` | worker D | 5.2 |
| 8 | FEATURE-STANDARD-2 (merge after CMS-REF) | `agent-teams-ai/.github` | worker D | 5.2 |
| 9 | PUBLISH-NATIVE design note (low priority) | agent-runtime | integrator | 5.7 |

**Wave 2b, only after the owner answers the named question in the decisions log:**

| Question | Cards |
|---|---|
| Q-CI-SCOPE | CI-CONTRACT-1 (implementer named by the answer) |
| Q-AUTH-FILE-CONFIRM and Q-AUTH-REFRESH-WINDOW | DOCS-1 part (c), then ACCESS-AUTH-FILE and ACCESS-REFRESH-GUARD in one pull request |
| Q-ISSUE-189-COMMENT | ISSUE-189-SYNC |

**Wave 3, after CI-CONTRACT-1 merges:** CONTAINED-FREEZE, STORE-1a, then LIB-JSONL, LIB-PROCESS, LIB-CODEX-1, LIB-CODEX-2, STORE-0, STORE-2-core, GOV-2; CMS-PIN-2 after CMS-REF; STANDARD-1b merged after LIB-JSONL. Their briefs are written after CI-CONTRACT-1 lands, because its outcome changes their file lists.

## 4. What not to touch

- embedded-runtime Host and Assembly source (`packages/apps/embedded-runtime/src/**/composition/**`, `ordinary-agent-runtime-host.ts`, `ordinary-runtime-assembly.ts`) before train 1 AR-2 merges. Test fixtures only if a card needs it. The same holds for `packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts` (train 1 AR-2 edits it).
- Contained-turn code: frozen (decision 32). Only mechanical import edits forced by moving shared parts. `ordinary-*` files inside `features/contained-agent-turn/` are active.
- Accepted ADR bytes, `architecture/c0/**`, historical `architecture/sdk-growth/*` evidence. Successor records only.
- Until CI-CONTRACT-1 merges: `scripts/ci/**`, `scripts/docs/consumer-migration.test.mjs`, `architecture/foundation/source-dependencies.yaml`, root `package.json` dependencies and scripts, package `test` scripts, `.github/workflows/*`.
- Repositories other than agent-runtime, Engineering Foundation, `agent-teams-ai/.github`, `agent-teams-ai/modularity-host-test` and get-modular. In get-modular only CMS-REF; the resources train there is another program.
- Persisted formats, SQL schemas, migrations.
- npm publication, release workflows that publish, repository rulesets, branch protection.
- Live Codex or any provider command on real projects. `pnpm check` stays synthetic.
- Other people's pull requests and issues, including stale draft #180: no comments, edits or closing.

## 5. Review and readiness

- One independent reviewer per pull request, with a fresh context, given the card text, the diff, this brief and the plan. After fixes, a new review on the new head.
- A pull request is ready for the owner only when the reviewer reports no unresolved P0, P1 or P2 finding, every review thread is resolved (the agent-runtime ruleset has `required_review_thread_resolution: true`) and required checks are green on the exact head.
- **Review checklist for every pull request:**
  1. The diff does only what the card says; no new feature, no speculative option.
  2. Every invariant the card names has a rejecting test that fails without the change.
  3. No accepted ADR bytes edited; every changed decision has a successor record registered in `docs/decisions/README.md` and `architecture/decisions/accepted-decisions.json`.
  4. Every disabled gate keeps its code and carries why, when to return, owner and review date.
  5. Registries and pins updated together: source policy plus its reversal step, census edges, ordinary scope, Feature Module Standard profile, workflow digests.
  6. No secret is logged, journaled or decoded into a JavaScript string; buffers zeroed.
  7. No local path, no email and no tool attribution (generated-by lines, co-author trailers) in code, comments, docs, commits or the pull request.
  8. Budget respected or the overrun explained.
  9. Local gates run on the final head (section 6) and CI `product` and `runtime-macos` evidence read, since local `pnpm check` does not run the product inventory check.

## 6. Environment and commands

- **Clone fresh** from `origin/main` for every pull request, with full history: `test:ci` reads `df9260b0` and `ccf6d6f8`. Branch names `<type>/<topic>`, for example `docs/ordinary-decision-records`; never `codex/...`.
- **agent-runtime toolchain:** Node 24.21.0 (`.node-version`; `engines` is `>=24.21.0 <25 || >=26.10.0 <27` with `engine-strict`), pnpm 11.18.0 (`corepack enable && corepack install --global pnpm@11.18.0`, then `pnpm install --frozen-lockfile`). Node 24.18 fails `pnpm install`.
- **Other repositories:** Engineering Foundation, modularity-host-TEST and get-modular use pnpm 11.20.0; `agent-teams-ai/.github` uses pnpm 11.18.0. Read each repository's `AGENTS.md`, checks and required contexts before the first change there.
- **agent-runtime checks, in this order, on the final head:**
  1. `pnpm check:changed` while working;
  2. `pnpm check:fast` before review (it also runs `pnpm docs:qualification`);
  3. `pnpm product:build && pnpm lint:typed` (`lint:typed` runs only in the full gate; wave 1 missed it);
  4. full `pnpm check` before marking the pull request ready;
  5. after push: CI `product` shards and `runtime-macos` evidence.
- **Known local failure:** `test:sdk-growth:source` fails on macOS because it needs Linux `/proc/self/fd`; CI on Linux is the authority. Say so in the pull request body.
- **PostgreSQL:** the required `postgres-durability` job is the authority. Local runs only against disposable clusters, through the variables the tests already use (`ORDINARY_TEST_POSTGRES_URL`, `ORDINARY_PA_TEST_POSTGRES_URL`, `PA_POSTGRES_DISPOSABLE_URL`, `RS_POSTGRES_DISPOSABLE_URL`, `AE_ACL_POSTGRES_DISPOSABLE_URL`, `POSTGRES_DURABILITY_URL`).
- **Required checks on agent-runtime main:** `commit-author-identity`, `check` (aggregate of the required lanes), `docs-protocol / docs-protocol-check`, `postgres-durability`, `runtime-macos` (an evidence aggregator over eight `macos-product` runners). Branches must be up to date. `codex-review` is not required and can fail on an infrastructure error; ignore it.

## 7. Gotchas

1. **CI contracts (plan section 2.3 item 1).** `scripts/ci/conformance.ts` compares root `package.json` metadata, the leaf command inventory and the source policy with the baseline `df9260b0`, asserts `.node-version`, freezes the platform digests that existed at `73c771f2` and hard-codes the `foundation` and `docs` pull request obligations; `scripts/docs/consumer-migration.test.mjs:136-210` authenticates the source policy through a chain of reversal steps; the product fanout accepts exactly six packages with exact `test` scripts (`scripts/ci/package-execution.ts`, `scripts/ci/product-fanout-contract.ts`, `scripts/ci/product-workflow-contract.ts`, matrices in `ci-product.yml` and `ci-darwin-packages.yml`). A new package, a new source-policy root or entrypoint, a changed package `test` script, a root dependency or a new `check` command fails required checks until CI-CONTRACT-1 lands.
2. **Source policy edits:** after any change to `architecture/foundation/source-dependencies.yaml`, add a reversal step for exactly the added lines at the top of the chain in `scripts/docs/consumer-migration.test.mjs:136-150` (pattern: the `comparatorAdmission` and `namespaceAdditions` steps), unless CI-CONTRACT-1 replaced the chain. Recheck after every rebase.
3. **Registries a new or moved source file touches:** the source policy (roots are directories, entrypoints are per file), `architecture/get-modular/consumer-profile.json` census edges (the check prints actual against expected; there is no write mode), `architecture/feature-module-standard/ordinary-scope.json`. A new package also needs `packageRoots`, a boundary, `architecture/foundation/quality-source-coverage.yaml` `compilerProjects`, the Feature Module Standard profile and the product fanout entries. Editing `architecture/feature-module-standard/candidate-profile.json` changes `fms.sha256` in `consumer-profile.json`.
4. **Workflow pins:** job definitions of `postgres-durability`, `runtime-macos` and `macos-product` and the bytes of `ci-darwin-packages.yml` are digest-pinned in `scripts/ci/platform-contract.json`; `postgres-durability` is also frozen to its `73c771f2` value by `scripts/ci/conformance.ts:305-306`; `scripts/ci/nightly-contract.ts:34-37` requires reused jobs to match the current `platform-contract.json`.
5. **Engineering Foundation bump pins** (GOV-1 later): `scripts/foundation/check-quality-adoption.mjs:22`, `architecture/sdk-growth/activation.json` `installedTooling` checked against the lock in `scripts/architecture/check-sdk-growth-profile.mjs:158-170`, the 1.6.0 pin at `:155`, the Docs managed target files, the consumer migration test and `scripts/ci/conformance.ts:289`. `399ffc22` is the reference: 31 files.
6. **SDK-growth:** `SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT` (`check-sdk-growth-profile.mjs:46`) rejects a new subpath of the six existing packages. New separate packages are not blocked by SDK-growth.
7. **Decision records:** create them with `pnpm docs:new`, then register each in the `Accepted` section of `docs/decisions/README.md` and in `architecture/decisions/accepted-decisions.json` with its immutable digest. Index files are not byte-frozen; `scripts/docs/verify-frozen-document-bytes.mjs:18-21` freezes ADR 0001-0005 and two spike patterns only.
8. **Merge order:** pull requests that touch shared registries merge one by one. Before each merge: rebase on the new main, recheck reversal steps and pins, rerun the full `check`, and ask for a new review if the diff changed beyond the rebase and pins.
9. **Consumer Module Standard pin** is get-modular `81063add` (#201), equal to upstream; its outstanding successor work is in `architecture/get-modular/evidence/smart-ci-cms-pin-review.json`. Do not migrate it outside CMS-PIN-2 (or train 2 AR-3, plan contradiction 16); train 1 AR-1a only verifies it.
10. **Merge guard behavior:** right after `gh pr ready`, the first call of the merge guard may be refused transiently; wait about 45 seconds and retry once.
11. **Review threads:** every review thread, including automated review comments, must be resolved before merge; the ruleset refuses the merge otherwise.
12. **Local `pnpm check` gap:** a changed package `test` script or a new package passes local `pnpm check` and fails only in CI `product` and `runtime-macos`.

## 8. Pull request rules

- One card per pull request, at most about 2000 changed lines (moves counted separately). Open it as a **draft**. For the cards in section 3 this brief authorizes: pushing the card branch, opening the draft pull request, editing its title and body, and marking it ready with `gh pr ready` after a clean review. Nothing else on GitHub: no comments on issues or other pull requests, no merge, no labels, no settings.
- **Identity:** author and committer come from the repository's git config (local first, then global). Never pass `-c user.*`, never take an email from anywhere else. The merge guard refuses commits whose author or committer is not the owner.
- **Commits:** conventional commits (`docs(decisions): ...`, `feat(surface): ...`, `fix(provider-access): ...`); reference an issue only when one exists (for example `Refs #189`); otherwise name the plan card in the body.
- **Owner identity only:** commits and pull requests carry only the owner's identity: no `Co-Authored-By` or generated-by lines in commit messages, pull request titles or bodies, code comments, docs or branch names.
- **Language and style on GitHub:** English, plain and friendly; no em-dashes, no fancy quotes; regular hyphens and quotes. Markdown lists and code blocks are fine. Write Agent Execution, Provider Access, Runtime Security, Engineering Foundation, Feature Module Standard, Consumer Module Standard and Engineering Quality Standard in full.
- **Body:** what changed and why (link the plan card and the decisions), what stays enforcing (for any gate change), verification (commands and results, known local failures), risks, budget used.
- **Merge:** only on an explicit owner command, through the owner merge guard in a checkout of `agent-teams-ai/.github`:

  ```sh
  node scripts/merge-owner-pr.mjs --repository agent-teams-ai/<repository> --pr <N> \
    --expected-head <full head SHA> --subject '<conventional commit subject>' --body-file <file>
  ```

  The body file is the squash message body without the auto-generated review-bot block. Never merge any other way.

## 9. Card instructions

Each card's specification is in the plan; the notes below add execution details, done criteria and card-specific review items.

### DOCS-1 parts (a) and (b), agent-runtime

- Branch `docs/ordinary-decision-records`. Two records through `pnpm docs:new`:
  - (a) Feature Module Standard owned deviation (decision 20) for `@agent-teams/ordinary-operations` and `@agent-teams/runtime-store-postgres`: scope, rationale (decision 12 and the Engineering Quality Standard library-first section from `.github` #328), owner, review trigger "agent-runtime adopts Feature Module Standard v2". Do not add the profile record: the governed-record schema needs exact checker diagnostics (`scripts/architecture/feature-module-profile.mjs:178-182`) that appear only with STORE-0 and ENGINE-1.
  - (b) Successor to ADR-0090 line 91 (decision 37): the launch recipe type lives in Agent Execution application (`OrdinaryLaunchRecipe` in `application/ordinary-ports.ts`, delivered by #193) and the recipe stays next to the config verification in Agent Execution.
- Register both (gotcha 7). ADR-0024 is reserved for train 1 AR-1c (cited by the AR-1c and AR-2 briefs and issue #189 brief 04): use the next free numbers after it.
- Done: records accepted and registered; `pnpm check:fast` and full `pnpm check` green; required checks green.
- Review items: no accepted ADR byte changed; the deviation names one owner, one contract and a review trigger.
- Budget 80-180 lines.

### DOCS-1 part (c), agent-runtime (after Q-AUTH-FILE-CONFIRM and Q-AUTH-REFRESH-WINDOW)

- Branch `docs/provider-access-token-source`. One successor record to ADR-0090 section "Provider Access and Runtime Security" (lines 104-111) stating the owner's answers: Provider Access reads `tokens.access_token` from the custodied `auth.json` with the strict parser and the drift check; the admitted helper sequence becomes `initialize`, `config/read`, `account/read`, `account/rateLimits/read`, `model/list`; the refresh facts (plan contradiction 12, proactive and 401 paths); what ACCESS-REFRESH-GUARD does under the chosen option (reading `exp` before the helper starts; with option a also the `CODEX_REFRESH_TOKEN_URL_OVERRIDE` loopback override and its sandbox deny rule).
- Register it. Merge before ACCESS-AUTH-FILE.
- Budget 40-100 lines.

### ACCESS-AUTH-FILE and ACCESS-REFRESH-GUARD, agent-runtime (after DOCS-1 part c)

- Branch `fix/provider-access-auth-file`. Files: `packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-*.ts` and `packages/contexts/provider-access/tests/features/contained-turn-access/ordinary-codex-auth.test.ts` with its fake helper. Keep the reader inside existing files (a new file needs a source-policy entrypoint).
- Implement exactly the parser rules, the bounded byte scanner, the drift check and the guard of plan section 5.3. Cite the upstream source lines you re-verified (section 1) in the pull request.
- Stop and ask if: the parser would need to accept a shape beyond ChatGPT `tokens` mode and the parity form without `auth_mode`; the bounded scanner does not fit the budget; upstream changed the refresh window, `refresh_token_endpoint`, `UnauthorizedRecovery` or `AuthDotJson`; the synthetic proof of the refresh endpoint block cannot be made without real credentials.
- Done: every acceptance case of both cards passes; the method sequence has no `getAuthStatus`; full `check` green.
- Review items: no `JSON.parse`, `toString`, `TextDecoder` or template string over the `refresh_token`, `id_token` or `OPENAI_API_KEY` ranges; the access token is decoded only where the existing code already does; `OPENAI_API_KEY` value never read; refusal codes unchanged; the `exp` check runs before the helper process is spawned and after its deadline is computed; with option a, the override and the deny rule are both present and the synthetic proof shows no request leaves; constants and the override carry the upstream source location.
- Budget 450-1000 lines for both.

### EF-SURFACE, Engineering Foundation

- Read Engineering Foundation `AGENTS.md` and `docs/architecture/executable-capabilities.md` first. This is a new Foundation-owned capability decided by the owner (decisions 24, 38), not an extraction: write it fresh, cite the decisions, copy no agent-runtime code. If the review applies the two-consumer extraction admission rule, stop and ask.
- Shape (decision 45, decided by the coordinator under the owner's delegation; the owner can override): one package-level `tier` under a configurable key (agent-runtime preset: `agentTeamsArchitecture.tier`); a budget is the maximum number of export names per entrypoint for that tier, set in the consumer preset; the publication marker is the npm signal (`private` absent plus `publishConfig.access`).
- Spec: plan section 5.2 EF-SURFACE (configurable tier key, names and kinds only, no build, `surface:update` and `surface:check`, boundary with `public-api-compatibility` documented).
- Validation before release: modularity-host-TEST and a draft agent-runtime branch through Engineering Foundation local mode. The agent-runtime branch is not merged; GOV-1 adopts the release later.
- Done: rejecting tests of the card pass; minor changeset; both validations reported in the pull request.
- Budget 700-1300 lines.

### STANDARD-1c and STANDARD-1d, Engineering Foundation

- Same admission note as EF-SURFACE.
- 1c: publication marker per decision 45; isolated single-root install check per plan section 5.2; validated like EF-SURFACE. Budget 300-600.
- 1d: change `public-api-compatibility` (`application/rules.ts:47`) so an approved break of a 0.x package can be backed by a changeset with "Breaking" and "Migration" paragraphs that bumps minor; packages at 1.0 or later are out of scope and keep today's rule; the changeset directory is configurable (default `.changeset/`). Do not add a parallel check. Budget 250-500.
- Review items: no product policy in the capability; configuration schema documented; rejecting tests for a 0.x break without a changeset, with a patch-level changeset, and for a 1.x break without an ADR.

### EF-README, Engineering Foundation

- Reword the README introduction from "for Agent Teams repositories" to neutral configurable mechanisms adopted through a small data preset, with Agent Teams conventions in the Engineering Quality Standard (decision 19). Text only. Budget 20-80.

### CMS-REF, get-modular

- Read get-modular `AGENTS.md` and the Consumer Module Standard maintenance rule. Amend `docs/architecture/common-assembly.md` through the get-modular successor process: "Feature Module Standard v1 or the successor pinned by the consumer profile" instead of "v1 ... remains the sole authority" (`:44-45`), and the sentence that a generated inventory with a committed, reviewed diff is review, not automatic legacy inventory expansion, without weakening `:526-527`. Update current guidance, examples and rejecting tests in the same pull request.
- Do not touch the train, capability ids or consumer pins.
- Timing: open the pull request as a draft now. Ask the owner to merge it only after train 1 AR-2 has merged in agent-runtime (the train 1 briefs stop when the standard changes before AR-1b, AR-1c or AR-2) and before train 2 T2-5 merges in get-modular (so T2-5 carries it), and never while a get-modular release pull request is open.
- Budget 20-80 lines.

### STANDARD-1a, `agent-teams-ai/.github`

- Add library conventions to `docs/engineering-quality-standard.md`: error `code` plus static `is()`; `signal` as the last parameter; discriminated outcomes; `close()` returning facts; zero or peer dependencies; no global singletons. Link the existing 0.x rule (`:90-96`) instead of repeating it. Text only. Budget 80-200.

### FEATURE-STANDARD-2, `agent-teams-ai/.github`

- `docs/architecture/feature-module-standard/v2.md` as a complete document with the six required markers (`tools/feature-module-standard/check.mjs:60, 79-88`), derived from v1 (blob `d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA-256 `851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`) plus the `LIBRARY_FIRST` evidence row (accepted repository decision naming one owner and one contract; a real consumer and a disposable test project in the same delivery), the extended extraction formula (`EXTRACT = READY AND (BOUNDARY OR REUSE OR PUBLIC_PROVIDER_SURFACE OR DEPENDENCY_LIFECYCLE)`, v1 line 462, gains `OR LIBRARY_FIRST`) and the adjusted "hypothetical future consumer" sentence (a hypothetical consumer alone is still not evidence); registry entry.
- Open the draft now; ask the owner to merge it only after CMS-REF merges (merging publishes an immutable version).
- Budget 100-180 lines beyond the copied v1 text.

### PUBLISH-NATIVE, agent-runtime (low priority)

- A short design note on how `filesystem-custody` ships `native/rename-no-replace.c` (built by `scripts/build-native-helper.mjs` with a closed recipe for linux-x64 and darwin-arm64): prebuilt optional per-platform packages or a JavaScript fallback, and the CI build that produces them. Decision proposal only, no build change. Budget 150-300.

### CI-CONTRACT-1 (after Q-CI-SCOPE)

- Spec: plan section 5.2. Agree the window with the CI workstream through the owner before starting and keep the train 1 window of plan section 6.3; rebase daily.
- Done: every rejecting test of the card passes; a simulated new package and a simulated source-policy root pass; required checks and CI `product` evidence green.

### ISSUE-189-SYNC (after Q-ISSUE-189-COMMENT)

- Only with the owner's explicit permission recorded in the decisions log. One friendly comment: test entry points are private workspace packages (decision 16); the work follows the issue #189 test debt briefs and starts after train 1 AR-2; the rejecting `./testing` test stays; contained-turn fixture copies and casts follow CONTAINED-REMOVAL; links to the plan and to `test-debt-189-plan.md`. No other GitHub action.

## 10. When to stop and ask the owner

- A precondition of section 1 differs from this brief or the plan.
- A card needs a design choice the card and the plan do not settle.
- A check fails for a reason outside the card, or passing it would need disabling a gate the card does not name.
- The change would touch any item in section 4.
- The pull request would exceed about 2000 changed lines.
- A secret path behaves differently from the facts in the plan.
- Any data or schema change, any publication, any live provider run.
- The owner merge guard refuses for a reason other than the transient refusal right after `gh pr ready`.

## 11. Reporting

After each pull request: link, exact head SHA, required check results, reviewer verdict and resolved findings, budget used, follow-ups for the plan. Keep the running log outside the repository.
