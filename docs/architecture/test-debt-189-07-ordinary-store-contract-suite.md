---
id: runtime.architecture.test-debt-189-07-ordinary-store-contract-suite
type: architecture
status: active
owner: architecture
summary: "Brief 07 for issue 189: contract suite for the ordinary operation store."
---

# Test Debt 189 07 Ordinary Store Contract Suite

**Brief 07: contract suite for the ordinary operation store**

Issue: agent-teams-ai/agent-runtime#189, item 2 ("an owner's fake must pass the same `runContractSuite` as the real
implementation"), applied per decision Q3 of the index (decided during planning on 2026-10-04, option A): one suite now,
for `agent-runtime/ordinary/store`, owned by the ordinary feature, run against the owner's in-memory fake in the
package tests and against the PostgreSQL store in `postgres-durability`, written so the storage program (STORE-2-core)
can move the same cases into its compatibility package. Interpretation of CMS rule 3 used here, decided during planning on
2026-10-04: rule 3 applies to contracts that have a second behavioural implementation; single-scenario stubs inside
one test file are not implementations; each other ordinary contract is recorded as "no second implementation" in the
pin review.
Branch: `test/ordinary-store-contract-suite`. PR title: `test(embedded-runtime): ordinary operation store contract suite`.
Starts after AR-2 and brief 03 are merged (brief 03 provides the type-check mechanism for test files). Independent of
brief 04; if brief 04 is merged first, the new test files follow its guard rule (step 6).

## 1. Facts (verified on `5ac0d003` and get-modular `81063ad`)

- Consumer Module Standard, "Testing modules", rule 3: "The contract owner keeps one fake per contract that others
  implement and a suite created with `contractSuite(contract, cases)`, published from an entrypoint that production
  code does not import. The fake and every implementation pass that suite through `runContractSuite` ... A suite
  covers errors and cancellation, not only success, and is required once a capability has two implementations, the
  fake included."
- `@get-modular/conformance`: `contractSuite(contract, cases)` freezes a non-empty record of cases
  `(subject, context) => void | Promise<void>`; `runContractSuite(suite, { name, declaration, create }, test)` registers
  one test per case named `"<contract id> r<revision>: <case> [<subject name>]"`, creates the subject in a fresh scope
  per case (`create({ signal, resources })`), closes the scope afterwards, and throws
  `conformance.suite.revision-mismatch` at registration when `declaration.provides` does not contain exactly
  `contract.provide()`. From inside a `node:test` test pass `(name, body) => t.test(name, body)`; node:test cancels
  subtests that are still pending when the parent ends, so collect the returned promises and await them.
- The contract: after AR-1b the ordinary feature defines `OrdinaryStore = defineContract<OrdinaryTurnDependencies["operationStore"]>()({ id: "agent-runtime/ordinary/store", revision: 1 })`
  and the declaration of the Postgres module (`implementationId` `agent-runtime/ordinary/store/postgres`).
- The port `OrdinaryOperationStore` (`packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-ports.ts`):
  `accept`, `prepare`, `read`, `claim`, `cancel`, `append`, `finish`, `reconcile`.
- The real implementation `PostgresOrdinaryOperationStore` (`.../adapters/outbound/postgres/ordinary-postgres-store.ts`),
  public through `@agent-teams/agent-execution/composition` together with `applyOrdinaryPostgresSchema`,
  `ORDINARY_PROFILE`, `containedTurnCommandFingerprint` and the types `OrdinaryOperationStore`, `OrdinaryOperation`,
  `OrdinaryReceipt`, `OrdinaryReceiptOf`, `OrdinaryAuthoritySnapshot`. Its store-level rules:
  - `accept`: insert keyed by `(tenantId, projectId, commandId)`; same key and same fingerprint gives `duplicate` with
    the stored operation; same key and another fingerprint gives `conflict`; `unknown` only on an unacknowledged commit.
  - `prepare`: rejects when either authority `expiresAt` is `<= now + 10000` or `> now + 60000`; rejects unless the
    stored operation has the same revision, status `accepted`, no cancellation and no preparation; then
    `revision + 1` with the preparation.
  - `claim`: `not_claimed` unless same revision, status `accepted`, not cancelled, prepared, and both authorities expire
    after `now + 10000`; otherwise `revision + 1`, status `running`, `receipts = [dispatch_claim]` with
    `reservationId` of the preparation and `committedRevision = revision + 1`.
  - `cancel`: returns the stored operation unchanged when absent from `accepted`/`running` or already cancelled;
    otherwise `revision + 1`, `cancellationRequested: true`; unknown reference gives `undefined`.
  - `append`: rejects unless status `running` and the same `attemptId`; output cursors count from 1.
  - `finish`/`reconcile`: rejects when the operation is missing or another attempt; returns the stored operation
    unchanged when its status is not `accepted`, `running` or `reconcile_required`; merges receipts by `kind` and
    rejects a receipt that differs from a recorded one of the same kind ("immutable receipt conflict"); `reconcile`
    sets `reconcile_required`; `finish` sets the status of the domain rule `ordinaryTerminalStatus` (a complete closure
    with `provider_terminal.terminalStatus === "completed"` gives `succeeded`; no `provider_terminal` gives
    `reconcile_required`).
  - Every write validates the whole operation with the domain validator; the existing test
    `ordinary-core-postgres.test.ts` isolates each run in its own schema through `search_path`.
