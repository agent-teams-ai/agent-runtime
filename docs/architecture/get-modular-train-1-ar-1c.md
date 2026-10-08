---
id: runtime.architecture.get-modular-train-1-ar-1c
type: architecture
status: active
owner: architecture
summary: "Brief for AR-1c: resource scopes for ordinary owners and smoke for the composition root."
---

# Get Modular Train 1 AR-1c

AR-1c: resource scopes for ordinary owners, smoke for the composition root. PR title
`feat(embedded-runtime): release ordinary owners through resource scopes`, branch
`feat/ordinary-host-resource-scopes` from fresh `origin/main` after AR-1b merged. Six commits C1 to C6.
Estimated +480 / -200 (without the retained archive).

## 0. Handoff inputs (the owner fills these through the handoff-inputs docs PR; do not start with a placeholder left)

| Input | Value |
|---|---|
| R-1a bundle `get-modular-0.3.0-train-r1a`: location and fetch command | get-modular PR #151, commit `869d6e065fd191ec5c0ecd8c5deff30106598f9c`, directory `research/releases/0.3.0-train/` (the four archives, `SHA256SUMS`, `INTEGRITY`, `release-intent.md`). Fetch: `git -C <get-modular clone> fetch origin 869d6e065fd191ec5c0ecd8c5deff30106598f9c`, then copy exactly the seven files, each with `git -C <get-modular clone> show 869d6e065fd191ec5c0ecd8c5deff30106598f9c:research/releases/0.3.0-train/<file> > <bundle dir>/<file>`, with `<bundle dir>` outside any repository checkout. The directory also holds `release-plan.md`, which is not part of the bundle |
| `SHA256SUMS` line for `get-modular-resources-0.1.0.tgz` | `1172c89d9f863d0e1763293eb6153d0835c609fc01ea730004fcee293872cc7a  get-modular-resources-0.1.0.tgz` |
| `INTEGRITY` lines for `get-modular-resources-0.1.0.tgz` and `get-modular-conformance-0.1.0.tgz` | `get-modular-conformance-0.1.0.tgz sha512-yIxQqJd/RRIxtO3uoo3MQXNdfeMk96qjzzW3ggfxTyfg9/UDUl7qfB3nOTWVkDN+Zg/gLFY+24grd1zGUQSWmw==`; `get-modular-resources-0.1.0.tgz sha512-sIC+ZYI196qK11Dmz9s9U/Va4UAOU5G8m9beCp3zIIbEK0fKLAWGssd4l72aS0ycRBi5AhsbKFysKS9EVVax8g==` |

## 1. Decision on the root deadline (recorded, not open)

Consumer Module Standard Host rule: "Use one deadline at the root: escalate first, then abandon, with referenced
timers". Decision for this train: no new deadline in AR-1c. The decorated `dispose()` closes owners without a
deadline, as the manual list does today; the Host drain keeps its 1 s caller wait. The row of the section "Train 0.3.0 conformance status" of `docs/architecture/get-modular-adoption.md` says:
"outstanding by decision of 2026-10-04: release of the resource owners keeps today's behavior without a deadline; added when an owner's
release can block without its own bound, or on owner request; prepared values grace 5000 ms, abandon 5000 ms".
Today the owners bound their own I/O: Runtime Security transactions set `statement_timeout` 5000 ms, Provider Access
transactions use connection 1000 ms, statement 2000 ms and transaction 4000 ms
(`ordinary-pa-store.ts:57`), and the broker close is bounded. For the later step, the helper would be:

```ts
async function closeWithin(control: ScopeControl, graceMs: number, abandonMs: number): Promise<CloseReport> {
  const escalate = new AbortController(); const abandon = new AbortController();
  const toEscalate = setTimeout(() => { escalate.abort(); }, graceMs);
  const toAbandon = setTimeout(() => { abandon.abort(); }, graceMs + abandonMs);
  try { return await control.close({ escalate: escalate.signal, abandon: abandon.signal }); }
  finally { clearTimeout(toEscalate); clearTimeout(toAbandon); }
}
```

Do not add it in this PR.

## 2. Facts you need (verified at agent-runtime `0ace1cce`, rechecked unchanged at `44846323`; get-modular `81063ad`)

