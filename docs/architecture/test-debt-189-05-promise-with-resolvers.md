---
id: runtime.architecture.test-debt-189-05-promise-with-resolvers
type: architecture
status: active
owner: architecture
summary: "Brief 05 for issue 189: replace hand-written deferred helpers with Promise.withResolvers."
---

# Test Debt 189 05 Promise With Resolvers

**Brief 05: replace hand-written deferred helpers with Promise.withResolvers**

Issue: agent-teams-ai/agent-runtime#189, item 6.
Branch: `test/promise-with-resolvers`. PR title: `test(embedded-runtime): build deferred helpers on Promise.withResolvers`.
Depends on AR-2 only (no conformance). Develop any time; merge last (after briefs 01-04 and 07) to avoid conflicts in
`runtime-setup-assembly.test.ts`. Scope follows decision Q1 of the index: contained-turn test files are not touched.

## 1. Re-verify before start

```sh
git fetch origin && git log --oneline -1 origin/main
cat .node-version; node --version            # Promise.withResolvers exists since Node 22; root tsconfig lib is ES2024
git grep -n -E "(const|function|let)\s+deferred\b" -- 'packages/*/*/tests/**'
gh pr list -R agent-teams-ai/agent-runtime --state open --json number,title,files \
  --jq '.[] | select(any(.files[]; .path | test("runtime-setup-assembly.test|mac-pa-auth/remediation.test"))) | "\(.number) \(.title)"'
```

On `5ac0d003` (same on `0ace1cce`) the grep lists 27 lines: 10 one-line `Promise.withResolvers` helpers; 4 local
variables that are not helpers (`const deferred = await createCustody(...)`); 2 wrappers that already call
`Promise.withResolvers` on the next line; and 11 hand-written helpers. Nine of the eleven are in contained-turn test
files (two of them in the copies under `support/external`); decision Q1 of the index (decided during planning on
2026-10-04) leaves contained-turn tests to the CONTAINED-REMOVAL decision, so this PR changes only the two helpers
outside contained-turn:

| # | File (under `packages/`) | Returns |
|---|---|---|
| 1 | `apps/embedded-runtime/tests/package/live/mac-pa-auth/remediation.test.mjs:14` | `{promise, resolve}` |
| 2 | `apps/embedded-runtime/tests/package/runtime-setup-assembly.test.ts:14-19` | `{promise, resolve, reject}` |

The nine contained-turn helpers (record them in the PR body as left on purpose):
`apps/embedded-runtime/tests/package/support/external/provider-access/features/contained-turn-access/route-selection-fixture.ts:29`,
`apps/embedded-runtime/tests/package/support/external/runtime-security/postgres-dispatch.fixtures.ts:12`,
`contexts/agent-execution/tests/features/contained-agent-turn/contained-turn-post-claim-preparation.test.ts:16`,
`contexts/agent-execution/tests/features/contained-agent-turn/support/current-owner-preparation-fixture.ts:19`,
`contexts/provider-access/tests/features/contained-turn-access/postgres-materialization-transactions.test.ts:9`,
`contexts/provider-access/tests/features/contained-turn-access/route-selection-fixture.ts:32`,
`contexts/runtime-security/tests/features/contained-turn-dispatch-authority/postgres-dispatch.fixtures.ts:14`,
`contexts/runtime-security/tests/features/contained-turn-egress/contained-turn-egress.fixture.ts:81`,
`contexts/runtime-security/tests/features/provider-process-egress-authorization/current-egress-owner.fixture.ts:99`.
The production helper in `contexts/runtime-security/src/.../in-memory-dispatch-consumption-repository.ts:27` is out of
scope too. If the grep shows another non-contained hand-written helper, include it and say so in the PR body.

## 2. Scope and non-goals

In scope: the bodies of helpers #1 and #2. Not in scope: contained-turn test files (decision Q1); inline
`let release!: () => void` patterns that are not a helper; production code; renaming helpers or changing call sites.

## 3. Decisions that apply

- Mechanical, behaviour-preserving change: keep each helper's name, generic parameter and the property names its
  callers use. `Promise.withResolvers<T>()` returns `{promise, resolve, reject}`; the extra `reject` is harmless for
  #1, and its `resolve` accepts `T | PromiseLike<T>`, at least as wide as before.

## 4. Steps (one commit `test(embedded-runtime): build deferred helpers on Promise.withResolvers`)

```ts
const deferred = <T>() => Promise.withResolvers<T>();   // #2, runtime-setup-assembly.test.ts
const deferred = () => Promise.withResolvers();          // #1, remediation.test.mjs (untyped)
```

Remove locals that become unused. Do not touch anything else in these files.

## 5. Gates (exit 0 each)

`pnpm lint`; `pnpm product:build && pnpm typecheck`; `pnpm --filter @agent-teams/embedded-runtime test`.

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

`remediation.test.mjs` is a live test that the package launcher does not list; run it once directly with
`node --test packages/apps/embedded-runtime/tests/package/live/mac-pa-auth/remediation.test.mjs` if it runs without
live credentials, otherwise record that it was only linted.

## 6. Risks and stop conditions

- A caller destructures a property the new helper does not return: stop.
- Any test result changes: stop; this PR must not change behaviour.

## 7. Must not

- Touch contained-turn test files, including the copies under `support/external`.
- Change call sites, test names or assertions; touch production code; add files.
- Use destructive git commands or a non-local git identity; mention AI tools anywhere.

## 8. Done when

Helpers #1 and #2 are one-line `Promise.withResolvers` helpers; `git diff origin/main --stat` shows only those two
files; every gate in section 5 is green.

## 9. Review checklist

1. Re-run the grep of section 1; the only hand-written helpers left are the nine contained-turn ones listed there.
2. `git diff origin/main --stat`: exactly the two files.
3. `git diff origin/main` shows no change outside the two helper bodies.