- The existing synthetic stores in tests (`tests/package/ordinary-host-ownership.fixture.ts`,
  `agent-execution/.../ordinary-composed.test.ts`, `ordinary-core.test.ts`) are single-scenario stubs with test-specific
  behaviour (fixed revisions, `finish` that fails the test on purpose). They are not owner fakes and stay as they are.
- `postgres-durability` runs `scripts/ci/ordinary-postgres-disposable.sh`, which starts a disposable PostgreSQL
  (`postgres:18.4-trixie@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636`) on a socket and runs
  `scripts/ci/run-ordinary-postgres.mjs`. That runner executes a fixed list of (file, test name) pairs with
  `ORDINARY_TEST_POSTGRES_URL` set and fails on any skip, todo, failure or missing required name; its rejecting tests
  are `scripts/ci/run-ordinary-postgres.test.mjs` (in `foundation:boundaries:negative`). The `postgres-durability` job
  itself is hashed in `scripts/ci/platform-contract.json`: `.github/workflows/ci.yml` must not change.
- Dependency direction: agent-execution (and the future store package) must never import embedded-runtime. So the
  cases must not live behind the Get Modular wrapper: pure port-level cases in one module, wrapped by `contractSuite`
  in another. STORE-2-core later moves the cases module unchanged into the private storage compatibility package
  (STORE-0 mechanism) and makes Embedded Runtime import it from there; it never copies the file.
- The port has no `AbortSignal`; its cancellation is the domain `cancel`, which two cases cover (CMS rule 3 asks for
  errors and cancellation, not only success).

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -1 origin/main
cat .node-version; node --version; pnpm --version
grep -n "@get-modular" pnpm-workspace.yaml                                       # conformance 0.1.x present
git grep -n -E "OrdinaryStore\b|ordinaryStoreDeclaration" -- packages/apps/embedded-runtime/src | head
git grep -n -A10 "export interface OrdinaryOperationStore" -- packages/contexts/agent-execution/src
git grep -n -E "PostgresOrdinaryOperationStore|applyOrdinaryPostgresSchema|ORDINARY_PROFILE|containedTurnCommandFingerprint" -- packages/contexts/agent-execution/src/composition.ts
sed -n 1,20p scripts/ci/run-ordinary-postgres.mjs
gh pr list -R agent-teams-ai/agent-runtime --state open --json number,title,files \
  --jq '.[] | select(any(.files[]; .path | test("ordinary-postgres-store|ordinary-ports|run-ordinary-postgres|ordinary-runtime-assembly"))) | "\(.number) \(.title)"'
