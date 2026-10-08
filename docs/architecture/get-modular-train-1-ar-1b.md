---
id: runtime.architecture.get-modular-train-1-ar-1b
type: architecture
status: active
owner: architecture
summary: "Brief for AR-1b: module identities, contract descriptors and the root as a function of Assembly."
---

# Get Modular Train 1 AR-1b

AR-1b: module identities, contract descriptors, root as a function of Assembly. PR title `refactor(embedded-runtime): own module identities and contract descriptors`, branch
`refactor/agent-runtime-module-identity` from fresh `origin/main` after AR-1a merged. Five commits B1 to B5.
Estimated +450 / -330.

## 1. Facts you need (verified at agent-runtime `0ace1cce`, rechecked unchanged at `44846323`; get-modular `81063ad`)

Get Modular 0.3.0 authoring API (`@get-modular/assembly`, Core re-exports `required`, `optional`, `many`):

- `defineContract<Value>()({ id, revision })` returns a descriptor with `provide()` and `slot(slotId, cardinality)`.
  The wire token is exactly `<id>/r<revision>`. `revision` is an integer 1..2147483647.
- `declareModule(spec)` adds `kind` and `schemaVersion`; it refuses (type and runtime,
  `assembly.bind.invalid-declaration`) a spec that carries `kind` or `schemaVersion`, and its type accepts only entries
  produced by a descriptor, so a declaration never spells `compatibility`. It returns a frozen object; spreading a
  declared object into `declareModule` fails because the copy carries `kind`.
- `CapabilitiesOf<typeof A | typeof B>` derives a map; name a map over many descriptors as an interface.
- `ModuleFactory<C, D, Instance, Context = FactoryContext>` types a module factory with the module's own map `C`.
- `Assembly<C>` = `{ bindFactory, bindInput, prepare }`; handles are invariant only in the capabilities they use, so a
  factory typed with its own map binds under the Host map when the shared contracts are identical.

Consumer Module Standard (pinned in AR-1a), norms this PR implements, quoted:

- "A module package exports its declaration and an unbound factory typed
  `ModuleFactory<CapabilitiesOf<its contracts>, typeof declaration, Instance, ModuleContext>`; the composition root
  binds it. It never imports the Host's map."
- "Write each production composition root as a function of `Assembly<C>`. ... Bind every factory of the root through
  the `api` that `smoke` passes to `compose`: `smoke` rejects when a factory is bound elsewhere."
- Identity: "`moduleId` and `implementationId` lie in the namespace of the product that supplies the code. Within one
  release of that product, declarations with different slots or provides never share an `implementationId`, even in
  different compositions. A module keeps its `implementationId` across releases ..."; "`owner.authority` is a
  navigation label equal to the first segment of `moduleId`"; "IDs are immutable and never reused. A renamed module or
  contract is a new identity migrated through complete profiles."
- "Keep capability IDs and revisions in contract descriptors owned by the contract owner; declarations reference
  descriptors and never spell compatibility." "Keep the independent binding oracle ... never derive expected bindings
  from the profile or the implementation."

Current code (base `0ace1cce`):

- `packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts`: hand-written declarations with one shared
  token `agent-runtime/setup-v1` (line 34); `owner.authority: "agent-teams"`; the passive and ordinary Host
  declarations share `implementationId: "agent-runtime/runtime-host"` with different slots (lines 101-116 and 134), which
  violates the identity rule; `bindRuntimeSetup` creates its own `assemblyFor()` at line 159, so `smoke` cannot be used.
- `packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts`:
  IDs `ordinary/*` outside the product namespace; token `agent-runtime/ordinary-v1`; imports the Host map type from
  `../../../composition/runtime-setup-assembly.js` (line 4); `bindOrdinaryRuntime(assembly, factories)` binds the feature
  itself (lines 62-75).
