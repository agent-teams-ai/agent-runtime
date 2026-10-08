---
id: runtime.architecture.get-modular-train-1-ar-2
type: architecture
status: active
owner: architecture
summary: "Brief for AR-2: per-grant Provider Access scopes."
---

# Get Modular Train 1 AR-2

AR-2: per-grant Provider Access scopes. PR title `feat(provider-access): release ordinary grants through concurrent child scopes`, branch
`feat/provider-access-grant-scopes` from fresh `origin/main` after AR-1c merged and ADR-0024 is accepted. Three
commits P1 to P3. Estimated +180 / -30.

## 1. Facts you need (verified at agent-runtime `0ace1cce`, get-modular `81063ad`)

- Owner decision (2026-10-02): the second real Agent Runtime scope is per grant in Provider Access, with dynamic
  children, `order: "concurrent"`, and the domain retirement kept inside one cleanup entry. Provider Access owns the
  scope; its public API does not change; `Resources` does not leave Provider Access.
- `packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts`
  (after the port split of commit `b81ef94a`): `createOrdinaryProviderAccessOwner(ports)` (lines 58-206) keeps
  `grants: Set<OrdinaryPaGrant>` with a limit of 64 (`grants.size + pendingCaptures.size >= 64`, line 76); a grant's
  `retire()` (lines 111-139) is cached in `retiring` and reset on failure; `grants.delete(grant)` happens in `retire`
  when already settled (line 136), in `settle` when already retired (line 182), and in `dispose` after a successful
  retire (line 199); `dispose()` (lines 194-205) first disposes pending captures, then retires every remaining grant with
  `Promise.allSettled`, throws one flat `AggregateError(errors, 'ORDINARY_PA_UNAVAILABLE')`, and resets `disposal` on
  failure so a later call retries. `createPostgresOrdinaryProviderAccessOwner` (lines 209-236) wraps it and disposes the
  store after the owner.
