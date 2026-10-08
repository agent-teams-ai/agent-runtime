---
id: runtime.architecture.test-debt-189-02-retire-failure-sweep
type: architecture
status: active
owner: architecture
summary: "Brief 02 for issue 189: retire the per-module failure sweep now that smoke covers it."
---

# Test Debt 189 02 Retire Failure Sweep

**Brief 02: retire the per-module failure sweep now that smoke covers it**

Issue: agent-teams-ai/agent-runtime#189, item 5 ("one smoke test per composition root ... This replaces the
hand-written per-module failure sweeps"). AR-1c (commit C5 of its brief) adds the two `smoke` tests, for the passive
profile in `tests/package/runtime-setup-assembly.test.ts` and for the ordinary profile in
`tests/package/ordinary-runtime-assembly.test.ts`. What is left for #189 is removing the sweep they replace.
Branch: `test/retire-failure-sweep`. PR title: `test(embedded-runtime): rely on smoke for per-module construction failures`.
Starts after AR-2 is merged.

## 1. Re-verify before start

```sh
git fetch origin && git log --oneline -1 origin/main
cat .node-version; node --version; pnpm --version
git grep -n -E "smoke\(" -- packages/apps/embedded-runtime/tests
git grep -n -B2 -A40 'factory failure remains primary' -- packages/apps/embedded-runtime/tests/package/runtime-setup-assembly.test.ts
gh pr list -R agent-teams-ai/agent-runtime --state open --json number,title,files \
  --jq '.[] | select(any(.files[]; .path | test("runtime-setup-assembly.test|ordinary-runtime-assembly.test"))) | "\(.number) \(.title)"'
```

Stop if: there is no `smoke(` call for each of the two profiles (AR-1c C5 not merged or changed: report, do not write
the smoke tests here without a revised brief); the smoke tests do not assert the step count (`1 + 2 x modules`: 15
passive, 31 ordinary on the AR-1b identity table) or do not dispose every Host they collect; an open PR edits these files.

## 2. What the sweep checks, and who covers it after this PR

On `5ac0d003` the sweep is `for (const key of ["security", "discovery", "codexConfiguration", "claudeConfiguration", "codexPlanner", "claudePlanner", "host"] as const)`
at `runtime-setup-assembly.test.ts:114-149`: one test per passive factory that makes the factory throw a hostile value
and asserts (1) `AgentRuntimeHostCreationError` with `code === "factory_failed"`, (2) `moduleId` of the failing
module, (3) `cancellationObserved === false`, (4) the raw cause is not serialized, (5) the factories called are exactly
the compiled plan's prefix up to the failing one.

- (5) and "release at every module" are what `smoke` checks for every module of both profiles (`created` equals the
  order prefix, the injected failure is attributed to the module, every attempt scope closes `complete`).
- (1)-(4) are the Agent Runtime error projection, which `smoke` never reaches (it runs `composeRuntimeSetup` on its
  own api, not `createRuntimeSetupAttempt`). The `moduleId` lookup is not uniform: on `5ac0d003`
  `default-agent-runtime-host.ts:102` searches `runtimeOrdinarySetupDeclarations` only, and AR-1b B3 fixes it to search
  `selectedComposition(ordinary).declarations`, because after the duplicate-id fix the passive Host's implementation id
  exists only in the passive list. A leaf such as `codexConfiguration` is in both lists, so it cannot catch a revert of
  that fix; the root `host` can. Two cases therefore stay: `codexConfiguration` (a leaf) and `host` (the root).

## 3. Scope and non-goals

In scope: the sweep loop. Not in scope: the smoke tests themselves, any other test, production code.

## 4. Steps (one commit `test(embedded-runtime): rely on smoke for per-module construction failures`)

1. Replace the loop over seven keys with a loop over `["codexConfiguration", "host"] as const`, test name
   `` `factory failure is projected once with the module id and without the raw cause: ${key}` ``, keeping assertions
   (1)-(5) for both keys (module id literals from the AR-1b identity table).
2. Above it, a comment: construction order, failure attribution and release at every module of both profiles are
   covered by the `smoke` tests; these cases cover the Agent Runtime error projection, `codexConfiguration` for a leaf
   present in both declaration lists and `host` for the root, whose passive implementation id exists only in the
   passive list (it guards the `moduleId` lookup in `default-agent-runtime-host.ts`).
3. Nothing else changes in the file.

## 5. Gates (exit 0 each)

`pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm --filter @agent-teams/embedded-runtime test`,
`pnpm lint`.

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

- The smoke tests skip a module (fewer steps than 1 + 2 x modules) or are marked `skip`/`todo`: stop; the sweep must
  not go before smoke covers every module.
- Any doubt that a sweep assertion is covered elsewhere: keep it in the remaining cases.

## 7. Must not

- Remove any other test; weaken the remaining cases; touch production code, `package.json` files or CI.
- Use destructive git commands or a non-local git identity; mention AI tools anywhere.

## 8. Done when

`runtime-setup-assembly.test.ts` has two projection cases (`codexConfiguration`, `host`) instead of seven, with the
pointer comment; both smoke tests still run; gates green.

## 9. Review checklist

1. Re-run section 1; confirm both smoke tests exist and assert the step counts.
2. Mutation: in a scratch edit of production `bindRuntimeSetup`, bind one passive factory through a second
   `assemblyFor<RuntimeSetupCapabilities>()` instead of `api`; rebuild; the passive smoke test must fail with
   "outside the api". Revert. Then make one passive factory throw only on its second call; the passive smoke test must
   fail at that module. Revert. Both prove the coverage the removed cases are traded for.
3. Mutation: in the remaining cases, change the expected `moduleId` of one key; the test must fail. Revert.
3a. Mutation: in `default-agent-runtime-host.ts`, put the `moduleId` lookup back to `runtimeOrdinarySetupDeclarations`
   only; rebuild; the `host` case must fail (missing `moduleId`) while the `codexConfiguration` case passes. Revert.
4. `git diff origin/main --stat` shows only `runtime-setup-assembly.test.ts`.