- Gate `scripts/architecture/ordinary-composition-evidence.mjs`: `verifyOrdinaryGraph` reads `defineModule` literals, the
  `compatibility` identifier and token `agent-runtime/ordinary-v1` (lines 11-59); `verifyOrdinaryHostOwnership` checks
  `factories.host(..., dependencies["ordinary-turn"])` and `createAgentRuntimeHost(..., ordinaryOwner)` (lines 62-81).
  ADR-0090 requires these gates in fast and full checks ("Reject ... incorrect tokens or slots ... These gates must
  execute in fast/full checks"), so the gate is rewritten, not disabled.
- No module ID is stored outside code, tests, gates and docs (no database, journal or durable state). Owner decision:
  rename without data migration.
- Program plan default D2: the `prepare-launch` capability type switches to the Agent Execution `OrdinaryLaunchRecipe`
  in this PR. `OrdinaryLaunchRecipe` exists in
  `packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-ports.ts:54` but is not
  exported from `@agent-teams/agent-execution/composition`.

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -5 origin/main
git log --oneline <AR-1a merge>..origin/main -- packages/apps/embedded-runtime packages/contexts/agent-execution/src/composition.ts scripts/architecture architecture
grep -n "@get-modular" pnpm-workspace.yaml packages/apps/embedded-runtime/package.json   # 0.3.0, catalog:
grep -n "OrdinaryLaunchRecipe" packages/contexts/agent-execution/src/composition.ts      # absent at base
grep -rn "agent-runtime/setup-v1\|agent-runtime/ordinary-v1" packages scripts docs/architecture | cut -c1-120
gh pr list --repo agent-teams-ai/agent-runtime --state open
```

Consumer Module Standard upstream comparison (workspace rule "Consumer Module Standard maintenance"), in a disposable
get-modular clone:

```sh
git -C <gm-clone> fetch origin
git -C <gm-clone> show origin/main:docs/architecture/common-assembly.md | shasum -a 256
node -p "require('./architecture/get-modular/consumer-profile.json').standard.sha256"   # must be equal
```

If they differ, stop: the standard changed upstream, and the owner decides on a pin step (like agent-runtime #201) before this PR.

If another PR changed the files of this brief, re-read them and stop where a step no longer applies. Environment as in
AR-1a (Node from `.node-version`, pnpm 11.18.0 through corepack, identity-only `GIT_CONFIG_GLOBAL` for local checks,
`git config user.email` = `iliyazelenkog@gmail.com`).

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

## 3. Scope and non-goals

In scope: the identity table below; descriptors for every capability; `declareModule` everywhere; the ordinary feature
exports declarations and unbound factories and no longer imports the Host map; the root becomes a function of
`Assembly<C>`; gate rewrite with mutants; an independent compiled-plan oracle; profile and FMS census updates; docs.

Non-goals: resources, conformance, smoke tests, owner scopes, ADR-0024 (AR-1c); Provider Access (AR-2); prepare-once
templates or run inputs (not applicable: every Host attempt compiles, binds, prepares and runs once; no prepared
assembly serves two runs); changing composition profile literals into a builder (Get Modular has no profile builder;
profiles stay literal); typing debt outside the touched files (issue #189).

## 4. Owner decisions (facts)

- Rename IDs without data migration. Order AR-1a, AR-1b, AR-1c, AR-2.
- The ordinary turn owner handoff (`createAgentRuntimeHost(dependencies, ordinaryOwner)`) and its AST gate stay.
- `verifyOrdinaryGraph` is rewritten for the builder and stays in fast and full checks, plus a runtime oracle.
- Module packages export unbound factories; the root binds everything through the api it receives (2026-10-03).
- No open questions remain for this brief.

## 5. Identity table (final; every capability has revision 1, so every token is `<capabilityId>/r1`)

| Before (moduleId = implementationId) | moduleId | implementationId | provides | slots |
|---|---|---|---|---|
| `agent-runtime/setup-security` | unchanged | `agent-runtime/setup-security/default` | `agent-runtime/codex-authorization`, `agent-runtime/claude-authorization` | none |
| `agent-runtime/installation-discovery` | unchanged | `.../installation-discovery/default` | `agent-runtime/codex-installations`, `agent-runtime/claude-installations` | none |
| `agent-runtime/codex-configuration` | unchanged | `.../codex-configuration/default` | `agent-runtime/codex-configuration` | none |
| `agent-runtime/claude-configuration` | unchanged | `.../claude-configuration/default` | `agent-runtime/claude-configuration` | none |
| `agent-runtime/codex-planner` | unchanged | `.../codex-planner/default` | `agent-runtime/codex-planner` | none |
| `agent-runtime/claude-planner` | unchanged | `.../claude-planner/default` | `agent-runtime/claude-planner` | none |
| `agent-runtime/runtime-host` (passive) | unchanged | `agent-runtime/runtime-host/passive` | none | the 8 setup slots (unchanged slot IDs) |
| `agent-runtime/runtime-host` (ordinary) | unchanged | `agent-runtime/runtime-host/ordinary` | none | the 8 setup slots + `ordinary-turn` -> `agent-runtime/ordinary/turn` |
| `ordinary/store` | `agent-runtime/ordinary/store` | `.../ordinary/store/postgres` | `agent-runtime/ordinary/store` | none |
| `ordinary/security` | `agent-runtime/ordinary/security` | `.../security/postgres` | `.../ordinary/security`, `.../ordinary/register-secrets` | none |
| `ordinary/provider-access` | `agent-runtime/ordinary/provider-access` | `.../provider-access/postgres` | `.../ordinary/provider-access` | `register-secrets` -> `.../register-secrets` |
| `ordinary/workspace` | `agent-runtime/ordinary/workspace` | `.../workspace/node` | `.../ordinary/workspace` | none |
| `ordinary/artifacts` | `agent-runtime/ordinary/artifacts` | `.../artifacts/node` | `.../ordinary/artifacts` | none |
| `ordinary/process` | `agent-runtime/ordinary/process` | `.../process/node` | `.../ordinary/process` | `prepare-launch` -> `.../prepare-launch` |
| `ordinary/provider` | `agent-runtime/ordinary/provider` | `.../provider/codex` | `.../ordinary/provider`, `.../ordinary/prepare-launch` | none |
| `ordinary/turn` | `agent-runtime/ordinary/turn` | `.../turn/default` | `.../ordinary/turn` | `operation-store`, `security`, `provider-access`, `workspace`, `artifacts`, `process`, `provider` -> the matching `agent-runtime/ordinary/*` |

`owner.authority` becomes `"agent-runtime"` for all 16 declarations (`path` unchanged). Profile IDs
`agent-runtime/passive-setup` and `agent-runtime/ordinary-session` and all slot IDs are unchanged. Implementation
suffixes name the variant (`postgres`, `node`, `codex`, `default`, `passive`, `ordinary`) so a later store, process or
provider variant gets a new implementation ID under the same module.

## 6. Commits

### B1 `refactor(agent-execution): export the ordinary launch recipe type`

If `OrdinaryLaunchRecipe` is already exported from `@agent-teams/agent-execution/composition` (the program plan's
SEAM-1 work may do it), skip B1. Otherwise add `OrdinaryLaunchRecipe` to the type export list from `./application/ordinary-ports.js` in
`packages/contexts/agent-execution/src/features/contained-agent-turn/internal.ts` (line 107 at base) and to the
`export { type ... }` list in `packages/contexts/agent-execution/src/composition.ts` (line 5). Type-only; no runtime
export changes. Gates (exit 0): `pnpm --filter @agent-teams/agent-execution typecheck`, `pnpm test:feature-modules`,
`pnpm architecture:feature-modules:active`. If an export census or SDK public-import check rejects it: stop and ask.

### B2 `refactor(embedded-runtime): make the composition root a function of Assembly`

Behavior-preserving. `packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts`:

```ts
import type { Assembly, CapabilityContract, SuccessfulComposition } from "@get-modular/assembly";

export function bindRuntimeSetup(api: Assembly<RuntimeSetupCapabilities>, factories: RuntimeSetupFactories,
  captureHost: (host: AgentRuntimeHost) => void, completeRoot?: RuntimeSetupRootCompletion, ordinary?: OrdinaryRuntimeAssemblyInput) {
  // body unchanged except `assembly` -> `api`; no assemblyFor() here
  return { factories: [/* same handles */], roots: { host: runtimeHost } };
}