`@get-modular/resources` 0.1.0:

- `createScope({ name, order? })` returns `{ resources, control }`. `Resources`: `signal`, `setup({ name, setup, cleanup })`,
  `use(value, name)` for a `Disposable`/`AsyncDisposable` in hand, `child({ name, order })`. `order` is `"reverse"`
  (default, LIFO, one at a time) or `"concurrent"`.
- `control.close({ escalate?, abandon? })` never rejects; `CloseReport = { complete, settled, debts }`; it releases in
  reverse order, records a failed cleanup as a debt and continues; a later `close()` retries only failed entries; a
  child whose close is complete detaches from its parent. `complete: true` means every cleanup returned without
  throwing, not proof of physical release.
- `scoped(implementationId, factory)` opens one module scope per factory call under the run scope Assembly passes as
  `FactoryContext.scope`; it throws `resources.scoped.invalid-run-scope` unless `run({ scope })` received the
  `Resources` of a scope from the same package copy. `ModuleContext = { signal, resources }`.
- Errors carry `code`: `resources.scope.closed`, `resources.close.incomplete` (`CloseIncompleteError`, an
  `AggregateError` with `report`), `resources.argument.invalid`, `resources.scoped.invalid-run-scope`.

`@get-modular/conformance` 0.1.0 (peers Core `^0.3.0`, Assembly `^0.3.0`, resources `^0.1.0`):

- `smoke({ api, compose, inject?, at?, inputs? })`: calls `compose(api)` once, runs once without injection, then once
  with a failure and once with an abort injected at every constructed module, each run under its own
  `createScope({ name: "smoke" })` closed after the run. It throws `conformance.smoke.failed` when a step outcome is
  wrong, an attempt's close is incomplete, or a factory was bound outside the given api.
- `isolate(api, { declaration, factory: ModuleFactory<C, D, I, ModuleContext>, dependencies, signal?, within? })`
  builds one module through a real Assembly run; the result has `close()` (never rejects) and `[Symbol.asyncDispose]`
  (throws on debt).

Current code (after AR-1b; line numbers are from base `0ace1cce`):

- `packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts:45-132`:
  a manual `cleanups` list (journal first), reverse walk that stops at the first failure (`:56-62`), lazy Codex
  adapter registration (`:63-70`), and a decorated `dispose` that disposes the Host and the feature in parallel and
  then the owners (`:90-103`).
- The Host drain already calls the ordinary turn owner (`createAgentRuntimeHost(dependencies, ordinaryOwner)`) and
  releases contained-turn bookkeeping only after it succeeds
  (`src/composition/agent-runtime-host-disposal.ts:360-375`).
- Normative feature README (`.../ordinary-session-runtime/README.md:29-39`): "The Host joins the ordinary feature
  before disposing its owned PA/RS/provider resources and journal." "Inner Host/feature recovery must succeed before
  outer prerequisite owners and the journal are released." "failed observations retain their owners, and successful
  actions are not repeated." The regression `tests/package/ordinary-creation-cleanup.fixture.ts:89-131` pins this.
- Drain race: in `HostDisposalOrchestrator.dispose` (`agent-runtime-host-disposal.ts:331-358`) an ordinary Host resets
  `#disposal` when the 1 s wait deadline rejects (`HOST_DISPOSAL_WAIT_DEADLINE_MS = 1_000`, line 25) while
  `#finishDisposal` still runs, so the next `dispose()` starts a second `#finishDisposal`.
- Provider Access owner disposal does not call Runtime Security or Codex
  (`packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts:194-205`);
  Runtime Security transactions set `statement_timeout` 5000 ms.
- ADR-0015 says "Core/Assembly imports stay in `composition.embedded-runtime`"; no accepted ADR admits
  `@get-modular/resources`. Next free ADR number at base: 0024 (accepted registry ends at ADR-0023 and ADR-0090).
- `strictPeerDependencies: true`, `catalogMode: strict`, `minimumReleaseAge: 0`. Test boundary
  `test.embedded-runtime` allows `@get-modular/assembly` and `@get-modular/core` only
  (`architecture/foundation/source-dependencies.yaml:1384-1400`); `composition.embedded-runtime` allows Core and
  Assembly (`:831-837`).