- Grant IDs are `randomUUID()` values, not secrets; a debt path will be `["pa-grants", "grant:<grantId>", "retire"]`.
- `@get-modular/resources` 0.1.0: `createScope({ name, order })`, `resources.child({ name })`, `resources.use(value, name)`;
  `close()` never rejects, continues past failures, retries only failed entries on a later call; a child whose close
  is complete detaches from its parent (so released grants do not accumulate); `child()` on a closing scope throws
  `resources.scope.closed`. Author rules that apply: rule 7 ("A domain shutdown protocol, such as retire, settle and
  delete in a fixed order, stays inside one cleanup"), rule 12 ("Never await `close()` of your own or an ancestor
  scope inside a cleanup"), rule 13 ("A cleanup that must not run twice guards itself").
- ADR-0024 (accepted in AR-1c) permits `@get-modular/resources` in `composition.provider-access.ordinary` only.
  The boundary currently has `allow.packages: []` (`architecture/foundation/source-dependencies.yaml`, boundary
  `composition.provider-access.ordinary`, around line 2928). Provider Access is private (`0.0.0`); the resources
  version is fixed by the exact catalog, so one copy is installed. `packages/contexts/provider-access/package.json` has
  no `dependencies` section today.
- Existing regression nets: `tests/features/contained-turn-access/ordinary-pa-owner-port.test.ts` (in-memory
  `OrdinaryPaGrantStore`), `ordinary-pa-owner-disposal.test.ts`, `ordinary-pa-owner-races.test.ts:46` ("owner disposal
  joins consume COMMIT and retires the late grant before closing"), `ordinary-pa-postgres.test.ts` (real database in
  `postgres-durability`), and the Host fixture `packages/apps/embedded-runtime/tests/package/ordinary-host-pa-owner-disposal.fixture.ts`
  (counts `UPDATE ... SET retired_at` and capture disposals).

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -5 origin/main
git log --oneline <AR-1c merge>..origin/main -- packages/contexts/provider-access architecture/foundation/source-dependencies.yaml
node -p "require('./architecture/decisions/accepted-decisions.json').decisions.some(d => d.id === 'ADR-0024')"   # true
grep -n "'@get-modular/resources'" pnpm-workspace.yaml   # 0.1.0 in the catalog
gh pr list --repo agent-teams-ai/agent-runtime --state open   # PR #180 touches Provider Access: check for overlap
```

The AR program plan lanes STORE-1c and ACCESS-LIB also edit `ordinary-provider-access-owner.ts`. If one of them merged
after AR-1c, re-read the file and stop where a step below no longer matches. Environment as in AR-1a.

Local full gates (run after committing; several tests read committed files and git history). Export the
identity-only git config first (`export GIT_CONFIG_GLOBAL=<file with only [user] name = iliya, email = iliyazelenkog@gmail.com>`;
a global git hook on developer machines breaks fixture tests).

- Linux: `pnpm check:fast` and `pnpm check`, both exit 0.
- macOS: `test:sdk-growth:source` fails there on unmodified `origin/main` (it reads `/proc/self/fd`; 9 failures). This
  is a known pre-existing macOS failure that this PR does not fix; confirm it once on `origin/main`. Because the
  chains use `&&`, every later step would be skipped, so run every step except that one, stopping at the first
  failure, as a script file (`bash local-gates.sh`) or a quoted heredoc (`bash <<'EOF' ... EOF`); not
  `bash -c '...'`, because the loop contains single quotes. Each step must exit 0:

  ```sh
  for chain in check:fast check:ci:quick check:ci:foundation check:ci:architecture check:ci:docs check:ci:product; do
    for s in $(node -p "require('./package.json').scripts['$chain'].replaceAll('pnpm ', '').split(' && ').join(' ')"); do
      [ "$s" = test:sdk-growth:source ] && continue
      pnpm "$s" || { echo "FAILED: $chain -> $s"; exit 1; }
    done
  done
  ```

  CI on Linux (the required `check`) remains the authority for `test:sdk-growth:source`.

Consumer Module Standard upstream comparison (workspace rule "Consumer Module Standard maintenance"):

```sh
git -C <gm-clone> fetch origin
git -C <gm-clone> show origin/main:docs/architecture/common-assembly.md | shasum -a 256
node -p "require('./architecture/get-modular/consumer-profile.json').standard.sha256"   # must be equal
```

If they differ, stop: the standard changed upstream, and the owner decides on a pin step before this PR.

## 3. Scope and non-goals

In scope: one `createScope({ name: "pa-grants", order: "concurrent" })` per ordinary Provider Access owner, one child
per consumed grant, release when the grant is retired and settled, `dispose()` closing the grant scope; two tests;
docs. Non-goals: public API, store, DDL, broker, auth capture, contained-turn materialization; passing `Resources`
in or out of Provider Access; peer dependencies (Agent Runtime packages are private; revisit in the publication lane).

## 4. Owner decisions (facts)

See section 1. No open questions remain for this brief.

## 5. Commits

### P1 `build(provider-access): depend on @get-modular/resources`

`packages/contexts/provider-access/package.json`: `"dependencies": { "@get-modular/resources": "catalog:" }`;
`architecture/foundation/source-dependencies.yaml`, boundary `composition.provider-access.ordinary`:
`packages: ['@get-modular/resources']`; `pnpm install`, then `pnpm install --frozen-lockfile`. If Foundation rejects a
declared but unused dependency, fold P1 into P2. Gates (exit 0): `pnpm install --frozen-lockfile`,
`pnpm foundation:check`; `ls node_modules/.pnpm | grep -c '^@get-modular+resources@'` prints 1.

### P2 `feat(provider-access): release ordinary grants through concurrent child scopes`

`ordinary-provider-access-owner.ts`, inside `createOrdinaryProviderAccessOwner`:

```ts
import { createScope, type Scope } from '@get-modular/resources';

  // Independent peers: every unreleased grant retires concurrently on dispose; retire keeps its own domain order.
  const grantScopes = createScope({ name: 'pa-grants', order: 'concurrent' });
```

In `consume()`:

- Declare `let grantScope: Scope | undefined;` and
  `const release = (): void => { if (grantScope !== undefined) { void grantScope.control.close(); } };` before the
  `retire` closure (line 110 at base), so no closure reads a variable in its temporal dead zone.
- In `retire`, where `if (settled) {grants.delete(grant);}` (line 136): also call `release()`. In `settle`, where
  `if (retired) {grants.delete(grant);}` (line 182): also call `release()`. `release()` is never awaited (rule 12);
  the child's close calls `retire()` again, which returns the cached promise.
- Right after `const grant = Object.freeze<OrdinaryPaGrant>({...})` and before `grants.add(grant)` (line 189):

  ```ts
      try { grantScope = grantScopes.resources.child({ name: `grant:${consumed.authority.grantId}` }); }
      catch { await grant.retire(); throw new OrdinaryPaUnavailable(); } // a closing owner never leaves a grant unowned
      grantScope.resources.use({ async [Symbol.asyncDispose]() { await grant.retire(); } }, 'retire');
  ```

  The `catch` is unreachable by construction (dispose awaits pending consumptions before it closes the grant scope),
  but without it a failure would leave a consumed grant without an owner.

`dispose()`: keep the capture phase (lines 197-198); replace the grant line (199) with

```ts
        // A later dispose retries only grants whose retirement failed.
        const report = await grantScopes.control.close();
        for (const debt of report.debts) {
          results.push({ status: 'rejected', reason: debt.state === 'failed' ? debt.cause : new OrdinaryPaUnavailable() });
        }
```

and after the `errors` check add `grants.clear();`. The `grants` set stays only for the limit of 64. The flat
`AggregateError(errors, 'ORDINARY_PA_UNAVAILABLE', { cause: errors[0] })` shape stays; existing tests that inspect it
must pass unchanged (if one needs a change, stop and ask).

Tests in `packages/contexts/provider-access/tests/features/contained-turn-access/ordinary-pa-owner-port.test.ts`
(picked up by the package test glob), with an in-memory `OrdinaryPaGrantStore` keyed by `operationId` and typed
with `satisfies OrdinaryPaGrantStore`:

| Test | Assertion | Fails when |
|---|---|---|
| 64 grants retire concurrently on dispose (`{timeout: 10000}`) | the store's `retire` waits on a barrier released when 64 calls have started; `assert.equal(maxConcurrentRetirements, 64)` | the grant scope uses the default reverse order (the first `retire` waits forever and the test times out) |
| one failing retirement is isolated and retried alone | the store's `retire` throws once for one binding before stamping `retiredAt`; the first `dispose()` rejects with `error.errors.length === 1`; 63 rows have `retiredAt`; the second `dispose()` resolves; total `retire` calls `=== 65` | the debt loop is missing (the first `dispose()` resolves), or release stops at the first failure (fewer than 63 retired) |

Existing tests stay unchanged and must pass: the race test (`ordinary-pa-owner-races.test.ts:46`), the disposal
tests, `ordinary-pa-postgres.test.ts`, and the embedded-runtime fixture `ordinary-host-pa-owner-disposal.fixture.ts`
(same `updates` and `captureDisposalCalls` counts). No test can observe `release()`: a released child and an
unreleased one behave the same on dispose, because `retire()` is cached, and only memory differs in a long-lived owner.
Detachment of released children is covered by the resources package; `release()` on every `grants.delete` path is a
read-only review check.

Gates (exit 0): `pnpm --filter @agent-teams/provider-access check`,
`pnpm --filter "@agent-teams/embedded-runtime..." run build && pnpm --filter @agent-teams/embedded-runtime test`,
`pnpm foundation:check`, `pnpm architecture:feature-modules:active`, `pnpm test:get-modular-adoption`.

### P3 `docs: record the per-grant Provider Access scope`

`packages/contexts/provider-access/src/features/contained-turn-access/README.md`: one paragraph on ordinary grant
release (scope per owner, child per grant, concurrent release, retry of failed grants only, debt path shape).
`docs/architecture/get-modular-adoption.md`, and in `architecture/get-modular/evidence/train-030-cms-pin-review.json`
switch every row still `pending: AR-2` to its final state ("order concurrent only for independent peers: met (Provider
Access grants)", resource scopes rule 7 met, errors by code met); afterwards no row says `pending`. Gates:
`pnpm docs:protocol:check`, `pnpm test:consumer-modules`.

Final gates: the local full gates of section 2 after the last commit. In CI, `postgres-durability`
runs the Provider Access PostgreSQL gates and the ordinary PostgreSQL gate.

## 6. Risks and stop conditions

- A concurrent retirement exposes a hidden ordering need between grants (shared store row, shared broker): stop; the
  scope must not be concurrent then.
- An existing test changes its error shape or counters: stop and ask.
- Overlap with an open or merged Provider Access lane PR: rebase and re-read before editing.

## 7. Must not

Accept `Resources` from outside Provider Access or return it; await `close()` inside `retire` or `settle`; change
the public composition API, the DDL or the store; remove the limit of 64; add co-author trailers or text about how the change was produced.

## 8. Done

Required checks green (including `postgres-durability`); independent review clean after re-run; owner merges.
Afterwards the AR program plan lanes rebase, and issue #189 can start.

## 9. Review checklist (owner's reviewer)

1. Read-only check (no test can observe it): `grep -n "grants.delete\|release()" ordinary-provider-access-owner.ts`;
   every delete path in `retire` and `settle` has a `release()`; `dispose` clears only after a complete close.
2. `grep -n "createScope\|order: 'concurrent'" ordinary-provider-access-owner.ts` shows one scope, concurrent.
3. `grep -rn "@get-modular/resources" packages/contexts/provider-access/src` shows only the composition file.
4. Mutations in a scratch clone at the PR head, each committed on a detached HEAD and started again from the PR head:
   remove `order: 'concurrent'` (the 64-grant test times out); drop the `for (const debt ...)` loop after
   `grantScopes.control.close()` (the isolation test fails because the first dispose resolves).
5. `node -p "require('./architecture/get-modular/evidence/train-030-cms-pin-review.json').normDisposition.filter(r => String(r.state).startsWith('pending')).length"` prints 0.
6. `git diff origin/main -- '*.ts' | grep -c '^+.*as never'` is 0.