git log --oneline origin/main -- packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-ports.ts | head -3
grep -n '"@types/pg"' packages/apps/embedded-runtime/package.json      # added by brief 03; stop if absent
```

Consumer Module Standard (CMS) pin, required by the workspace rule before this change:

```sh
node -p 'const p=require("./architecture/get-modular/consumer-profile.json"); p.standard.commit + " " + p.standard.sha256'
git clone --filter=blob:none --no-checkout https://github.com/agent-teams-ai/get-modular "$TMPDIR/gm-cms"
git -C "$TMPDIR/gm-cms" show origin/HEAD:docs/architecture/common-assembly.md | shasum -a 256; rm -rf "$TMPDIR/gm-cms"
```

If the two SHA-256 values differ, stop: the pin is migrated first, in its own reviewed step.

Stop if: the descriptor or the Postgres store declaration has another name or id (use the merged names if they are
only renamed; stop if the contract revision is not 1 or the value type is no longer the operation store port); the
port or the store moved packages (STORE-0/1a/2 or ENGINE-1 landed: then this brief needs the new import paths, ask);
an open PR changes the port (STORE-1a): ask which merges first; without an answer, wait. Record in the PR body the
names, the merged commit and whether brief 04 is merged.

## 3. Scope and non-goals

In scope: port-level cases; the Get Modular suite; the owner's in-memory fake and its declaration; one fake run in the
package tests; one PostgreSQL run in the `postgres-durability` gate; docs lines.

Not in scope: other contracts (decision Q3); unknown-commit fault injection, durable restart, schema checks and
migration tests (they are adapter tests: `ordinary-core-postgres.test.ts` today, the store package tests after
STORE-2-core); rewriting the existing ad-hoc stubs; production code; CI workflow files.

## 4. Steps

### Commit 1 `test(embedded-runtime): ordinary operation store contract cases, fake and suite`

All new files under `packages/apps/embedded-runtime/tests/features/ordinary-session-runtime/`.

1. `support/ordinary-store-cases.ts`: port-level cases, the part the storage program will adopt.
   - Header comment: "Port-level contract cases for the ordinary operation store. The ordinary feature wraps them with
     `contractSuite`. STORE-2-core moves this file unchanged into the private storage compatibility package and Embedded
     Runtime then imports it from there; never copy it. Import only `node:assert/strict`, `node:crypto` and port types
     or constants from `@agent-teams/agent-execution/composition`: no Get Modular, no `node:test`, no embedded-runtime
     code."
   - `export type StoreCase = (store: OrdinaryOperationStore) => Promise<void>;`
     `export const ordinaryStoreCases: Readonly<Record<string, StoreCase>> = Object.freeze({ ... })`.
   - Helpers in the same file: `input(commandId, scope?, prompt?)` typed `Parameters<OrdinaryOperationStore["accept"]>[0]`;
     `preparationFor(operation, expiresInMs = 55000)` typed `Parameters<OrdinaryOperationStore["prepare"]>[1]`, with
     both authorities built like `authority()` in `tests/package/ordinary-host-ownership.fixture.ts`;
     `closureFor(operation)` returning the eight receipts other than `dispatch_claim`, built like `closure()` in that
     fixture (bindings from the operation; reservation, workspace, materialization and grant ids from its preparation;
     `provider_terminal.terminalStatus: "completed"`); cases pass `[claim, ...closureFor(running)]`, where `claim` is the
     receipt `claim` returned, never a built one. `providerTerminalCompleted(operation)` returns only the
     `provider_terminal` receipt of that closure.
   - The cases, each independent and named exactly:

     | Case name | Must hold |
     |---|---|
     | `accepts a command once and returns it as a duplicate` | first `accept` is `accepted` with `revision 0`, `status "accepted"`; the same input again is `duplicate` with the same `operationId` |
     | `reports a conflict for the same command with another intent` | same `commandId` and scope, other prompt: `conflict` |
     | `keeps scopes apart` | same `commandId` in two tenants: both `accepted`, different `operationId`; `read` of one operation with the other tenant's scope is `undefined` |
     | `accepts exactly once under concurrent submissions` | 8 parallel `accept` of one input: exactly one `accepted`, the rest `duplicate`, one `operationId` |
     | `reads back the accepted operation` | `read({ operationId, scope })` deep-equals the accepted operation |
     | `prepares once and rejects a stale revision` | `prepare({...accepted, revision: accepted.revision + 1}, preparationFor(accepted))` rejects and `read(...).preparation === null`; then `prepare(accepted, ...)` gives `revision + 1` and the preparation; a second `prepare(accepted, ...)` rejects |
     | `rejects a preparation whose authority expires too soon or too late` | `expiresInMs` 5000 and 120000 both reject; the operation stays unprepared (`read(...).preparation === null`) |
     | `claims exactly once under concurrent claims` | after `prepare`, 8 parallel `claim` of the prepared operation: exactly one `claimed`, the rest `not_claimed`; the claimed operation has `status "running"`, `revision` prepared + 1, `receipts` equal `[receipt]`, `receipt.kind === "dispatch_claim"`, `receipt.reservationId` of the preparation |
     | `does not claim an unprepared or cancelled operation` | `claim(accepted)` is `not_claimed`; after `prepare`, `cancel` returns `cancelled` (current revision, `cancellationRequested: true`); `claim(cancelled)` is `not_claimed` (same revision, so only the cancellation check can refuse it) |
     | `cancels once and ignores unknown operations` | `cancel` sets `cancellationRequested` with `revision + 1`; a second `cancel` returns the same revision; `cancel` of an unknown `operationId` is `undefined` |
     | `appends output only to the running attempt` | `append` before the claim rejects; after the claim two appends give cursors 1 and 2 (use an output `kind` the domain accepts, see `OrdinaryOutput` in `ordinary-model.ts`) |
     | `finishes with the merged closure and keeps a terminal operation unchanged` | after the claim, `finish(running, [claim, ...closureFor(running)])` gives `status "succeeded"` and one receipt per kind (nine); a second `finish` returns the same revision |
     | `keeps an incomplete closure in reconciliation` | after the claim, `finish(running, [claim, providerTerminalCompleted(running)])` gives `reconcile_required`, not `succeeded` |
     | `rejects a receipt that contradicts a recorded one` | after the claim, `finish` with a `dispatch_claim` that differs from the recorded one rejects |
     | `reconciles and completes the closure later` | after the claim, `reconcile(running, [claim])` gives `reconcile_required`; then `finish` with `[claim, ...closureFor(running)]` gives `succeeded` |

   - Every rejection is asserted with `assert.rejects` without matching the message (the fake and the adapter word
     errors differently); every operation is compared by fields, never by object identity.

2. `support/in-memory-ordinary-store.ts`: the owner's fake.
   - `export function createInMemoryOrdinaryOperationStore(): OrdinaryOperationStore` implementing the store-level
     rules of section 1 in memory: maps keyed by `tenantId`, `projectId` and `commandId` or `operationId`; ids from
     `randomUUID()` with the real prefixes (`ordinary:`, `attempt:`, `effect:`, `claim:`); fingerprint from
     `containedTurnCommandFingerprint({ scope, intent, provider: expectedProvider })`; `structuredClone` on every value
     that enters or leaves; no `await` between a check and its write (that is what makes concurrent `accept` and
     `claim` atomic); terminal status: `cancelled` when there is no claim and cancellation was requested; after a claim
     `succeeded` (for `provider_terminal.terminalStatus === "completed"`) or that terminal status only when every one
     of the nine required receipt kinds (`dispatch_claim`, `provider_terminal`, `output_drain`, `process_group_closed`,
     `workspace_snapshot`, `artifact_published`, `credential_retired`, `provider_grant_settled`,
     `security_grant_settled`) is present; otherwise `reconcile_required`. The adapter gets the same outcome from the
     domain rule `ordinaryTerminalStatus`, which falls back to `reconcile_required` when the operation with the
     computed status fails validation (an incomplete closure).
   - Comment above it: "Owner fake of `agent-runtime/ordinary/store`, verified by the contract suite. It does not run
     the domain validator and never reports `unknown`; use the PostgreSQL store for those."
   - `export const inMemoryOrdinaryStoreDeclaration = declareModule({ moduleId: "agent-runtime/ordinary/store", implementationId: "agent-runtime/ordinary/store/in-memory", owner: { authority: "agent-runtime", path: ["ordinary-session-runtime", "tests"] }, provides: [OrdinaryStore.provide()], slots: [] });`
     (test-only id; never in a production profile).

3. `support/ordinary-store-suite.ts`:

   ```ts
   import { contractSuite } from "@get-modular/conformance";
   import { OrdinaryStore } from "../../../../dist/composition/ordinary-runtime-assembly.js";
   import { ordinaryStoreCases } from "./ordinary-store-cases.ts";
   /** Contract suite of agent-runtime/ordinary/store r1; the fake and every store implementation must pass it. */
   export const ordinaryStoreSuite = contractSuite(OrdinaryStore, ordinaryStoreCases);
   ```

   (Use the merged import path of the facade. The cases take the port as their only parameter, which `contractSuite`
   accepts because the contract's value type is the port; if the compiler disagrees, the descriptor's value type has
   drifted from `OrdinaryOperationStore`: stop and report.)

4. `ordinary-store-contract.test.ts` (fake run, always on):

   ```ts
   runContractSuite(ordinaryStoreSuite,
     { name: "in-memory", declaration: inMemoryOrdinaryStoreDeclaration, create: () => createInMemoryOrdinaryOperationStore() },
     test);
   ```

5. `ordinary-store-contract.postgres.test.ts` (PostgreSQL run, skipped without a URL like `ordinary-core-postgres.test.ts`):

   ```ts
   const connectionString = process.env.ORDINARY_TEST_POSTGRES_URL;
   test("ordinary operation store contract suite against PostgreSQL", { skip: connectionString === undefined }, async t => {
     const pending: Promise<unknown>[] = [];
     runContractSuite(ordinaryStoreSuite, {
       name: "postgres", declaration: ordinaryStoreDeclaration,
       create: async ({ resources }) => {
         // One schema per case, as in ordinary-core-postgres.test.ts; released in reverse order.
         const schema = `ordinary_suite_${randomUUID().replaceAll("-", "")}`;
         await resources.setup({ name: "admin",
           setup: async () => { const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 }); await pool.query(`CREATE SCHEMA ${schema}`); return pool; },
           cleanup: async pool => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); } });
         const pool = await resources.setup({ name: "pool",
           setup: () => new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10000 }),
           cleanup: pool => pool.end() });
         await applyOrdinaryPostgresSchema(pool);
         return new PostgresOrdinaryOperationStore({ pool });
       },
     }, (name, body) => { pending.push(t.test(name, body)); });
     await Promise.all(pending);
   });
   ```

6. Registration and type-checking:
   - `packages/apps/embedded-runtime/scripts/run-package-tests.mjs`: add both test files. If brief 04 is merged, put
     both into the guarded `--test-force-exit` process with the guard idiom of brief 04 (first statement
     `const handles = guardHandles();`, last statement `after(() => handles.check());`); otherwise into the first
     process, after `tests/features/ordinary-session-runtime/ordinary-observation-journal.unit.test.ts`, still with the
     guard idiom.
   - Root `tsconfig.json` `include`: add the five new files (the mechanism of brief 03).

Gates (exit 0): `pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm product:build && pnpm typecheck`,
`pnpm --filter @agent-teams/embedded-runtime test` (15 cases pass for `[in-memory]`; the PostgreSQL test reports
skipped), `pnpm test:ar2-contract`, `pnpm foundation:check`, `pnpm architecture:get-modular-adoption`, `pnpm lint`.

### Commit 2 `test(ci): require the ordinary store contract suite on PostgreSQL`

1. `scripts/ci/run-ordinary-postgres.mjs`: turn `requiredTests` into repository-relative paths (embedded-runtime is
   under `packages/apps`), keeping the three existing entries exactly, and add
   `["packages/apps/embedded-runtime/tests/features/ordinary-session-runtime/ordinary-store-contract.postgres.test.ts", "ordinary operation store contract suite against PostgreSQL"]`;
   map with `([path, name]) => ({file: resolve(repositoryRoot, path), name})`; the final message uses
   `requiredTests.length` instead of the literal 3. Nothing else changes (URL validation, isolation, timeouts, the
   rejection of skips, todos and failures stay).
2. `scripts/ci/run-ordinary-postgres.test.mjs`: the `names` list gains the fourth name and the file count assertion
   becomes 4. Keep every rejecting case.
3. Do not touch `.github/workflows/ci.yml` or `scripts/ci/ordinary-postgres-disposable.sh`.

Gates (exit 0): `pnpm foundation:boundaries:negative`, `pnpm typecheck:ci`, `pnpm test:ci`, `pnpm lint`. Locally on
Linux with Docker:
`POSTGRES_TEST_IMAGE='postgres:18.4-trixie@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636' bash scripts/ci/ordinary-postgres-disposable.sh`
after `pnpm product:build` (on macOS, socket bind mounts into Docker do not work reliably: rely on CI). Expected last
line: `Ordinary PostgreSQL gate: all 4 required integration tests passed without skips`.

### Commit 3 `docs: record the ordinary store contract suite`

- `packages/apps/embedded-runtime/src/features/ordinary-session-runtime/README.md`: one paragraph: the contract suite
  of `agent-runtime/ordinary/store`, the owner fake and their test paths; STORE-2-core moves the cases module unchanged
  into the private storage compatibility package and Embedded Runtime then imports it from there.
- `docs/architecture/get-modular-adoption.md` (pin review table) and
  `architecture/get-modular/evidence/train-030-cms-pin-review.json` (`normDisposition`: `state` and `closedBy` only, as
  AR-1b, AR-1c and AR-2 do; `scripts/architecture/check-cms-pin.mjs` hashes only the retained standard bytes and the
  delta, not the review JSON): row "Testing 3", state "met for `agent-runtime/ordinary/store` (owner fake and PostgreSQL
  store). Rule 3 applies to contracts with a second behavioural implementation; the other ordinary contracts have
  only single-scenario stubs inside one test file and are recorded as no second implementation (decided during planning
  on 2026-10-04). Each library card (LIB-PROCESS, LIB-CODEX-1, STORE-2-core) adds a suite with its first owner fake",
  closedBy "issue #189".

Gates: `pnpm docs:protocol:check`, `pnpm test:consumer-modules`, `pnpm architecture:consumer-modules`,
`pnpm architecture:get-modular-adoption`.

## 5. Gates for the PR (exit 0 each)

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

In the `postgres-durability` log the fifteen `[postgres]` cases and the parent test appear as `test:pass`.

## 6. Risks and stop conditions

- A case fails on PostgreSQL but passes on the fake: the fake or the case is wrong, never the adapter. Fix the case or
  the fake to the adapter's behaviour; if the adapter's behaviour looks like a defect (for example a lost CAS), stop and
  report with the test output.
- The PostgreSQL store rejects an operation as invalid (domain validator): the case data is wrong (usually the closure);
  fix the data, not the store.
- A case can only pass with a sleep, a mocked clock or a message match: drop that assertion and say so in the PR body
  (time-dependent claim expiry stays an adapter test).
- The `postgres-durability` runtime grows by more than 60 seconds, or the runner's 240-second overall signal gets close:
  report before merging.
- The guard (if present) reports a leaked `pg` handle: a pool was not ended; fix the subject's cleanup.
- Any need to touch `.github/workflows/ci.yml`, the disposable script, production code or the port: stop.

## 7. Must not

- Import Get Modular, `node:test` or embedded-runtime code in `ordinary-store-cases.ts`.
- Import `@get-modular/conformance` from production code, or add a public export for tests.
- Weaken the PostgreSQL runner (skip tolerance, fewer required tests, wider URLs).
- Use `as never`, `as any` or double casts; add sleeps.
- Use destructive git commands or a non-local git identity; mention AI tools anywhere.

## 8. Done when

- The suite has the 15 cases; `[in-memory]` passes in the package tests; `[postgres]` passes in `postgres-durability`
  through the required parent test; a revision-mismatched declaration is rejected at registration.
- The five new files are type-checked by `pnpm typecheck`; the runner requires 4 tests; docs updated; all gates green.

## 9. Review checklist

1. Re-run section 2; confirm names, ids and that the port has not changed since the base.
2. Read `ordinary-store-cases.ts`: only the allowed imports; no message matching; no sleeps; every case independent.
3. Mutation (fake): make a duplicate `accept` return a fresh `operationId`; the `[in-memory]` run must fail. Revert.
4. Mutation (fake): drop the revision check in `prepare`; `prepares once and rejects a stale revision` must fail. Revert.
4a. Mutation (fake): drop the `cancellationRequested` check in `claim`; `does not claim an unprepared or cancelled
   operation` must fail. Revert.
4b. Mutation (fake): let `finish` report `succeeded` for a `completed` provider terminal without the full closure;
   `keeps an incomplete closure in reconciliation` must fail. Revert.
5. Mutation (fake): insert `await Promise.resolve()` between the check and the write in `claim`;
   `claims exactly once under concurrent claims` must fail. Revert.
6. Mutation (fake): let `finish` overwrite a recorded receipt; `rejects a receipt that contradicts a recorded one` must
   fail. Revert.
7. Mutation (suite binding): in the fake declaration replace `OrdinaryStore.provide()` with the `provide()` of a scratch
   `defineContract<OrdinaryOperationStore>()({ id: "agent-runtime/ordinary/store", revision: 2 })`; registration must
   throw `conformance.suite.revision-mismatch`. Revert.
8. Mutation (gate): in a scratch edit remove the new entry from `requiredTests`; `pnpm foundation:boundaries:negative`
   must fail. Revert. (A skipped required test is already rejected by `run-ordinary-postgres.test.mjs`.)
9. In the `postgres-durability` log of the PR head, find the fifteen `[postgres]` case passes and the gate's final line
   with 4 tests.
10. `git diff origin/main --stat`: only the new test files, the launcher list, the root `tsconfig.json` `include`, the
    two `scripts/ci` files, the README, `get-modular-adoption.md` and the pin review JSON (state and `closedBy` of the
    "Testing 3" row only); no `package.json` changes (`@types/pg` came with brief 03).
