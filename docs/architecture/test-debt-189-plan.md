---
id: runtime.architecture.test-debt-189-plan
type: architecture
status: active
owner: architecture
summary: "Index of the issue 189 test debt briefs: measurements, decisions, order and dependencies."
---

# Test Debt 189 Plan

**Issue #189 test debt: brief index**

Status: active. Measured on agent-runtime `origin/main` = `5ac0d003` and re-verified on `0ace1cce`
(2026-10-04; same numbers, the delta is CI and docs only), get-modular
`origin/main` = `81063ad`, and the Get Modular train 1 migration briefs AR-1a, AR-1b, AR-1c, AR-2 (written the same
day; they say what the migration itself changes). Nothing here is implemented. Each brief is self-contained: hand one
brief to one implementer, and its review checklist to an independent reviewer.

Issue: agent-teams-ai/agent-runtime#189 "Clean up test debt: typed fakes, shared fixtures, handle guards".

## 1. What re-measuring changed (read this first)

The issue was written from numbers taken at `b0bcb265`. On `5ac0d003`, and after the AR-1/AR-2 briefs:

| Issue says | Measured | Consequence |
|---|---|---|
| 638 lines with `as never` in 157 of 709 test files, 118 `as unknown as` | 638 lines in 158 files (582 `.ts` test files, 716 test files of all types), 119 `as unknown as`, 36 `as any` (AST count). Only 3 `as never` lines and 1 `as unknown as` are in passive-setup or ordinary test files; about 99 % are in contained-turn tests | Decision Q1 (section 3). |
| "Type module dependency fakes ... so the compiler catches a fake that drifted" | Package test files are not type-checked at all: package `tsconfig.json` files include only `src/**/*.ts`, the root `tsconfig.json` includes 5 agent-execution test support entries, `node --test` only strips types. Only 3 test files are compiled, each by its own tsconfig inside a test (2 `*.types.ts` files and `live/linux-codex-live-bootstrap.ts`). A `tsc` probe at `0ace1cce` over the 20 GM-module test files of brief 03 gave 57 errors in 10 files | Typed fakes catch nothing until their file is type-checked. Brief 03 adds the test files that build GM modules to the root `include` (existing mechanism inside `pnpm typecheck`) with a stop threshold. The AR-1 briefs' "touched fakes are typed" is likewise unverified until then (told to their planner). |
| "No `as never` on module dependency records" | A prototype AST scan of dependency-record positions of Get Modular (GM) modules finds 4 sites: `capability-bundle-contract.test.ts:73`, `:108`, `:144` (deliberately malformed or accessor-backed records; keep with a reason comment) and one untyped fake, `agent-execution/.../ordinary-composed.test.ts:56-74` | Brief 03: small, enforceable check. |
| 35 copied fixtures; `contained-turn-kernel-fixtures.ts` drifted (236 vs 340 lines) | 35 files: 7 byte-identical, 15 identical except import lines, 13 drifted (12 by 1-7 non-import lines, `contained-turn-kernel-fixtures.ts` by 121). All serve contained-turn tests only (28 test files). Originals import internal `dist/features/...` paths, copies import the public `./composition` subpaths | Decision Q1; brief 06. |
| "Nothing calls `getActiveResourcesInfo` ... `--test-force-exit` hides it" | No package uses `--test-force-exit` (also not at `b0bcb265`). Experiments on Node 24.21.0: without it a leaked referenced handle hangs the file and the guard's failure appears only when the process is killed; with it and no guard the leak is silently green; with it and a per-file guard registered last, the file fails with `conformance.handles.leaked` and exits; a preload guard runs before the file's own `after` hooks (FIFO) and reports false leaks | Decision Q2; brief 04. |
| Smoke per composition root; `isolate`; conformance kit | AR-1b makes the root a function of Assembly (`composeRuntimeSetup`); AR-1c adds `@get-modular/conformance` 0.1.0 (development-only), one `smoke` per profile (passive 15 steps, ordinary 31) and one `isolate` test | Not repeated here. Brief 02 only retires the per-module failure sweep that smoke replaces. |
| `OrdinaryRuntimeFactories` (`ordinary-runtime-assembly.ts:53-61`), `HostInputs` (`runtime-setup-assembly.ts:198-208`) | Confirmed on `5ac0d003`. AR-1b adds `ModuleFactory`-typed module factories and derives `HostInputs` from the ordinary Host declaration (B3). AR-1c keeps `OrdinaryRuntimeFactories` on purpose as the Host's port for effectful constructors (shape stays), with hand-written value types and new `resources` parameters | Brief 01 only reads the value types of `OrdinaryRuntimeFactories` from the descriptors (agreed with the AR-1 planner). |
| Hand-written `deferred()` helpers | 11 helpers in test files build a promise by hand, 9 of them in contained-turn files (2 in the fixture copies); 12 more already use `Promise.withResolvers`; 1 hand-written helper is in production source (out of scope) | Brief 05 changes the 2 helpers outside contained-turn (decision Q1). |
| Contract suites | CMS rule 3: a suite is required "once a capability has two implementations, the fake included". The AR-1a pin review records "Testing 3: outstanding; scope and owner are an owner decision (candidates: #189 or the storage compatibility suites)". Ordinary tests contain single-scenario behavioural doubles (`ordinary-host-ownership.fixture.ts`, `ordinary-composed.test.ts:57-73`: providerAccess, security, workspace, process, provider and a store) and throwing stubs; none is an owner fake reused by other tests. The storage program (STORE-2-core) already plans compatibility suites for the store port | Decision Q3; brief 07. |

