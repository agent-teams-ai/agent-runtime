---
id: runtime.architecture.test-debt-189-03-dependency-record-casts
type: architecture
status: active
owner: architecture
summary: "Brief 03 for issue 189: typed module dependency records and the cast check."
---

# Test Debt 189 03 Dependency Record Casts

**Brief 03: typed module dependency records and the cast check**

Issue: agent-teams-ai/agent-runtime#189, item 1 ("type module dependency fakes ... keep the casts that deliberately
feed broken input, with a short comment ... add a check that forbids `as never` on a module's dependency record").
Branch: `test/dependency-record-casts`. PR title: `test: reject type-erasing casts on module dependency records`.
Starts after AR-2 is merged (the conformance kit and the smoke tests arrive with AR-1c). Independent of briefs 01 and
02; merge after them to avoid conflicts in the embedded-runtime test files.

## 1. Re-verify before start

```sh
git fetch origin && git log --oneline -1 origin/main
cat .node-version; node --version; pnpm --version
grep -n "oxc-parser" pnpm-workspace.yaml                      # 0.147.0 on 2026-10-04; tooling.architecture may import it
git grep -n "parseSync" -- scripts/architecture | head -3     # existing users: ordinary-composition-evidence.mjs, check-consumer-module-standard.mjs
git grep -n "check-ordinary-feature-scope.test.mjs" -- scripts/architecture/check-get-modular-adoption.test.mjs
git grep -n -E "ModuleFactory<" -- 'packages/*/*/src/**' | head -20
git grep -n -P '\bas never\b' -- 'packages/*/*/tests/**.ts' | wc -l         # 638 on 5ac0d003 and 0ace1cce (package tests only; 706 in the whole repository)
grep -n '"@types/pg"\|"pg"' packages/apps/embedded-runtime/package.json   # pg only on 0ace1cce; commit 1 adds @types/pg
gh pr list -R agent-teams-ai/agent-runtime --state open --json number,title,files \
  --jq '.[] | select(any(.files[]; .path | test("check-get-modular-adoption|capability-bundle-contract|ordinary-composed"))) | "\(.number) \(.title)"'
```

Stop if the test-file import pattern no longer exists in `check-get-modular-adoption.test.mjs` (the gate was
restructured: ask where the check belongs), or if `oxc-parser` is no longer allowed for `tooling.architecture` in
`architecture/foundation/source-dependencies.yaml`.

Consumer Module Standard (CMS) pin, required by the workspace rule before this change:

```sh
node -p 'const p=require("./architecture/get-modular/consumer-profile.json"); p.standard.commit + " " + p.standard.sha256'
git clone --filter=blob:none --no-checkout https://github.com/agent-teams-ai/get-modular "$TMPDIR/gm-cms"
git -C "$TMPDIR/gm-cms" show origin/HEAD:docs/architecture/common-assembly.md | shasum -a 256; rm -rf "$TMPDIR/gm-cms"
```

If the two SHA-256 values differ, stop: the pin is migrated first, in its own reviewed step.

Derive the entry-point list (commit 3, step 1) from the merged code and record it in the PR body:

```sh
git grep -n -E "ModuleFactory<" -- 'packages/*/*/src/**'               # named module factories: rule (1)
git grep -n -E "bindFactory|createAgentRuntimeHost|createOrdinaryTurnFeature|createPostgresOrdinaryProviderAccessOwner|createNodeOrdinaryProcess" \
  -- packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts 'packages/apps/embedded-runtime/src/features/ordinary-session-runtime/**'
```

## 2. Scope and non-goals

In scope: (a) make the compiler see the test files that build Get Modular (GM) modules of the passive-setup and
ordinary compositions; (b) type or mark every type-erasing cast that sits on a dependency record of those modules;
(c) an AST check that keeps it so, inside the existing adoption gate.

