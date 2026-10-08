---
id: runtime.architecture.test-debt-189-04-handle-guards
type: architecture
status: active
owner: architecture
summary: "Brief 04 for issue 189: handle guards that end a leak instead of hiding it."
---

# Test Debt 189 04 Handle Guards

**Brief 04: handle guards that end a leak instead of hiding it**

Issue: agent-teams-ai/agent-runtime#189, item 4 ("add `guardHandles` from conformance at the test file level in
packages with real resources ... per file with process isolation only").
Branch: `test/handle-guards`. PR title: `test: fail fast on leaked handles in guarded test processes`.
Starts after AR-2 is merged (`@get-modular/conformance` arrives with AR-1c); merge after briefs 01-03. Scope follows
decision Q2 of the index (decided during planning on 2026-10-04, option A): guard plus `--test-force-exit` only where the
whole test process is guarded now.

## 1. Facts this brief rests on (verified on Node 24.21.0, macOS, 2026-10-04)

- agent-runtime uses neither `--test-force-exit` nor `getActiveResourcesInfo` anywhere (`git grep` on `5ac0d003`).
- `node --test` runs each file in its own process by default (`--test-isolation=process`), and flags such as
  `--test-force-exit` reach those child processes.
- `guardHandles()` (get-modular `packages/conformance`) snapshots `process.getActiveResourcesInfo()`; `check()` waits two
  event-loop turns and rejects with `conformance.handles.leaked` when a handle type grew. It sees only referenced
  handles, which are exactly the ones that keep a process alive.
- Without `--test-force-exit`, a leaked server makes the guard fail but the file still hangs until something kills it;
  embedded-runtime's launcher (`scripts/run-package-tests.mjs`) collects child output with `spawnSync`, so on a CI job
  timeout nothing may be printed.
- With `--test-force-exit` and no guard, the same leak passes silently (exit 0).
- With `--test-force-exit` and a per-file guard whose `after` is registered last, the file fails with
  `conformance.handles.leaked` naming the handle type and the process exits.
- `node:test` runs file-level `after` hooks in registration order. A guard hook registered first (for example from an
  `--import` preload) runs before the file's own cleanup hooks and reports false leaks. Hence the guard is written in
  each file, and its `after` is the last top-level statement.

Therefore: `--test-force-exit` is added only to a test process in which every file installs the guard, and a small
test enforces that.

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -1 origin/main
cat .node-version; node --version; pnpm --version
node --test --help 2>&1 | grep -E "test-force-exit|test-isolation"
git grep -n -E "test-force-exit|getActiveResourcesInfo|guardHandles" -- . ':!docs' | head
git grep -n "@get-modular/conformance" -- pnpm-workspace.yaml packages/apps/embedded-runtime/package.json
node -e 'import("./packages/apps/embedded-runtime/scripts/run-package-tests.mjs").then(m => console.log(m.testProcesses.map(p => p.length)))'
node -p 'require("./packages/platform/filesystem-custody/package.json").scripts.test'
node -p 'const c=require("./packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/contract-coverage.json"); [...new Set(c.cases.map(x=>x.testFile.split("/").slice(0,3).join("/")))].join("\n")'
gh pr list -R agent-teams-ai/agent-runtime --state open --json number,title,files \
  --jq '.[] | select(any(.files[]; .path | test("run-package-tests|filesystem-custody/(package.json|tests/)|source-dependencies.yaml"))) | "\(.number) \(.title)"'