Gates the issue does not mention, verified on `5ac0d003`, that every brief respects:

- `scripts/ci/conformance.ts:171-179` (run by `pnpm test:ci` in `check:ci:quick`) freezes the root `package.json`
  `dependencies`, `devDependencies`, `engines`, `packageManager` and, through `assertFullInventory`
  (`scripts/ci/policy.ts:53-84` on `0ace1cce`), the full leaf-command inventory of `check` and `check:fast`. No brief adds a root
  script, a root dependency or a new leaf command; new checks live inside commands that already run.
- `scripts/architecture/ar2-test-execution-inventory.mjs:16-25` (reached by `pnpm test:ar2-contract`) requires the
  `test` script of agent-execution, runtime-configuration and runtime-security to match
  `^node --test(?: --test-concurrency=1)?(?: tests\/[A-Za-z0-9._/*-]+\.test\.(?:ts|mjs))+$` and embedded-runtime's to
  stay `node scripts/run-package-tests.mjs`. No brief changes those three `test` scripts.
- agent-runtime is a public repository: briefs and PR texts contain no local paths, host names or tool names.
- Local gates on macOS: `test:sdk-growth:source` reads `/proc` and fails there, also on unmodified main (9 of 16 tests
  fail), and `check:fast` and the architecture lane stop at it. Every brief therefore gives a loop that runs every step
  of the chains except that one; CI on Linux stays the authority for it.

## 2. Owner decisions these briefs rely on (facts)

- agent-runtime moves to GM train 1 first (AR-1a, AR-1b, AR-1c, AR-2); #189 is a separate executor after AR-2.
- Gates are never deleted; a gate in the way is disabled with a comment (reason, restore condition) only where a brief
  says so.
- Unit tests only for risky places; nothing that mirrors the implementation.
- Required checks: `check`, `docs-protocol / docs-protocol-check`, `postgres-durability`, `runtime-macos`,
  `commit-author-identity` (ruleset checked 2026-10-04).
- Owner test entry points are private workspace packages from the storage program (STORE-0), never a `./testing`
  subpath (program plan decisions 16 and 23, section 6.4; `packages/contexts/agent-execution/tests/package/testing-subpath-packed-consumer.test.ts`).
- Contained-turn is not developed further; ordinary is the only active path (program plan decision 1).
- Consumer Module Standard (CMS, get-modular `docs/architecture/common-assembly.md`, "Testing modules", rules 1-8) is
  the authority. Rule 2: "No `any`, `as never` or double cast on a dependency record." It is stricter than the issue
  ("other casts stay allowed") on dependency records and wins as the newer pinned standard; outside dependency records
  every cast stays allowed.

Planner decisions (each restated in the brief that applies it):

- The cast check is an AST scanner with a live-scan test registered in the adoption gate's test command
  (`check-get-modular-adoption.test.mjs`, `pnpm test:get-modular-adoption`); `checkAdoption` is unchanged. Not a lint
  rule (oxlint custom rules need experimental JS plugins; a new root script breaks the frozen inventory).
- A cast that deliberately feeds invalid input stays, marked `// hostile-input: <reason>` so the check can read it.
- The per-module failure sweep shrinks to two Agent Runtime error-projection cases (`codexConfiguration`, `host`)
  once smoke covers every module.
- Test files that build GM modules join the root `tsconfig.json` `include`; contained-turn test files stay unchecked (decision Q1).