/** The production composition root. A function of Assembly, so `smoke` can pass its own api. Not async: a
 * synchronous binding failure still surfaces in the "bind" phase. */
export function composeRuntimeSetup(api: Assembly<RuntimeSetupCapabilities>, composition: SuccessfulComposition,
  factories: RuntimeSetupFactories, captureHost: (host: AgentRuntimeHost) => void,
  completeRoot?: RuntimeSetupRootCompletion, ordinary?: OrdinaryRuntimeAssemblyInput) {
  const bound = bindRuntimeSetup(api, factories, captureHost, completeRoot, ordinary);
  return api.prepare({ composition, factories: bound.factories, roots: bound.roots });
}
```

`packages/apps/embedded-runtime/src/composition/default-agent-runtime-host.ts:53-56` (import `assemblyFor` from
`@get-modular/assembly`, and `composeRuntimeSetup` and `type RuntimeSetupCapabilities` from
`./runtime-setup-assembly.js`; `runtime-setup-assembly.ts` no longer mentions `assemblyFor` at all):

```ts
    phase = "bind";
    const pending = composeRuntimeSetup(assemblyFor<RuntimeSetupCapabilities>(), composition,
      factoriesForAttempt(platform), (host) => { ownedHost = host; }, checkpoints.completeRoot, ordinary);
    phase = "prepare";
    const preparation = await pending;