ls docs/decisions/0024-*.md && grep -n -i "conformance" docs/decisions/0024-*.md
grep -n '"developmentOnlyPackages"\|conformance' architecture/foundation/dependency-declarations.yaml
```

ADR-0024 must admit the conformance kit for Filesystem Custody tests. Decided during planning on 2026-10-04: while ADR-0024
was still proposed (it is created in AR-1c), its text was widened to: `@get-modular/conformance` is allowed as a
development-only dependency of the test code of the Agent Runtime packages that guard handles (Embedded Runtime and
Filesystem Custody) and is never imported by production code. If the accepted ADR-0024 on main admits conformance for
Embedded Runtime tests only, stop and ask: commit 2 then needs an ADR change first, never a silent extension.

Consumer Module Standard (CMS) pin, required by the workspace rule before this change:

```sh
node -p 'const p=require("./architecture/get-modular/consumer-profile.json"); p.standard.commit + " " + p.standard.sha256'
git clone --filter=blob:none --no-checkout https://github.com/agent-teams-ai/get-modular "$TMPDIR/gm-cms"
git -C "$TMPDIR/gm-cms" show origin/HEAD:docs/architecture/common-assembly.md | shasum -a 256; rm -rf "$TMPDIR/gm-cms"
```

If the two SHA-256 values differ, stop: the pin is migrated first, in its own reviewed step.

Stop if: conformance is missing; the embedded-runtime launcher no longer has the two process lists of `5ac0d003`
(first: all package tests, second: `--experimental-test-module-mocks` with `linux-http-completion-negative.mjs`);
`packages/platform/filesystem-custody` appears in the AR2 contract coverage list (then its `test` script is pinned by
`scripts/architecture/ar2-test-execution-inventory.mjs:24` and must not gain flags: ask); another PR edits the same files.

## 3. Scope and non-goals

In scope (decision Q2): embedded-runtime passive-setup and ordinary test files, and every filesystem-custody test
file.

Not in scope: agent-execution, provider-access and runtime-security. Each of their `test` scripts is one
`node --test` command over hundreds of contained-turn files (one child process per file), `--test-force-exit` would
apply to every file of that command, and two of the scripts are pinned by the AR2 inventory; so a guard there could
not be paired with `--test-force-exit`. Their process, socket and pool code moves to the new library packages of the program plan, whose
first tests adopt guard plus force-exit (recorded in the program plan by the docs PR). Also not in scope: production
code, contained-turn test files, `run-linux-joined-product.mjs` and other launchers.

## 4. Decisions that apply

- CMS rule 7: "`guardHandles` is a per-file diagnostic, and `complete` is not proof of physical release."
- Tests only for risky places: the only new tests are the coverage checks that make `--test-force-exit` safe.
- ADR-0024 (widened during planning on 2026-10-04 while still proposed): `@get-modular/conformance` is a development-only
  dependency of the test code of the Agent Runtime packages that guard handles, Embedded Runtime and Filesystem
  Custody, and production code never imports it. Commit 2 relies on that sentence (section 2 checks it on main).
- Decision Q2 of the index (planning decision, 2026-10-04): guard plus `--test-force-exit` only where the whole test process is
  guarded; agent-execution, provider-access and runtime-security adopt guards with LIB-PROCESS, LIB-CODEX-1 and
  STORE-2-core.
- Gates are never weakened silently; a leak the guard finds is fixed, not allow-listed (`allow` stays unused unless the
  owner approves a named handle type with a reason).

## 5. Steps

### Commit 1 `test(embedded-runtime): run passive-setup and ordinary tests in a guarded process`

1. Guarded files: every file of the first launcher process that is a passive-setup, ordinary, Host or assembly test,
   and the coverage test added here. On `5ac0d003` these are:
   `tests/package/assembly-reference.test.ts`, `tests/package/assembly-packed-consumer.test.ts`,
   `tests/package/runtime-setup-assembly.test.ts`, `tests/package/ordinary-runtime-assembly.test.ts`,
   `tests/package/ordinary-host-disposal.test.ts`,
   `tests/features/ordinary-session-runtime/ordinary-observation-journal.unit.test.ts`,
   `tests/package/capability-bundle-contract.test.ts`, `tests/package/codex-setup.e2e.test.ts`,
   `tests/package/claude-code-setup.e2e.test.ts`, `tests/package/claude-code-semantic-correction.e2e.test.ts`,
   `tests/package/agent-runtime-host-disposal.unit.test.ts`,
   `tests/features/trusted-runtime-access-scope/trusted-runtime-access-scope.unit.test.ts`,
   `tests/package/public-api.test.ts`, `tests/package/claude-code-contract.test.ts`,
   `tests/features/setup-inspection-planning/opaque-reference-digest.test.ts`,
   plus any ordinary or passive-setup test file AR-1 added to the first list. Everything with `contained`, `linux-`,
   `darwin`, `live/`, `route`, `http`, `custody`, `host-shutdown`, `runtime-access-boundaries`,
   `postgres-authority-join` or `provider-candidate` in its path stays in the first process. Record the final list in
   the PR body.
2. In each guarded file, exactly this idiom (merge `after` into the existing `node:test` import):

   ```ts
   import { after } from "node:test";
   import { guardHandles } from "@get-modular/conformance";
   // ...existing imports...

   // First statement after the imports: count handles before this file opens any.
   const handles = guardHandles();

   // ...existing file...

   // Last top-level statement: node:test runs file-level after hooks in registration order,
   // so this check runs after every other cleanup of this file.
   after(() => handles.check());
   ```

3. `packages/apps/embedded-runtime/scripts/run-package-tests.mjs`: remove the guarded files from the first list and
   append a third process (keep the second process at index 1 unchanged):
   `["--test", "--test-concurrency=1", "--test-force-exit", ...guarded files, "tests/package/handle-guard-coverage.test.ts"]`.
   Keep the literal line `"tests/package/claude-code-setup.e2e.test.ts",` with its trailing comma exactly as it is (move
   it whole if it moves): `scripts/architecture/validate-ar2-contract-artifacts.test.mjs:513-516` removes that exact text
   from the launcher source and expects a rejection.
4. New `packages/apps/embedded-runtime/tests/package/handle-guard-coverage.test.ts` (itself guarded with the idiom):

   ```ts
   import assert from "node:assert/strict";
   import { readFile } from "node:fs/promises";
   import { after, test } from "node:test";
   import { guardHandles } from "@get-modular/conformance";
   import { testProcesses } from "../../scripts/run-package-tests.mjs";

   const handles = guardHandles();

   // --test-force-exit hides a leak in any file that does not check its handles, so every such file must.
   test("every file of a force-exit test process checks its handles last", async () => {
     for (const argv of testProcesses.filter(process => process.includes("--test-force-exit"))) {
       for (const file of argv.filter(argument => argument.startsWith("tests/"))) {
         const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
         assert.match(source, /^const handles = guardHandles\(\);$/mu, file);
         assert.match(source, /after\(\(\) => handles\.check\(\)\);\s*$/u, file);
       }
     }
   });

   after(() => handles.check());
   ```

5. Run the package tests. Any `conformance.handles.leaked`: find the handle. A test that leaves it open is fixed in the
   test (close it in that test or in a file-level `after` registered before the guard's). A handle left by production
   code is a defect: stop and report with the guard output; do not allow-list it.

Gates: `pnpm --filter @agent-teams/embedded-runtime typecheck`, `pnpm --filter @agent-teams/embedded-runtime test`,
`pnpm test:ar2-contract` (the inventory must still include `tests/package/claude-code-setup.e2e.test.ts` and
`tests/package/runtime-access-boundaries.e2e.test.ts`), `pnpm lint`.

### Commit 2 `test(filesystem-custody): guard every test file and stop on leaked handles`

1. `packages/platform/filesystem-custody/package.json`: `devDependencies` gains `"@get-modular/conformance": "catalog:"`.
   Run `pnpm install`. If pnpm reports missing peers (the workspace has `strictPeerDependencies: true`), add exactly the
   reported peers (`@get-modular/core`, `@get-modular/assembly`, `@get-modular/resources`) as `"catalog:"`
   devDependencies and install again; then `pnpm install --frozen-lockfile`. If Foundation later rejects a declared
   but unimported package, stop and report.
2. `architecture/foundation/source-dependencies.yaml`, boundary `test.filesystem-custody`, `allow.packages`: add
   `'@get-modular/conformance'` in sorted position.
3. The idiom of commit 1, step 2, in every file listed in the filesystem-custody `test` script
   (`.mjs` files the same way, without types).
4. A coverage test `packages/platform/filesystem-custody/tests/package/handle-guard-coverage.test.ts`, guarded too, that
   reads `../../package.json`, takes `scripts.test`, asserts it contains `--test-force-exit`, and checks every `tests/...`
   argument with the two regular expressions of commit 1, step 4. Add it to the `test` script list.
5. `test` script: insert `--test-force-exit` after `--test-concurrency=1`. Nothing else changes in it.
6. `scripts/foundation/check-native-quality.mjs` runs `host-errno.test.mjs` without `--test-force-exit`; leave it: the
   guard still fails there, it only cannot stop a hang. Note this in the PR body.

Gates: `pnpm --filter @agent-teams/filesystem-custody check`, `pnpm foundation:check`, `pnpm quality:native`,
`pnpm install --frozen-lockfile`, `pnpm lint`.

### Commit 3 `docs(architecture): record the handle guard rule`

`docs/architecture/get-modular-adoption.md` (tests section): the idiom, the rule "`--test-force-exit` only on a
process whose every file checks its handles last", the two coverage tests, and that agent-execution, provider-access
and runtime-security adopt it with the library packages. The passage that describes "the two original explicit Node
test argv lists" of the launcher (around lines 425-428 on `0ace1cce`) gains one sentence: the launcher now has three
processes, and restoring the disabled L0 v2 evidence lane must account for the third.

Update the norm row "Testing 7 and 8" (keep that name) in that document's pin review table and in
`architecture/get-modular/evidence/train-030-cms-pin-review.json` (`normDisposition`: `state` and `closedBy` only, as
AR-1b, AR-1c and AR-2 do; `check-cms-pin.mjs` hashes only the retained standard bytes and the delta): state "7 met for
the Embedded Runtime guarded process and Filesystem Custody; agent-execution, provider-access and runtime-security
adopt with LIB-PROCESS, LIB-CODEX-1 and STORE-2-core; 8 met for new tests", closedBy "AR-1c; 7 by issue #189" (append,
keep the history). Gates: `pnpm docs:protocol:check`,
`pnpm test:consumer-modules`, `pnpm architecture:consumer-modules`.

## 6. Gates for the PR (exit 0 each)

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

Record the embedded-runtime and filesystem-custody test durations before and after; `runtime-macos` must stay under
12 minutes, otherwise report.

Also run once and record (disabled lane, not in `check`; do not edit):
`node --test scripts/architecture/runtime-setup-l0-evidence-v2.test.mjs` before and after commit 1.

## 7. Risks and stop conditions

- A guarded file needs a handle to outlive its tests on purpose: stop and ask (the answer is either a fix or an owner
  approved `allow` entry with the handle type and reason).
- A guard fails only on one OS lane: report with both outputs; do not add `allow` for one platform.
- `--test-force-exit` changes another observable result (for example a test that relied on the process staying alive):
  stop.
- Any change to the agent-execution, runtime-configuration or runtime-security `test` scripts: not allowed here.

## 8. Must not

- Use an `--import` preload for the guard (verified false positives, section 1).
- Add `--test-force-exit` to any process that contains an unguarded file.
- Edit the root `package.json`, `scripts/ci/*`, CI workflows, or the AR2 inventory.
- Use destructive git commands or a non-local git identity; mention AI tools anywhere.

## 9. Done when

- embedded-runtime has a third launcher process with `--test-force-exit` whose files all pass the coverage test; the
  filesystem-custody `test` command has `--test-force-exit` and all its files pass its coverage test.
- No guard uses `allow`.
- Gates in section 6 green.

## 10. Review checklist

1. Re-run section 2; confirm the guarded list in the PR body contains no contained-turn file and that no file of the
   first process lost coverage (`node -e` print of `testProcesses` before and after; the union of files is unchanged
   plus the coverage test).
2. Mutation (leak): in `tests/package/public-api.test.ts`, inside a test, add
   `await new Promise<void>(resolve => { createServer().listen(0, () => { resolve(); }); });` (import `createServer`
   from `node:net`); `pnpm --filter @agent-teams/embedded-runtime test` must fail within seconds with
   `conformance.handles.leaked` and `TCPServerWrap`, and must not hang. Revert.
3. Mutation (ordering): move `after(() => handles.check())` to the top of a file that closes something in its own
   `after`; the coverage test must fail. Revert.
4. Mutation (coverage): add an unguarded file to the force-exit process; the coverage test must fail. Revert.
5. Same leak mutation in a filesystem-custody test; `pnpm --filter @agent-teams/filesystem-custody test` must fail fast.
   Revert.
6. `git diff origin/main -- package.json scripts/ci .github 'packages/contexts/*/package.json' packages/apps/embedded-runtime/package.json`
   is empty (commit 1 needs no manifest change; only filesystem-custody's manifest changes, in commit 2).