## 3. Decisions on the former open questions

Decided during planning on 2026-10-04 (the owner delegated technical choices), consistent with the owner decision
"contained-turn is not developed further". Each affected brief states them as facts.

- **Q1 = A. Contained-turn test debt.** #189 covers the Get Modular modules only (passive setup, ordinary). The 35
  fixture copies and the contained-turn casts are settled by the CONTAINED-REMOVAL decision: deleted with
  contained-turn, or migrated through STORE-0's private test packages if contained-turn stays. The docs PR updates
  program plan section 6.4. Brief 06 records this outcome; nothing is implemented for item 2 beyond brief 07.
  (Not chosen: B, migrate everything now; C, keep copies with a drift check.)
- **Q2 = A. Handle guards.** Guard plus `--test-force-exit` only where the whole test process is guarded now: a
  dedicated guarded process in embedded-runtime's launcher and the whole filesystem-custody `test` command, each with
  a test that every file of a force-exit process checks its handles last (filesystem-custody gains
  `@get-modular/conformance`, and its peers if pnpm requires them, as development dependencies only). For that, the
  planning widened ADR-0024 while it is still proposed (it is created in AR-1c): `@get-modular/conformance` is allowed as a
  development-only dependency of the test code of the Agent Runtime packages that guard handles (Embedded Runtime and
  Filesystem Custody), never imported by production code; brief 04 stops if the accepted ADR-0024 lacks it.
  agent-execution, provider-access and runtime-security get guards when their process, socket and pool code moves to
  LIB-PROCESS, LIB-CODEX-1 and STORE-2-core, whose cards gain "guard plus force-exit from the first test" (docs PR).
  (Not chosen: B, all five packages now with an AR2 inventory change; C, guards without force-exit.)
- **Q3 = A. Contract suites.** One suite now, for `agent-runtime/ordinary/store`, owned by the ordinary feature, run
  against the owner's in-memory fake in the package tests and against the PostgreSQL store in `postgres-durability`,
  with port-level cases that STORE-2-core later moves unchanged into the private storage compatibility package
  (brief 07). Interpretation of CMS rule 3, decided during planning: rule 3 applies to contracts that have a second
  behavioural implementation; single-scenario stubs inside one test file are not implementations; each other ordinary
  contract is recorded as "no second implementation" in the pin review. (Not chosen: B, leave suites to STORE-2-core;
  C, suites for all 18 capabilities.)
- **Brief 05 scope (planning decision, 2026-10-04).** Following Q1, brief 05 changes only the two hand-written `deferred()` helpers
  outside contained-turn test files; the nine contained-turn helpers stay with CONTAINED-REMOVAL.

## 4. Briefs, order and dependencies

| # | Brief | Branch | Starts after | Size (changed lines) |
|---|---|---|---|---|
| 01 | `test-debt-189-01-derived-composition-types.md`: read the value types of `OrdinaryRuntimeFactories` from the descriptors (shape unchanged; `HostInputs` is done by AR-1b); one structural test (adds `oxc-parser` as an embedded-runtime development dependency) | `refactor/derived-composition-types` | AR-2 | 20-60 |
| 02 | `test-debt-189-02-retire-failure-sweep.md`: the 7-case sweep becomes two projection cases; smoke (AR-1c) covers the rest | `test/retire-failure-sweep` | AR-2 | 20-60 |
| 03 | `test-debt-189-03-dependency-record-casts.md`: type-check the 20 GM-module test files, type the 1 untyped record, mark the 3 deliberate invalid inputs, AST check in the adoption gate | `test/dependency-record-casts` | AR-2; merge after 01-02 | 300-700 (stop above 150 type errors) |
| 04 | `test-debt-189-04-handle-guards.md`: guards plus `--test-force-exit` per decision Q2 | `test/handle-guards` | AR-2; merge after 03 | 150-300 |
| 05 | `test-debt-189-05-promise-with-resolvers.md`: the 2 hand-written `deferred()` helpers outside contained-turn | `test/promise-with-resolvers` | AR-2; merge last | 5-20 |
| 06 | `test-debt-189-06-fixture-copies.md`: outcome of decision Q1, nothing to implement; recorded by the docs PR | - | - | 0 |
| 07 | `test-debt-189-07-ordinary-store-contract-suite.md`: port-level cases, owner in-memory fake, `contractSuite` for `agent-runtime/ordinary/store`, fake run in package tests, PostgreSQL run required in `postgres-durability` | `test/ordinary-store-contract-suite` | AR-2 and 03; an open STORE-1a port change goes first or waits (asked at start) | 350-600 |