## 3. Re-verify before start

```sh
git fetch origin && git log --oneline -5 origin/main
git log --oneline <AR-1b merge>..origin/main -- packages/apps/embedded-runtime packages/contexts/provider-access scripts/architecture architecture docs/decisions
ls docs/decisions | tail -5; node -p "require('./architecture/decisions/accepted-decisions.json').decisions.map(d => d.id).join(' ')"
npm view @get-modular/resources@0.1.0 dist.integrity; npm view @get-modular/conformance@0.1.0 dist.integrity peerDependencies
pnpm exec agent-teams-foundation --help | grep -n "architecture-decisions-promote-baseline"
gh pr list --repo agent-teams-ai/agent-runtime --state open
```

Integrities equal the `INTEGRITY` lines of section 0 (bundle `get-modular-0.3.0-train-r1a`); conformance
peers are `^0.3.0`, `^0.3.0`, `^0.1.0` (key order may differ: pnpm writes them in a varying order, which is why the
bundle's bytes, never a new pack, are the reference); ADR number 0024 is
still free (otherwise use the next free number everywhere in this brief); the promote command exists (if not, stop and
ask). Environment as in AR-1a.

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

## 4. Scope and non-goals

In scope: ADR-0024; resources (dependency) and conformance (dev-only) for embedded-runtime; the drain race fix;
scoped ordinary owners and the scope tree below; smoke for the passive and the ordinary profile; one `isolate` test;
docs. Non-goals: Provider Access internals (AR-2); contained-turn and Darwin deployment cleanup (they keep their own
cleanup until ADR-0016); contract suites, `guardHandles` and the remaining fake typing (issue #189); plugins;
changing the turn owner handoff.

## 5. Owner decisions (facts)

- Only resource owners (security, Provider Access, Codex) and the journal go into scopes. The turn and the raw Host
  are closed by the Host drain, which keeps the ordinary turn owner handoff and its AST gate (decision 2026-10-02,
  13.1).
- Owner release continues past a failed owner (resources semantics); the journal sits in an outer scope and closes
  only after the owners report complete; the Host drain must succeed before any owner is released (decision B,
  2026-10-01; program plan D5).
- Shared-first review: the "inner complete, then outer" policy is about 15 lines of Host policy; the Consumer Module
  Standard keeps such policy in the Host ("policy belongs to the Host, not to the library"), so no shared package.
  Revisit when a second Host needs the same helper.
- Conformance is a development-only package and is not part of the production package set in
  `consumer-profile.json` (that set holds the packages production code imports; conformance stays pinned by the exact
  catalog version and lock integrity, and Foundation's dev-only assertion keeps it out of runtime dependencies).

## 6. Scope tree

```text
ordinary-host (createScope, reverse)          Host policy: close owners; only when complete, close ordinary-host
├─ journal              use(Symbol.dispose -> journal.close())
└─ owners               child; its resources are the run scope: prepared.run({ signal, scope: owners })
   ├─ agent-runtime/ordinary/security/postgres         scoped()  └─ security-owner   (setup/cleanup)
   ├─ agent-runtime/ordinary/provider-access/postgres  scoped()  └─ provider-access-owner
   └─ agent-runtime/ordinary/provider/codex            scoped()  └─ codex
Host dispose: inner Host drain (turn owner handoff) -> owners.close() -> if complete: ordinary-host.close()
```

The release order among owners is the reverse of their construction order (the plan's dependency order). If review
finds a cleanup of one owner that needs another owner, stop: the dependency must become a slot (Consumer Module
Standard author rule 3) or the needed owner moves to the outer scope.

## 7. Commits

### C1 `docs(decisions): accept ADR-0024 for Get Modular resource scopes`

`pnpm docs:new -- --type adr --id ADR-0024 --title "Get Modular resource scopes for ordinary owners and Provider Access grants" --owner architecture --summary "Admits @get-modular/resources 0.1.0 for ordinary Host owners and Provider Access grants, and @get-modular/conformance 0.1.0 as a development-only test dependency." --dry-run`,
then `--apply`. Body (English, `Status: proposed` until the owner approves the text in review):

- Context: train 0.3.0 adoption (AR-1a, AR-1b); the manual cleanup list stops at the first failure; ADR-0015 admits
  only Core and Assembly imports in `composition.embedded-runtime`.
- Decision: Embedded Runtime consumes `@get-modular/resources` 0.1.0 with Core and Assembly 0.3.0 (exact catalog,
  retained archive, one copy). Ordinary cleanup uses the scope tree of this brief; owners release in reverse
  construction order and continue past failures; the journal closes only after the owners report complete; the Host
  drain, including the ADR-0090 turn owner handoff, must succeed before any owner is released.
  `composition.provider-access.ordinary` may use resources for per-grant child scopes with concurrent order; domain,
  application and contracts never import it. `@get-modular/conformance` 0.1.0 is admitted as a development-only
  dependency of the test code of the Agent Runtime packages that guard handles or smoke-test composition roots
  (Embedded Runtime and filesystem-custody); production code never imports it, and Foundation's development-only
  assertion keeps it out of runtime dependencies. (AR-1c adds it to Embedded Runtime only; issue #189 adds it to
  filesystem-custody under this same ADR.) This extends ADR-0015's import rule by exactly these permissions;
  ADR-0015 and ADR-0090 bytes stay unchanged. Contained-turn and Darwin deployment keep their own cleanup until ADR-0016.
  Root deadline: none in this train; releasing the resource owners keeps today's behavior. A deadline (escalate, then
  abandon) is added when an owner's release can block without its own bound, or on owner request; prepared values
  grace 5000 ms, abandon 5000 ms.
- Consequences: debt paths name implementation IDs; a failing Provider Access release no longer blocks Runtime
  Security and Codex release; the conformance status rows closed by AR-1c and AR-2.

In C1 also add `ADR-0024` to the `related` list of `docs/decisions/README.md` and one bullet under `## Proposed`
(like ADR-0016): the type `adr` has reachability `manual-fixed-index` through that file, so `pnpm docs:check` needs it.

After the owner approves the text in the PR: set `status: accepted` in the frontmatter and `Status: accepted` in the
body, move the bullet in `docs/decisions/README.md` from `## Proposed` to `## Accepted`, run
`pnpm exec agent-teams-foundation architecture-decisions-promote-baseline` to add its digest to
`architecture/decisions/accepted-decisions.json`, and commit. Gates (exit 0): `pnpm docs:check`,
`pnpm docs:protocol:check`, `pnpm docs:qualification`, `pnpm test:get-modular-adoption`. Without explicit owner
acceptance this PR and AR-2 do not merge.

### C2 `build(deps): add Get Modular resources 0.1.0 and conformance 0.1.0`

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | catalog `'@get-modular/resources': 0.1.0`, `'@get-modular/conformance': 0.1.0`; `minimumReleaseAgeExclude` add `@get-modular/resources@0.1.0` and `@get-modular/conformance@0.1.0` after the Assembly entry |
| `scripts/docs/consumer-migration.test.mjs` | (1) the same two entries in the exact `minimumReleaseAgeExclude` list (`:52-60`); (2) the test "stable31 managed bytes stay exact and the current Foundation source policy retains reviewed scope" authenticates the whole `architecture/foundation/source-dependencies.yaml` by reversing reviewed finite additions down to fixed digests (`:138-210` at `44846323`). Reverse this commit's additions first: right after `const comparatorPolicyBytes = await read("architecture/foundation/source-dependencies.yaml");` add a comment line `// Get Modular train 1 (AR-1c) admits resources and conformance; reverse only these lines.` and `const getModularAdditions = ["    - '@get-modular/resources'\n", "    - '@get-modular/conformance'\n"];`, assert their exact counts (2 and 1) with `split(...).length - 1`, remove them with `split(...).join("")`, and let the existing chain read the result instead of `comparatorPolicyBytes`. Never change an existing digest; if one fails, the edit added more than these lines: stop. |
| `packages/apps/embedded-runtime/package.json` | `dependencies`: `"@get-modular/resources": "catalog:"`; `devDependencies`: `"@get-modular/conformance": "catalog:"` |
| `pnpm-lock.yaml` | `pnpm install`, then `pnpm install --frozen-lockfile`; resources and conformance integrities equal the bundle's `INTEGRITY` lines |
| `architecture/get-modular/evidence/get-modular-resources-0.1.0.tgz` | downloaded with `npm pack @get-modular/resources@0.1.0` (a registry download, not a pack from source) and checked with the bundle's `SHA256SUMS`; conformance is not retained (development only), its lock integrity is the check |
| `architecture/get-modular/consumer-profile.json` `packages` | third entry for resources |
| `architecture/get-modular/consumer-profile.schema.json:137` | enum adds `"@get-modular/resources"` |
| `scripts/architecture/check-get-modular-adoption.mjs:39` | `['@get-modular/core', '@get-modular/assembly', '@get-modular/resources']`, message `exact package set` |
| `scripts/architecture/check-get-modular-adoption.test.mjs:39` | synthetic triple; new rejecting case: a profile with only Core and Assembly fails with `/exact package set/` |
| `architecture/foundation/source-dependencies.yaml` | `composition.embedded-runtime` `allow.packages` add `'@get-modular/resources'`; `test.embedded-runtime` add `'@get-modular/conformance'` and `'@get-modular/resources'` (alphabetical) |
| `architecture/foundation/dependency-declarations.yaml` | `developmentOnlyPackages` add `"@get-modular/conformance"` |

The packed consumer test already reads names and versions from the profile (AR-1a). If Foundation rejects a declared
but not yet imported dependency, move the resources edits into C4 and the conformance edits into C5 and say so in the
PR description. Gates (exit 0): `pnpm install --frozen-lockfile`, `pnpm foundation:check`,
`pnpm architecture:get-modular-adoption`, `pnpm test:get-modular-adoption`, `pnpm docs:qualification`,
`pnpm --filter "@agent-teams/embedded-runtime..." run build && pnpm --filter @agent-teams/embedded-runtime test`.
Check one copy: `ls node_modules/.pnpm | grep -c '^@get-modular+resources@'` prints 1.

### C3 `fix(embedded-runtime): never start a second drain while the first is running`

`src/composition/agent-runtime-host-disposal.ts`, class `HostDisposalOrchestrator`:

```ts
  #finishing: Promise<void> | undefined;
  // A rejected wait (deadline) ends only this caller's wait; a new drain starts after the running one settles.
  readonly #finish = (): Promise<void> =>
    this.#finishing ??= this.#finishDisposal().finally(() => { this.#finishing = undefined; });
```

and in `dispose()` race `this.#finish()` instead of `this.#finishDisposal()`. A Host without an ordinary owner never
resets `#disposal`, so contained-turn behavior is unchanged. Test in
`tests/package/agent-runtime-host-disposal.unit.test.ts` (already in the runner):

```ts
test("a retry after the wait deadline joins the running ordinary drain", {timeout: 5000}, async () => {
  let calls = 0; const gate = Promise.withResolvers<void>();
  const lifecycle = createAgentRuntimeHostDisposalLifecycle(undefined, async () => { calls += 1; await gate.promise; });
  const first = lifecycle.dispose(); assert.equal(lifecycle.dispose(), first);
  await assert.rejects(first, (e: unknown) => e instanceof AgentRuntimeHostDisposalIncompleteError);
  const retry = lifecycle.dispose();
  assert.equal(calls, 1);
  gate.resolve(); await retry; assert.equal(calls, 1);   // on main: 2, a second drain started after the first
});
```

Use the existing factory and error names of that test file; if the lifecycle factory has another signature, adapt
the call, not the assertions. The test waits for the real 1 s deadline (the timer is `unref`); do not add sleeps.
Gates: `pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm --filter @agent-teams/embedded-runtime test`.

### C4 `feat(embedded-runtime): release ordinary owners through resource scopes`

1. Feature `ordinary-runtime-assembly.ts`: `OrdinaryRuntimeFactories` becomes

   ```ts
   security(resources: Resources): Promise<{readonly port: OrdinaryTurnDependencies["security"]; readonly registerSecrets: RegisterSecrets}>;
   providerAccess(registerSecrets: RegisterSecrets, resources: Resources): Promise<OrdinaryTurnDependencies["providerAccess"]>;
   provider(resources: Resources): Promise<{readonly provider: OrdinaryTurnDependencies["provider"]; readonly prepareLaunch: OrdinaryLaunchRecipe}>;
   // operationStore, workspace, artifacts, process unchanged
   ```

   and the module factories `security`, `providerAccess`, `provider` in `createOrdinaryModuleFactories` take
   `ModuleContext` (fourth type argument) and pass `context.resources` on. `import type {ModuleContext, Resources} from "@get-modular/resources"`.
2. Root `runtime-setup-assembly.ts`: bind those three as
   `api.bindFactory(ordinarySecurityDeclaration, scoped(ordinarySecurityDeclaration.implementationId, modules.security))`
   (same for Provider Access and provider). Split the ordinary input:

   ```ts
   export interface OrdinaryRuntimeBindingInput {
     readonly factories: OrdinaryRuntimeFactories;
     readonly decorateHost: (host: AgentRuntimeHost) => AgentRuntimeHost;
   }
   export interface OrdinaryRuntimeAssemblyInput extends OrdinaryRuntimeBindingInput {
     /** Run scope of the owning modules: the ordinary Host's owners scope. */
     readonly owners: Resources;
   }
   ```

   `bindRuntimeSetup` and `composeRuntimeSetup` take `OrdinaryRuntimeBindingInput`; `buildHost` calls
   `ordinary.decorateHost(rawHost)`.
3. `default-agent-runtime-host.ts` run call (line 62 at base):
   `preparation.prepared.run({ ...(signal === undefined ? {} : { signal }), ...(ordinary === undefined ? {} : { scope: ordinary.owners }) })`.
   The `ownedHost` capture and its cleanup stay as they are.
4. Feature `ordinary-agent-runtime-host.ts` (replace `:56-70` and `:90-103`; keep option capture, journal
   initialization and `bindAccess` exactly):

   ```ts
   import {createScope, CloseIncompleteError, type CloseReport} from "@get-modular/resources";

   const incomplete = (report: CloseReport, message: string): AggregateError =>
     new AggregateError(report.debts.flatMap(debt => debt.state === "failed" ? [debt.cause] : []), message,
       {cause: new CloseIncompleteError(report)});

   // after the journal exists:
   const host = createScope({name: "ordinary-host"});
   host.resources.use({[Symbol.dispose]: () => { journal.close(); }}, "journal");   // owners record into it while releasing
   const owners = host.resources.child({name: "owners"});
   const releaseOwnersThenJournal = async (): Promise<void> => {
     const inner = await owners.control.close();                                    // a later call retries only failures
     const report = inner.complete ? await host.control.close() : inner;
     if (!report.complete) {throw incomplete(report, "ordinary_host_cleanup_incomplete");}
   };
   ```

   Factories: `security: async resources => { const owner = await resources.setup({name: "security-owner", setup: () => createOrdinarySecurityOwner({...unchanged}), cleanup: o => o.dispose()}); await owner.migrate(); return {...unchanged}; }`
   (the owner is registered before `migrate` awaits, so a failed migration keeps it owned); `providerAccess` the same
   with `"provider-access-owner"`; `provider: resources => resources.setup({name: "codex", setup: () => createOrdinaryCodexAdapter({...unchanged}), cleanup: codex => { codex.dispose(); }})`.
   `construct(options.signal, {owners: owners.resources, factories, decorateHost})`, where

   ```ts
   decorateHost(inner) {
     let disposal: Promise<void> | undefined;
     const dispose = (): Promise<void> => disposal ??= (async () => {
       await inner.dispose();             // drain and turn owner handoff prove closure first
       await releaseOwnersThenJournal();  // no root deadline in this train (section 1)
     })().catch((error: unknown) => {
       disposal = undefined;
       throw new AggregateError(error instanceof AggregateError ? error.errors : [error], "ordinary_host_disposal_incomplete", {cause: error});
     });
     return Object.freeze({bindAccess(scope: TrustedRuntimeAccessScope) { /* unchanged */ }, dispose, [Symbol.asyncDispose]: dispose});
   }
   ```

   The catch block keeps its shape with `releaseOwnersThenJournal` in place of `cleanup`. Delete `cleanups`,
   `cleanupPromise`, `cleanup`, `codex`, `getCodex` and the parallel `feature.dispose()`.
5. `source-dependencies.yaml` needs nothing beyond C2 (external imports are outside the relationship census).

Tests (existing files, runner unchanged; every touched fake typed, no new `as never`; package test files are not
type-checked by any gate today, issue #189 adds that, so the reviewer checks typing by reading):

| File | Change | Fails when |
|---|---|---|
| `tests/package/ordinary-creation-cleanup.fixture.ts` | mock `createOrdinaryCodexAdapter` and `createOrdinaryTurnFeature` of `@agent-teams/agent-execution/composition` next to the existing owner mocks, one shared `events` array; the feature failure interception moves from `decorateHost` to the turn feature mock | |
| same, new test | real Assembly path (`createAgentRuntimeHost(f.options)` with the in-memory pool): after `dispose()` the events are `["feature", ...owners in reverse construction order, "journal"]`; record the construction order in the setup mocks and assert the release order is its reverse | owners close before the drain, or out of order, or the journal is not last |
| same, new test | Provider Access cleanup fails once: after the first `dispose()` `paDisposals === 1`, `securityDisposals === 1`, Codex released, journal open; after `paReady = true` and two more `dispose()`: `paDisposals === 2`, `securityDisposals === 1`, journal closed once | the journal shares the owners scope; release stops at the first failure; successful releases repeat |
| same, `nested failed creation...` (`:90-131`) | remove the Host wrapper in `decorateHost` and the `hostDisposals` assertions (`:113`, `:127`): the decorated dispose now re-runs the inner drain on every recovery, so that counter no longer measures anything stable; the turn feature mock counts drains instead: `featureDisposals` 1, then 3, then 3 (unchanged values). Feature not ready: `paDisposals === 0 && securityDisposals === 0`, journal open (unchanged); after `featureReady = true; paReady = false`: `securityDisposals === 1` (was 0; owners now continue past a failure, comment in the test) | owners released before the drain is proven |
| same, `partial ordinary creation...` (`:66-88`) | call `ordinary.factories.security(ordinary.owners)`; counters `1 -> 2 -> 3` unchanged | an owner acquired before `migrate` is lost |
| `tests/package/ordinary-host-disposal.test.ts:17-66` | `ordinary.factories.provider(ordinary.owners)`, `ordinary.decorateHost(realHost)`; the first `dispose()` rejects with `hostFailure` in `errors`, journal open; after `stopped = true`: `hostCloses === 2`, journal closed once | retry after a failed drain |
| `tests/package/ordinary-runtime-assembly.test.ts:76-119` | fakes take `resources` and register their owners with `resources.setup`; run with `scope` of a test scope that the test closes; replace the `decorateHost(host, feature)` assertion with `hostOwner === result.created.find(e => e.implementationId === "agent-runtime/ordinary/turn/default")?.instance` | |

`ordinaryHostOwnershipRetry` and `ordinaryHostProviderOwnerRetry` build the Host directly and stay unchanged.

Gates for C4 (exit 0): `pnpm typecheck`, `pnpm --filter "@agent-teams/embedded-runtime..." run build`,
`pnpm --filter @agent-teams/embedded-runtime test` twice in a row, `pnpm test:get-modular-adoption`,
`pnpm architecture:get-modular-adoption`, `pnpm architecture:feature-modules:active`, `pnpm foundation:check`,
`pnpm product:check`.

### C5 `test(embedded-runtime): smoke both composition profiles and isolate a scoped owner`

- `tests/package/runtime-setup-assembly.test.ts` (the passive factories from `createRuntimeSetupFactories` perform
  no I/O when constructed, as the existing "real consumer preparation" tests rely on; if one does, use a fake for it):
  compile the passive profile, then
  `smoke({ api: assemblyFor<RuntimeSetupCapabilities>(), compose: api => composeRuntimeSetup(api, composition, createRuntimeSetupFactories(process.platform), host => { hosts.push(host); }) })`;
  `steps.length === 15` (one run plus fail and abort at 7 modules); afterwards dispose every collected Host.
- `tests/package/ordinary-runtime-assembly.test.ts`: the same for the ordinary profile with typed fake ordinary
  factories whose security, Provider Access and provider fakes register a fake owner through `resources.setup` and
  count creations and releases; `steps.length === 31` (15 modules); every created fake owner released exactly once;
  every collected Host disposed after the smoke.
- One `isolate` test for the provider module: `isolate(assemblyFor<OrdinaryRuntimeCapabilities>(), { declaration: ordinaryProviderDeclaration, factory: createOrdinaryModuleFactories(fakes).provider, dependencies: {} })`,
  release with `await using` (Node 24 runs it; if the runner rejects the syntax, use `const report = await isolated.close(); assert.equal(report.complete, true)`);
  the fake Codex adapter is released once.
- Every scope a test creates is closed; no sleeps.

Gates: build and `pnpm --filter @agent-teams/embedded-runtime test` (exit 0).

### C6 `docs(architecture): record scoped ordinary cleanup`

Feature README (`:29-40`): the scope tree, owners continue past a failure, journal after owners, and keep the sentence
"Inner Host/feature recovery must succeed before outer prerequisite owners and the journal are released".
`docs/architecture/get-modular-adoption.md` section "Ordinary closure retention and binding evidence": scopes instead
of the manual list, debt paths, smoke and isolate evidence; in the section "Train 0.3.0 conformance status" of `docs/architecture/get-modular-adoption.md` switch the rows whose
`closedBy` names AR-1c to their final state, rows shared with AR-2 to `pending: AR-2`. Never edit
`smart-ci-cms-pin-review.json`. Gate: `pnpm docs:protocol:check`.

Final gates: the local full gates of section 3 after the last commit. A live ordinary end-to-end run
needs a separate owner permission and a disposable environment; it is not part of this PR.

## 8. Risks and stop conditions

- ADR-0024 not accepted: no merge (AR-2 neither).
- Two copies of `@get-modular/resources` (the scope check throws `resources.scoped.invalid-run-scope`): stop.
- A type error that needs a cast around `scoped()` or `ModuleFactory`: stop, Get Modular finding.
- An owner cleanup that depends on another owner: stop (section 6).
- Flaky tests on a `runtime-macos` package shard, or a shard above 12 minutes (limit 15): report.

## 9. Must not

Put the turn feature or the raw Host into a scope; drop the turn owner handoff or its gate; capture a scope at bind
time; pass a `Scope` (instead of its `resources`) to `run`; compare Get Modular errors with `instanceof`; add
production files; add conformance to production dependencies; touch the root `package.json` (its dependencies and
command inventory are frozen by `scripts/ci/conformance.ts`); change package.json scripts or workflows.

## 10. Done

ADR-0024 accepted by the owner; required checks green; independent review clean after re-run; owner merges.

## 11. Review checklist (owner's reviewer)

1. `grep -n "scoped(" packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts` shows exactly the
   three owning modules; `grep -rn "createScope" packages/apps/embedded-runtime/src` shows only the ordinary Host.
2. `grep -rn "instanceof .*Error" packages/apps/embedded-runtime/src | grep -i "resources\|assembly\|scope"` is empty.
3. Mutations in a scratch clone at the PR head, each committed on a detached HEAD and started again from the PR head,
   each must make the named test fail:
   - register the journal in `owners` instead of the outer scope: the "Provider Access cleanup fails once" test;
   - close `ordinary-host` without checking `inner.complete`: same test (journal closed early);
   - swap `await inner.dispose()` and `await releaseOwnersThenJournal()`: the nested creation test;
   - remove the `#finishing` join in C3: the drain retry test (`calls === 2`);
   - drop `scope` from the run call: `ordinary-runtime-assembly.test.ts`, test "public ordinary construction and
     disposal ...", fails with `resources.scoped.invalid-run-scope`;
   - make a fake owner cleanup throw in the ordinary smoke test: `smoke` rejects with `conformance.smoke.failed`.
4. `ls node_modules/.pnpm | grep -c '^@get-modular+resources@'` prints 1 after `pnpm install --frozen-lockfile`.
5. `node -p "require('./packages/apps/embedded-runtime/package.json').devDependencies"` contains conformance and
   `dependencies` does not; `pnpm foundation:assert-dev-only` exits 0.
6. ADR-0024 is in `accepted-decisions.json` with a digest, and the accepted bytes equal the reviewed text.
7. `git diff origin/main -- '*.ts' | grep -c '^+.*as never'` is 0.