Why (a) comes first (verified on `5ac0d003`): package `tsconfig.json` files include only `src/**/*.ts`, the root
`tsconfig.json` includes only a handful of agent-execution test support files, and `node --test` strips types without
checking them. So a typed fake in a package test is today never compared with its contract; removing a cast changes
nothing until the file is type-checked. The root `include` is the existing mechanism (`pnpm typecheck` runs
`tsc --project tsconfig.json` after `pnpm product:build` in both `check` and `check:fast`).

Measured on `5ac0d003` with a prototype of the check below: 4 sites.

| Site | Kind | Action |
|---|---|---|
| `packages/apps/embedded-runtime/tests/package/capability-bundle-contract.test.ts:73` `createAgentRuntimeHost(dependencies as never)` in the loop over `invalidDependencies` | deliberately malformed records | keep, add `// hostile-input: each record is malformed on purpose; the Host must refuse it` |
| same file `:108` and `:144` `createAgentRuntimeHost(dependencies as never)` | accessor-backed records that change on a second read | keep, add `// hostile-input: accessor-backed record that changes on a second read; the Host must snapshot it once` |
| `packages/contexts/agent-execution/tests/features/contained-agent-turn/ordinary-composed.test.ts:56-74` `const dependencies = {...} as unknown as OrdinaryTurnDependencies` passed to `createOrdinaryTurnFeature` | untyped fake | type it: `const dependencies = {...} satisfies OrdinaryTurnDependencies;` and fix the fakes until it compiles (for example `settle: async (disposition: "claim_committed" \| "abandoned_without_claim") => ...`, receipt helpers returning `OrdinaryReceiptOf<...>`) |

Re-run the check in report mode on the merged main (commit 3, step 3) for the current list; AR-1 may have added or removed sites.