```

The feature's `bindOrdinaryRuntime` keeps receiving the root's api in this commit. Tests: replace
`bindings.assembly` with a local `const api = assemblyFor<RuntimeSetupCapabilities>()` passed as the first argument
(`tests/package/runtime-setup-assembly.test.ts:239-258, 680-698`, `tests/package/ordinary-runtime-assembly.test.ts:62-68, 89-106`,
`tests/package/runtime-setup-assembly.types.ts:19`). The `verifyOrdinaryHostOwnership` source shape is unchanged.
Gates (exit 0): `pnpm lint`, `pnpm typecheck`, `pnpm --filter "@agent-teams/embedded-runtime..." run build`,
`pnpm --filter @agent-teams/embedded-runtime test`, `pnpm test:get-modular-adoption`, `pnpm architecture:get-modular-adoption`.

### B3 `refactor(embedded-runtime): own module identities and contract descriptors`

Atomic: declarations, gate, census and tests change together, or the graph gate is red between commits.

1. Ordinary feature `.../features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts` (existing file; no
   new production files):
   - 10 exported descriptors, one per capability: `OrdinaryStore`, `OrdinarySecurity`, `OrdinaryRegisterSecrets`,
     `OrdinaryProviderAccess`, `OrdinaryWorkspace`, `OrdinaryArtifacts`, `OrdinaryProcess`, `OrdinaryPrepareLaunch`
     (value `OrdinaryLaunchRecipe`), `OrdinaryProvider`, `OrdinaryTurn`; each `defineContract<V>()({ id: "agent-runtime/ordinary/<name>", revision: 1 })`
     with the value types used today (`OrdinaryTurnDependencies[...]`, `RegisterSecrets`, the turn feature type).
   - `export interface OrdinaryRuntimeCapabilities extends CapabilitiesOf<typeof OrdinaryStore | ... | typeof OrdinaryTurn> {}`.
   - 8 exported declarations with `declareModule`, literal `moduleId` and `implementationId` per the table, `owner`
     with literal `authority: "agent-runtime"` (a shared `const` object literal is fine), `provides: [X.provide()]`,
     `slots: [X.slot("<slot>", required())]`; `ordinaryRuntimeDeclarations` tuple of the 8.
   - `ordinaryRuntimeBindings`: 9 literal rows (turn x 7, process `prepare-launch` -> provider, provider-access
     `register-secrets` -> security), literal implementation IDs. The Host row moves to the root.
   - `OrdinaryRuntimeFactories` unchanged. New `export function createOrdinaryModuleFactories(factories: OrdinaryRuntimeFactories)`
     returns a frozen record of 8 unbound factories, each typed
     `ModuleFactory<CapabilitiesOf<descriptors this module provides or consumes>, typeof <declaration>, <Instance>>`
     (default `FactoryContext`), with the bodies of today's `bindOrdinaryRuntime` closures.
   - Delete `bindOrdinaryRuntime`, `ordinaryTurnHostSlot`, the `defineModule` import, the hand-written `compatibility`
     and `Contract<T>` alias, and the import of `RuntimeSetupCapabilities` (line 4).
   - Source formatting, so the gate mutants of step 6 find their text verbatim (compact style of today's file):
     descriptors as `defineContract<...>()({id: "agent-runtime/ordinary/store", revision: 1})`; declarations with
     `moduleId: "agent-runtime/ordinary/store", implementationId: "agent-runtime/ordinary/store/postgres"`; slots as
     `OrdinaryStore.slot("operation-store", required())`; the process declaration with `provides: [OrdinaryProcess.provide()]`
     and `slots: [OrdinaryPrepareLaunch.slot("prepare-launch", required())]`; binding rows on one line as
     `{consumerImplementationId: "agent-runtime/ordinary/process/node", slotId: "prepare-launch", providerImplementationIds: ["agent-runtime/ordinary/provider/codex"]}`.
2. `internal.ts` of the feature and the facade `src/composition/ordinary-runtime-assembly.ts`: export the new names
   instead of the removed ones.
3. Root `runtime-setup-assembly.ts`:
   - 8 passive descriptors (`agent-runtime/<capability>`, revision 1) with the value types of today's map (lines 35-44);
     `interface SetupCapabilities extends CapabilitiesOf<...8...> {}`;
     `export interface RuntimeSetupCapabilities extends SetupCapabilities, OrdinaryRuntimeCapabilities {}`.
   - Passive declarations with `declareModule` per the table. The two Host variants come from one spec because
     `declareModule` refuses an object that already has `kind`:

     ```ts
     const hostSpec = { moduleId: "agent-runtime/runtime-host", owner: owner("embedded-runtime"), provides: [],
       slots: [CodexAuthorization.slot("authorize-setup-inspection", required()) /* , ... the 8 slots */] } as const;
     const runtimeHostDeclaration = declareModule({ ...hostSpec, implementationId: "agent-runtime/runtime-host/passive" });
     const ordinaryHostDeclaration = declareModule({ ...hostSpec, implementationId: "agent-runtime/runtime-host/ordinary",
       slots: [...hostSpec.slots, OrdinaryTurn.slot("ordinary-turn", required())] });
     ```
   - `runtimeOrdinarySetupProfile.bindings` = the 8 passive rows with consumer `ordinaryHostDeclaration.implementationId`,
     the 9 feature rows, and `{ consumerImplementationId: ordinaryHostDeclaration.implementationId, slotId: "ordinary-turn",
     providerImplementationIds: ["agent-runtime/ordinary/turn/default"] }` (literal provider). Passive profile rows use
     `runtimeHostDeclaration.implementationId`.
   - `bindRuntimeSetup`: when `ordinary` is set, `const modules = createOrdinaryModuleFactories(ordinary.factories)` and
     `api.bindFactory(ordinaryStoreDeclaration, modules.store)` and so on for the 8. The `buildHost` body and the call
     `factories.host({...}, dependencies["ordinary-turn"])` keep their exact shape (the ownership gate reads it).
   - Replace the hand-written `HostInputs` record (`runtime-setup-assembly.ts:198-208`) with a type derived from the
     ordinary Host declaration, so the root factory's dependency record cannot drift from its slots:

     ```ts
     type OrdinaryHostInputs = FactoryDependencies<RuntimeSetupCapabilities, typeof ordinaryHostDeclaration>;
     type HostInputs = Omit<OrdinaryHostInputs, "ordinary-turn"> & { readonly "ordinary-turn"?: OrdinaryHostInputs["ordinary-turn"] };
     ```

     `buildHost` keeps the parameter type `HostInputs`; the passive declaration's dependency record (no
     `ordinary-turn`) stays assignable. `OrdinaryRuntimeFactories` stays a hand-written interface: it is the port
     through which the Host supplies effectful constructors to the feature, not a capability map.
   - `default-agent-runtime-host.ts:102`: look up `moduleId` in `selectedComposition(ordinary).declarations`, not in the
     ordinary list only; otherwise a failing passive Host loses `moduleId` after the duplicate fix.
4. `src/composition/agent-runtime-host-creation-error.ts:68-83`: `RuntimeSetupModuleId` with the 8 new ordinary module
   IDs (the compile-time assertion `_RuntimeSetupModuleIdsRemainExact` catches drift).
5. Gate `scripts/architecture/ordinary-composition-evidence.mjs`, rewritten, same exported names:
   - `verifyOrdinaryGraph(source)`: collect descriptors (declarators whose init is a call of a call to `defineContract`)
     with literal `id` and `revision`; require exactly the 10 IDs above, each `revision` literal `1`. Collect
     `declareModule` calls: exactly 8; literal `moduleId` and `implementationId` equal the table; `owner.authority`
     resolves to the literal `"agent-runtime"`; `provides` are `X.provide()` and `slots` are `X.slot("<slot>", required())`
     with `X` a collected descriptor; provides and `<slot>:<capabilityId>` sets equal the table; the cardinality callee is
     `required`. `ordinaryRuntimeDeclarations` lists exactly the 8 declarators. `ordinaryRuntimeBindings` literal rows
     equal the 9 expected rows. The file contains no `defineModule` call and no `compatibility` property.
   - `verifyOrdinaryHostOwnership(source)` (root file): the existing two checks, plus exactly one
     `OrdinaryTurn.slot("ordinary-turn", required())` call and exactly one binding object with `slotId: "ordinary-turn"`
     and `providerImplementationIds: ["agent-runtime/ordinary/turn/default"]`.
6. `scripts/architecture/check-ordinary-feature-scope.test.mjs:48-64, 75-86`: replace the graph mutants with these
   exact `[before, after]` pairs (the test asserts `graph.includes(before)` and replaces the first occurrence); each
   must make the gate throw:

   | before (feature file) | after |
   |---|---|
   | `OrdinaryStore.slot("operation-store", required())` | `OrdinaryWorkspace.slot("operation-store", required())` |
   | `OrdinaryPrepareLaunch.slot("prepare-launch", required())` | `OrdinaryPrepareLaunch.slot("prepare-launch", optional())` |
   | `{id: "agent-runtime/ordinary/store", revision: 1}` | `{id: "agent-runtime/ordinary/store", revision: 2}` |
   | `implementationId: "agent-runtime/ordinary/store/postgres"` | `implementationId: "agent-runtime/ordinary/store/hidden"` |
   | `moduleId: "agent-runtime/ordinary/store",` | `moduleId: "agent-runtime/ordinary/hidden",` |
   | `slotId: "prepare-launch", providerImplementationIds: ["agent-runtime/ordinary/provider/codex"]` | `slotId: "prepare-launch", providerImplementationIds: ["agent-runtime/ordinary/workspace/node"]` |
   | `provides: [OrdinaryProcess.provide()]` | `provides: [OrdinaryProvider.provide()]` |
   | `authority: "agent-runtime"` (first occurrence) | `authority: "agent-teams"` |

   plus one appended declaration (`graph + '\nexport const hiddenDeclaration = declareModule({moduleId: "agent-runtime/ordinary/hidden", implementationId: "agent-runtime/ordinary/hidden/default", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [], slots: []});'`).
   Ownership mutants on the root file: keep the three existing pairs (lines 79-81) and add
   `OrdinaryTurn.slot("ordinary-turn", required())` -> `OrdinaryTurn.slot("ordinary-turn", optional())` and
   `providerImplementationIds: ["agent-runtime/ordinary/turn/default"]` -> `providerImplementationIds: ["agent-runtime/ordinary/store/postgres"]`.
7. Census and profiles:
   - `architecture/feature-module-standard/ordinary-scope.json` `compositionDependencies`: remove
     `{from: ".../features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts", to: ".../composition/runtime-setup-assembly.ts", kind: "type"}`
     (otherwise `stale legacy Host seam`).
   - `architecture/get-modular/consumer-profile.json`: in `composition.embedded-runtime` relationships remove the same
     `type-only` edge (lines 2570-2574 at base); fix any other drift that `pnpm architecture:get-modular-adoption` reports
     as `live relationships drift`, only for edges this diff explains. `compositions[1].factorySymbol` ->
     `createOrdinaryModuleFactories`, and the matching assertion in `scripts/architecture/check-get-modular-adoption.test.mjs:368`.
8. Tests that name IDs or tokens: `tests/package/runtime-setup-assembly.test.ts` (lines 328, 397, 399, 466, 528:
   the Host implementation ID becomes `agent-runtime/runtime-host/passive`; lines 119, 140, 327, 402-404, 413, 486
   compare module IDs and stay; line 622: `entry.implementationId !== "agent-runtime/setup-security"` becomes
   `"agent-runtime/setup-security/default"`, otherwise the assertion is always true),
   `tests/package/ordinary-runtime-assembly.test.ts` (14-25, 102, 112: new IDs), `tests/package/ordinary-host-disposal.test.ts:86`
   (`moduleId: 'agent-runtime/ordinary/security'`), `tests/package/runtime-setup-assembly.types.ts` (keep the existing
   rejections; build them from the new declarations). Every touched fake is typed with `satisfies` or
   `FactoryDependencies<C, typeof declaration>`; no new `as never`. Note: package test `.ts` files are only
   type-stripped by `node --test` and not type-checked by any gate today (issue #189 adds that); only
   `runtime-setup-assembly.types.ts` is compiled, by a registered test. Typing is still required, and the reviewer
   checks it by reading.

Gates for B3 (exit 0): `pnpm typecheck`, `pnpm --filter "@agent-teams/embedded-runtime..." run build`,
`pnpm --filter @agent-teams/embedded-runtime test`, `pnpm test:get-modular-adoption`, `pnpm architecture:get-modular-adoption`,
`pnpm test:feature-modules`, `pnpm architecture:feature-modules:active`, `pnpm foundation:check`, `pnpm lint`, `pnpm lint:typed`.

### B4 `test(embedded-runtime): pin implementation identities and the compiled binding plan`

In existing files only (the runner list in `packages/apps/embedded-runtime/scripts/run-package-tests.mjs` stays):

| File | Test | Fails when |
|---|---|---|
| `runtime-setup-assembly.test.ts` | one declaration per implementation ID across `runtimeSetupDeclarations` and `runtimeOrdinarySetupDeclarations`: same ID implies identical JSON | two declarations share an ID (fails on `main`: `agent-runtime/runtime-host`) |
| same | namespace: every `moduleId` starts with `agent-runtime/`, `owner.authority === "agent-runtime"`, `implementationId.startsWith(moduleId + "/")` | a foreign root or an authority drift |
| `ordinary-runtime-assembly.test.ts` | real `compileComposition` of both profiles; `plan.bindings` mapped to `consumer|slot|providers|capabilityId|token` equals an independent literal list (8 passive rows; 18 ordinary rows), every token `<capabilityId>/r1` | a wrong provider, slot, capability or revision at plan level, which the AST gate cannot see |
| `runtime-setup-assembly.types.ts` | `@ts-expect-error`: a slot entry from `defineContract<...>()({ id: "agent-runtime/codex-authorization", revision: 2 })` bound under `assemblyFor<RuntimeSetupCapabilities>()`; `declareModule` with a hand-written `{ capabilityId, compatibility }` entry; `declareModule` with `kind`; a descriptor whose ID is not in the map | the type contract weakens |

Write the literal lists by hand from the table in section 5, never generate them from the profile. If the plan binding
records do not carry `capabilityId` and `compatibility.token` under these names, stop and ask.
Gates: `pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm --filter @agent-teams/embedded-runtime test`, `pnpm typecheck`.

### B5 `docs(architecture): record Agent Runtime module identities`

`docs/architecture/get-modular-adoption.md`: the ordinary section (lines 11-48: per-contract tokens instead of
`agent-runtime/ordinary-v1`, new IDs), the identity table of section 5, the statement that no ID is stored outside
code, tests, gates and docs. In the section "Train 0.3.0 conformance status" of `docs/architecture/get-modular-adoption.md` (added by AR-1a) switch the rows whose
`closedBy` names AR-1b from `pending: AR-1b` to their final state (a row closed by AR-1b and AR-1c becomes
`pending: AR-1c`). Never edit `architecture/get-modular/evidence/smart-ci-cms-pin-review.json`: it is the evidence of
the pin step, and `scripts/ci/cms-pin-review.ts` fixes its claims. Gate: `pnpm docs:protocol:check`.

Final gates: the local full gates of section 2 after the last commit.

## 7. Risks and stop conditions

- A type error that only `as never`, `any`, a double cast or an explicit `prepare<R>()` argument would silence: stop;
  report it as a Get Modular finding with a minimal reproduction.
- Typecheck time of the embedded-runtime project grows by more than 30 percent against `main`: report (CMS warns about
  type aliases over many contracts; interfaces are used here).
- The plan order of construction changes and a test asserted the old order: adjust only if the new order is the one
  `compileComposition` reports, and say so in the commit message.
- Census drift beyond the explained edge: stop and ask.

## 8. Must not

Disable `verifyOrdinaryGraph` or `verifyOrdinaryHostOwnership`; drop the turn owner handoff; derive expected bindings
from the profile; add production files; change package.json scripts or workflows; add resources or conformance.

## 9. Done

Required checks green; independent review clean after re-run; owner merges.

## 10. Review checklist (owner's reviewer)

1. Compare every declaration with the table in section 5 (`grep -n "declareModule" -A3` in both files).
2. `grep -rn "defineModule\|compatibility:" packages/apps/embedded-runtime/src` returns nothing.
3. `grep -n "runtime-setup-assembly" packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts` returns nothing (the feature never imports the Host map).
4. `grep -n "assemblyFor" packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts` returns nothing.
5. Mutations in a scratch clone at the PR head, each committed on a detached HEAD and started again from the PR head,
   each must make the named check fail: change `"agent-runtime/runtime-host/ordinary"`
   to `"agent-runtime/runtime-host/passive"` (B4 identity test); set every `OrdinaryStore` revision to 2 consistently
   (gate and plan oracle; typecheck alone passes, which is why both exist); bind `modules.workspace` to the process
   declaration (typecheck); remove `dependencies["ordinary-turn"]` from the `factories.host` call (ownership gate).
6. `pnpm test:get-modular-adoption` runs `check-ordinary-feature-scope.test.mjs` through its import: confirm the new
   mutants execute (`node --test scripts/architecture/check-get-modular-adoption.test.mjs 2>&1 | grep -n "ordinary eight owner declarations"`
   shows an `ok` line).
7. `git diff origin/main -- '*.ts' | grep -c '^+.*as never'` is 0.
8. `grep -n 'implementationId !== "agent-runtime/' packages/apps/embedded-runtime/tests/package/*.ts` shows only new
   implementation IDs (a stale ID makes an assertion vacuous).
9. In the section "Train 0.3.0 conformance status" of `docs/architecture/get-modular-adoption.md`, every row whose state cell is exactly `met` names only #201, AR-1a or AR-1b in `closedBy`; the row "Scoped
   acceptance and evidence" says `met for Core and Assembly 0.3.0` until AR-1c;
   `git diff origin/main --stat -- architecture/get-modular/evidence` is empty.