Merge order: 01 -> 02 -> 03 -> 04 -> 07 -> 05. Briefs 01, 02 and 05 can be developed in parallel; 03, 04 and 07 touch
the embedded-runtime test files, the launcher or the root `tsconfig.json` `include`, so they rebase after the earlier
merges. Brief 07 also works before 04 (it then puts its files in the first launcher process, with the guard idiom). Every PR has
its own independent reviewer and a re-review after fixes; the owner merges.

Shared preconditions (each brief re-verifies them in its section "Re-verify before start"):

1. AR-1a, AR-1b, AR-1c and AR-2 are merged. Titles are not a reliable signal; check facts: catalog on Core/Assembly
   0.3.x, resources 0.1.x and conformance 0.1.x; `composeRuntimeSetup` exists; `smoke(` appears in the embedded-runtime
   tests.
2. On 2026-10-04 none of Core/Assembly 0.3.0, resources 0.1.0 or conformance 0.1.0 is published; #189 cannot start
   before the R-1b publication and the AR migration.

## 5. Where the briefs live in agent-runtime

Same rules and pattern as the train 1 migration briefs: `architecture` documents are a flat collection in
`docs/architecture/` (`architecture/foundation/document-authoring.yaml`: `placement: collection`, `filename: slug`,
owner `architecture`, reachability through `docs/architecture/README.md`); no subdirectories; `research/` is not
authority.

| File | id |
|---|---|
| `docs/architecture/test-debt-189-plan.md` (this index) | `runtime.architecture.test-debt-189-plan` |
| `docs/architecture/test-debt-189-01-derived-composition-types.md` | `runtime.architecture.test-debt-189-01-derived-composition-types` |
| `docs/architecture/test-debt-189-02-retire-failure-sweep.md` | `runtime.architecture.test-debt-189-02-retire-failure-sweep` |
| `docs/architecture/test-debt-189-03-dependency-record-casts.md` | `runtime.architecture.test-debt-189-03-dependency-record-casts` |
| `docs/architecture/test-debt-189-04-handle-guards.md` | `runtime.architecture.test-debt-189-04-handle-guards` |
| `docs/architecture/test-debt-189-05-promise-with-resolvers.md` | `runtime.architecture.test-debt-189-05-promise-with-resolvers` |
| `docs/architecture/test-debt-189-06-fixture-copies.md` (outcome record) | `runtime.architecture.test-debt-189-06-fixture-copies` |
| `docs/architecture/test-debt-189-07-ordinary-store-contract-suite.md` | `runtime.architecture.test-debt-189-07-ordinary-store-contract-suite` |

Docs PR (branch `docs/test-debt-189-briefs` from fresh `origin/main`, ideally after the train 1 briefs' docs PR so
`docs/architecture/README.md` does not conflict):

1. `pnpm install --frozen-lockfile`; for each file
   `pnpm docs:new -- --type architecture --id <id> --title "<title>" --owner architecture --summary "<one line>" --dry-run`,
   check the destination equals the table (if the tool derives another slug, use it and fix cross-references), then
   the same command with `--apply`; replace the generated body below the frontmatter with the brief text.
2. Replace the staging status line of this index with "Status: active" and keep the measured revisions; section 3
   stays as the record of decisions.
3. `docs/architecture/README.md`: one bullet per document in the "Documents:" list.
4. `docs/architecture/agent-runtime-architecture-program-plan.md`: lane row "Issue #189 test debt" (section 4.1) and
   section 6.4 per section 3 (copies and contained casts move to CONTAINED-REMOVAL); add "handle guard plus
   `--test-force-exit` from the first test" to the acceptance of LIB-PROCESS, LIB-CODEX-1 and STORE-2-core; add to
   STORE-2-core that it moves `packages/apps/embedded-runtime/tests/features/ordinary-session-runtime/support/ordinary-store-cases.ts`
   (brief 07) unchanged into the private storage compatibility package (STORE-0 mechanism), runs it against its
   adapters and makes Embedded Runtime import it from there; it never copies the file.
5. Gates (exit 0): `pnpm docs:check`, `pnpm docs:protocol:check`, `pnpm docs:qualification`, commit
   `docs(architecture): add the issue 189 test debt briefs`, then the full gates as in the briefs (Linux `pnpm check`;
   on macOS the loop that skips only `test:sdk-growth:source`); CI `docs-protocol / docs-protocol-check`.