Not in scope: type-checking contained-turn test files; the other ~630 `as never` lines (they are contained-turn tests or not on dependency records; owner
decision Q1 of the index, taken during planning on 2026-10-04); converting module tests to `isolate` (do it when a module's test is next rewritten);
production code; lint configuration.

## 3. Owner decisions and standard rules that apply

- CMS "Testing modules" rule 2: "Type fakes with `FactoryDependencies<C, typeof declaration>`. No `any`, `as never` or
  double cast on a dependency record." The check forbids exactly these three on dependency records; every other cast in
  tests stays allowed (issue text).
- Casts that feed deliberately broken input stay, with a short comment saying why (issue text). The comment format is
  fixed so the check can read it: `// hostile-input: <reason>` on the line of the cast or the line directly above it.
- The root `package.json` and the `check` command inventory are frozen (`scripts/ci/conformance.ts:171-179`): the
  check and its rejecting tests run inside `pnpm test:get-modular-adoption`, already in `check` and `check:fast`.
- Planner decision: an AST scanner, not a lint rule (oxlint custom rules need experimental JS plugins; type-aware rules
  would flag every cast and need governed suppressions).

## 4. Steps

### Commit 1 `test: type-check the test files that build Get Modular modules`

1. Select the files: every test file under `packages/*/*/tests` that calls `isolate`, `smoke`, `bindRuntimeSetup`,
   `createRuntimeSetupAttempt` or a name of `MODULE_ENTRY_POINTS` (step 1 of commit 3), except contained-turn files:
   drop a file whose file name (not directory: the agent-execution ordinary tests live in
   `tests/features/contained-agent-turn/`) contains `contained`, `linux-`, `darwin`, `route`, `http`, `custody`,
   `host-shutdown`, `network-trap` or `runtime-access-boundaries`, or whose path contains `/live/` (decision Q1: contained-turn stays out of #189).
   Skip `*.types.ts` files that already have their own `*.types.tsconfig.json`. On `5ac0d003` this keeps 20 files
   (13 embedded-runtime tests and fixtures under `tests/package`, `tests/helpers/assembly-direct-reference.ts`,
   3 agent-execution ordinary tests, 3 provider-access ordinary owner tests). Command:
   `git grep -l -E "isolate\(|smoke\(|bindRuntimeSetup\(|createRuntimeSetupAttempt\(|createAgentRuntimeHost\(|createOrdinaryTurnFeature\(|createPostgresOrdinaryProviderAccessOwner\(|createNodeOrdinaryProcess\(" -- 'packages/*/*/tests/**.ts'`
   then drop the contained-turn paths. Record the list in the PR body.
2. Add them to the root `tsconfig.json` `include`, one entry per file (no globs), next to the existing agent-execution
   entries. Run `pnpm product:build && pnpm typecheck`.
2a. `packages/apps/embedded-runtime/package.json` `devDependencies` gains `"@types/pg": "catalog:"` (the catalog pins
   8.23.1; `test.embedded-runtime` in `source-dependencies.yaml` already allows `@types/pg`; agent-execution,
   provider-access and runtime-security declare it the same way). Without it `ordinary-runtime-assembly.test.ts` fails
   with `TS7016: Could not find a declaration file for module 'pg'`. `pnpm install`, then
   `pnpm install --frozen-lockfile`; `pnpm foundation:check` exit 0.
3. Fix every reported error in those files and in the fixtures they import, only by: type annotations, `satisfies`,
   typed stubs (`function unavailable(): never` pattern), narrowing, `import type` of existing exported types, and a
   `// hostile-input: <reason>` mark where a value is deliberately invalid. Outside dependency records (CMS rule 2
   restricts only those), a single `as T` assertion or a double cast is allowed, each with a one-line reason comment
   (for example a mocked `ChildProcess` whose `pid` is read-only, or a value the domain codec does not type as
   canonical). Removing a branch that an earlier assertion makes unreachable (TS2367) is allowed when no assertion
   changes. Exporting an existing type from an internal module that tests already import is allowed; nothing else in
   production code changes.
4. Calibration: measured at `0ace1cce` before AR-1, the 20 files give 57 errors in 10 files
   (`ordinary-node-process.test.ts` 23, `ordinary-runtime-assembly.test.ts` 12 including TS7016,
   `ordinary-composed.test.ts` 5, `ordinary-auth-host-disposal.fixture.ts` 4, `codex-setup.e2e.test.ts` 4,
   `assembly-packed-consumer.test.ts` 3, the rest 1-2 each). Zero errors right after step 2 means the files were not
   added: stop. Stop and report the count per file if the total exceeds 150, or if any file would need a changed
   assertion or a production change beyond step 3.

Gates: `pnpm product:build && pnpm typecheck`, `pnpm --filter @agent-teams/embedded-runtime test`,
`pnpm --filter @agent-teams/agent-execution test`, `pnpm lint`. No assertion changes.

### Commit 2 `test: type or mark every cast on a module dependency record`

1. Apply the actions of the table in section 2 (plus any new site the report mode of commit 3, step 3, lists).
2. Gates: `pnpm product:build && pnpm typecheck`, `pnpm --filter @agent-teams/agent-execution test`,
   `pnpm --filter @agent-teams/embedded-runtime typecheck`, `pnpm --filter @agent-teams/embedded-runtime test`, `pnpm lint`.
   No assertion changes.

### Commit 3 `test(architecture): reject type-erasing casts on module dependency records`

1. New `scripts/architecture/module-dependency-casts.mjs`, using `parseSync` from `oxc-parser` like
   `ordinary-composition-evidence.mjs`. Exports:

   - `MODULE_ENTRY_POINTS`: a frozen, sorted array of names whose first argument is a module dependency record:
     (1) every named export typed `ModuleFactory<...>` under `packages/*/*/src`; (2) every function to which a module
     factory of the passive or ordinary root passes its slot values as first argument; (3) every function whose first
     parameter is the Host-supplied factory record of a module group (on the AR-1b plan: `createOrdinaryModuleFactories`).
     On `5ac0d003` rule (2) gives `createAgentRuntimeHost`, `createOrdinaryTurnFeature`,
     `createPostgresOrdinaryProviderAccessOwner`, `createNodeOrdinaryProcess`. Above the array, a comment: "Add a module's factory or the function it passes its slot
     values to when a module is added; the check fails on a name that no longer exists."
   - `findDependencyRecordCasts(path, source)`: returns `{ path, line, kind, entry }[]` for one file.
   - `checkModuleDependencyCasts(root)`: enumerates `packages/*/*/tests/**` files ending in `.ts`, `.mts`, `.cts`
     (skip any path segment `node_modules` or `dist`) with `readdir(..., { recursive: true })`, runs
     `findDependencyRecordCasts`, and throws one `AssertionError` listing every `path:line kind (entry)`; it also throws
     when a name of `MODULE_ENTRY_POINTS` appears in no `export` statement of any `packages/*/*/src/**/*.ts` file.

   Exact rules of `findDependencyRecordCasts`:

   - A parse error is a violation (fail closed).
   - Dependency record expressions:
     (P1) the value of the `dependencies` property of the object literal passed as second argument of a call to
     `isolate`, where `isolate` is the local name of the named import from `@get-modular/conformance` (respect `as`
     renames; also `<namespace>.isolate`);
     (P2) the first argument of a call or `new` expression whose callee is an identifier, or a member expression whose
     property name, is in `MODULE_ENTRY_POINTS`;
     (P3) the expression of `<expr> satisfies FactoryDependencies<...>`, and the initializer of a variable whose type
     annotation is `FactoryDependencies<...>`.
   - Inside a record expression, inspect the expression itself and, recursively, object literal property values, array
     elements, spread arguments, parenthesized expressions, the branches of conditional expressions and the operands of
     logical expressions. Do not descend into function bodies, call or `new` arguments, member expressions, template
     literals or class bodies (a fake method that returns malformed data is not a record cast).
   - One hop: when an inspected position is an identifier bound by a `const` declarator with an initializer in the same
     file, inspect that initializer by the same rules, without further hops. A `for...of` binding is not followed
     (`capability-bundle-contract.test.ts:73` casts inside `for (const dependencies of invalidDependencies)`, and the
     cast itself is at the call).
   - P1-P3 sites are searched in the whole file, including nested functions and test callbacks; the no-descent rules
     apply only inside a record expression.
   - Type-erasing assertion: a `TSAsExpression` or `TSTypeAssertion` whose type is `never` or `any`, or whose operand
     (after parentheses) is itself an assertion to `unknown`, `never` or `any`. Inspection also descends into the
     operand of `TSAsExpression`, `TSTypeAssertion`, `TSSatisfiesExpression` and `TSNonNullExpression`. Kinds reported:
     `as never`, `as any`, `as unknown as`, `as any as`, `as never as`, `<never>`, `<any>`. Report one violation per
     outermost type-erasing assertion; do not descend into the operand of an assertion already reported (a double
     cast gives one `as any as`, not also `as any`).
   - Exemption: a line comment whose text matches `^\s*hostile-input:\s*\S` that ends on the assertion's start line or
     the line directly above. `// hostile-input:` with nothing after the colon is itself a violation.

2. New `scripts/architecture/module-dependency-casts.test.mjs` (synthetic sources as strings; no filesystem except the
   last two cases):

   | Test | Must hold |
   |---|---|
   | rejects `as never` in isolate dependencies | `isolate(api, { declaration, factory, dependencies: { db: fake as never } })` gives one violation, kind `as never` |
   | rejects a renamed import and a namespace call | `import { isolate as build } from "@get-modular/conformance"` and `conformance.isolate(...)` are both checked |
   | rejects one-hop const records | `const deps = { ... } as unknown as X; isolate(api, { ..., dependencies: deps })` gives kind `as unknown as` |
   | rejects entry-point records | `createAgentRuntimeHost(dependencies as never)` and `new` with an entry name; `as any` and `<never>x` forms |
   | rejects `satisfies FactoryDependencies` and annotated records | both P3 forms |
   | rejects double casts through `any` and `never` | `createAgentRuntimeHost(x as any as Deps)` and `createAgentRuntimeHost((x as never) as Deps)` give kinds `as any as` and `as never as` |
   | accepts a reasoned exemption | the same cast with `// hostile-input: malformed on purpose` above it gives no violation |
   | rejects an empty exemption | `// hostile-input:` gives a violation |
   | ignores other positions | `foo(x as never)`, a fake method body `{ async execute() { return x as never; } }`, `x as const`, `x as Port` give none |
   | fails closed on parse errors | an unparsable source gives a violation |
   | flags stale entry points | `checkModuleDependencyCasts` on a temporary directory whose `src` exports none of a name throws naming it |
   | the repository has no type-erasing cast on a module dependency record | `await checkModuleDependencyCasts(fileURLToPath(new URL("../../", import.meta.url)))` resolves (the live scan) |

3. Report mode for commit 2 (local only, not committed; run it before commit 2): call `findDependencyRecordCasts` over the test files
   with a throwaway `node -e` script and print the list. Expect the 4 sites of section 2 on an unchanged base.

4. Wire it in without touching `checkAdoption(root)` (its tests run it on synthetic disk fixtures that have no
   `packages/*/*/src`, so a scan there would fail them) and without changing any `package.json` script:
   - the live scan is the last test of `module-dependency-casts.test.mjs` (table above);
   - `scripts/architecture/check-get-modular-adoption.test.mjs`: next to the existing
     `import {profile as ordinaryScopeProfile} from './check-ordinary-feature-scope.test.mjs';`, add
     `import './module-dependency-casts.test.mjs'; // Registers the dependency-record cast tests in this gate.`
   The live scan then runs in `pnpm test:get-modular-adoption` (in `check:fast` and in the architecture lane).

5. `docs/architecture/get-modular-adoption.md`: one paragraph in the section on tests or enforcement: what counts as a
   dependency record (P1-P3), the forbidden kinds, the `hostile-input:` comment, where the list of entry points lives,
   and that the module test files are type-checked through the root `include`. Update the norm row "Testing 1 and 2"
   in that document's pin review table and in `architecture/get-modular/evidence/train-030-cms-pin-review.json`
   (`normDisposition`: `state` and `closedBy` only, as AR-1b, AR-1c and AR-2 do; `check-cms-pin.mjs` hashes only the
   retained standard bytes and the delta, not the review JSON): state "met for passive-setup and ordinary module
   tests: type-checked through the root include; an AST check rejects type-erasing casts on dependency records";
   append to `closedBy`, keeping its history (for example "AR-1b, AR-1c, issue #189").

## 5. Gates (exit 0 each)

Per commit: `pnpm lint`, `pnpm test:get-modular-adoption`, `pnpm architecture:get-modular-adoption`,
`pnpm test:consumer-modules`, `pnpm foundation:check`, plus the package gates of commit 1.

Full gates. On Linux: `pnpm check:fast` and `pnpm check`, exit 0 each. On macOS, `test:sdk-growth:source` reads
`/proc` and fails, also on unmodified `origin/main` (confirm that once on the base); `check:fast` and the architecture
lane stop at it, so run every step of the chains except that one, stopping at the first failure:

```sh
( # subshell: `exit 1` ends only the loop, not an interactive shell
for chain in check:fast check:ci:quick check:ci:foundation check:ci:architecture check:ci:docs check:ci:product; do
  for s in $(node -p "require('./package.json').scripts['$chain'].replaceAll('pnpm ', '').split(' && ').join(' ')"); do
    [ "$s" = test:sdk-growth:source ] && continue
    pnpm "$s" || { echo "FAILED: $chain -> $s"; exit 1; }
  done
done
)
```

CI on Linux stays the authority for `test:sdk-growth:source`. If git fixture tests fail because of a global git hook,
create a config that holds only your identity,
`printf '[user]\n\tname = %s\n\temail = %s\n' "$(git config --local user.name)" "$(git config --local user.email)" > "$TMPDIR/gitconfig-user-only"`,
and prefix the commands with `GIT_CONFIG_GLOBAL="$TMPDIR/gitconfig-user-only"`. CI on the PR head: `check`,
`docs-protocol / docs-protocol-check`, `postgres-durability`, `runtime-macos`, `commit-author-identity` green.

## 6. Risks and stop conditions

- A site cannot be typed without changing what the test asserts: stop and ask whether it is a deliberate invalid
  input (then mark it) or a test to rewrite.
- `satisfies OrdinaryTurnDependencies` exposes a real mismatch between the fake and the port (for example a receipt
  shape): fix the fake to the port; if the port itself looks wrong, stop and report.
- The live scan takes more than 5 seconds (a prototype scanned 582 files in about 1.4 s): report it.
- Foundation rejects a new import in `scripts/architecture` (for example `node:fs/promises` `readdir`): use what the
  boundary allows; if nothing fits, stop.
- Do not widen the check to contained-turn entry points or to all casts: decision Q1 keeps contained-turn out of #189.

## 7. Must not

- Add a root script, a root dependency, a lint rule or a suppression entry; change `checkAdoption`; change any
  `package.json` other than the `@types/pg` line of commit 1.
- Mark a cast `hostile-input` that is not a deliberately invalid input; mark nothing in production code.
- Change other tests' assertions; touch contained-turn tests beyond the table in section 2.
- Use destructive git commands or a non-local git identity; mention AI tools anywhere.

## 8. Done when

- The selected test files are in the root `tsconfig.json` `include` and `pnpm typecheck` passes.
- `pnpm test:get-modular-adoption` runs the 12 tests of `module-dependency-casts.test.mjs`, including the live
  scan of the repository, and passes; `checkAdoption` is unchanged.
- The 3 deliberate casts carry a `hostile-input:` reason; `ordinary-composed.test.ts` has no cast on its record.
- No `package.json` script changed; gates in section 5 green.

## 9. Review checklist

1. Re-run section 1; compare the PR body's `MODULE_ENTRY_POINTS` with the two `git grep` commands of section 1.
2. Mutation: delete one `hostile-input:` comment in `capability-bundle-contract.test.ts`; `pnpm test:get-modular-adoption`
   must fail naming that file and line. Revert.
3. Mutation: in any embedded-runtime test, add `createOrdinaryTurnFeature({} as any)`, then
   `createOrdinaryTurnFeature({} as any as OrdinaryTurnDependencies)`; `pnpm test:get-modular-adoption` must fail with
   kinds `as any` and `as any as`. Revert.
4. Mutation: rename one name in `MODULE_ENTRY_POINTS` to a misspelling; `pnpm test:get-modular-adoption` must fail
   as stale. Revert.
5. Mutation: in a fake method body inside a record, add `return value as never;`; `pnpm test:get-modular-adoption` must
   not fail (documented scope). Revert.
6. Read the scanner: it does not descend into function bodies or call arguments, follows exactly one const hop, and
   fails closed on parse errors.
7. `git diff origin/main -- package.json scripts/ci .github` is empty; `git diff origin/main -- 'packages/*/*/package.json'`
   shows only `"@types/pg": "catalog:"` added to embedded-runtime `devDependencies`; `checkAdoption` in
   `check-get-modular-adoption.mjs` is unchanged.
8. Mutation (types): in `ordinary-composed.test.ts`, change one fake's `settle` parameter type to `number`;
   `pnpm product:build && pnpm typecheck` must fail. Revert. Then remove that file from the root `include` in a scratch
   edit: the same mutation passes, which is why the `include` entries matter.
9. Confirm every selected file from the PR body is in the root `include`, and that no contained-turn file was added.
