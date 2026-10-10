---
id: runtime.architecture.test-debt-189-01-derived-composition-types
type: architecture
status: active
owner: architecture
summary: "Brief 01 for issue 189: derive the value types of the ordinary Host factories from the descriptors."
---

# Test Debt 189 01 Derived Composition Types

**Brief 01: derive the value types of the ordinary Host factories**

Issue: agent-teams-ai/agent-runtime#189, item 3 ("`OrdinaryRuntimeFactories` and `HostInputs` repeat slots and types
that can be derived from the declarations. If the migration has not removed them yet, replace them with derived types").
Branch: `refactor/derived-composition-types`. PR title: `refactor(embedded-runtime): type ordinary Host factories from the contract descriptors`.
Starts after AR-2 is merged. Measured on agent-runtime `5ac0d003` and on the AR-1 briefs (AR-1b B2/B3, AR-1c C4).

## 1. What AR-1 already does and what is left

- AR-1b makes the root a function of Assembly (`composeRuntimeSetup(api, composition, ...)`), replaces the
  hand-written compatibility tokens with contract descriptors (`defineContract`, for example `OrdinaryStore`,
  `OrdinarySecurity`, `OrdinaryRegisterSecrets`, ...), declares modules with `declareModule`, and adds
  `createOrdinaryModuleFactories(factories)`, whose 8 module factories are typed `ModuleFactory<...>` from the
  descriptors. A removed or renamed slot therefore already fails to compile inside those module factories.
- AR-1b (commit B3) also replaces the hand-written `HostInputs` literal (on `5ac0d003`:
  `packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts:198-208`) with a type derived from the
  ordinary Host declaration: `type OrdinaryHostInputs = FactoryDependencies<RuntimeSetupCapabilities, typeof ordinaryHostDeclaration>;`
  `type HostInputs = Omit<OrdinaryHostInputs, "ordinary-turn"> & { readonly "ordinary-turn"?: OrdinaryHostInputs["ordinary-turn"] }`.
  Nothing is left to do for `HostInputs` in #189; this brief only verifies it.
- AR-1c keeps `OrdinaryRuntimeFactories` (feature `features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts`)
  on purpose as a hand-written interface: it is the port through which the Host supplies effectful constructors, and
  several members do not return one descriptor value (`security` returns `{port, registerSecrets}`, `provider` returns
  `{provider, prepareLaunch}`; `security`, `providerAccess` and `provider` take `resources: Resources`). Its shape stays.
  Only its value types are still written by hand (`OrdinaryTurnDependencies["security"]`, `RegisterSecrets`,
  `OrdinaryLaunchRecipe`, ...); if a descriptor's value type changes, they do not follow.

This PR keeps the interface's shape and replaces only those value types with types read from the descriptors. No
runtime behaviour changes. (Agreed with the planner of the AR-1 briefs on 2026-10-04.)

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -1 origin/main
cat .node-version; node --version; pnpm --version
grep -n "@get-modular" pnpm-workspace.yaml                                    # core/assembly 0.3.x, resources 0.1.x, conformance 0.1.x
git grep -n "export function composeRuntimeSetup" -- packages/apps/embedded-runtime/src
git grep -n -A12 "type HostInputs" -- packages/apps/embedded-runtime/src
git grep -n -A14 "interface OrdinaryRuntimeFactories" -- packages/apps/embedded-runtime/src
git grep -n -E "defineContract<" -- packages/apps/embedded-runtime/src | head -20
git grep -n "createOrdinaryModuleFactories" -- packages/apps/embedded-runtime/src
gh pr list -R agent-teams-ai/agent-runtime --state open --json number,title,files \
  --jq '.[] | select(any(.files[]; .path | test("runtime-setup-assembly|ordinary-runtime-assembly|ordinary-agent-runtime-host"))) | "\(.number) \(.title)"'
```

Consumer Module Standard pin (workspace rule before any composition change):

```sh
node -p 'const p=require("./architecture/get-modular/consumer-profile.json"); p.standard.commit + " " + p.standard.sha256'
git clone --filter=blob:none --no-checkout https://github.com/agent-teams-ai/get-modular "$TMPDIR/gm-cms"
git -C "$TMPDIR/gm-cms" show origin/HEAD:docs/architecture/common-assembly.md | shasum -a 256; rm -rf "$TMPDIR/gm-cms"
```

Stop if: AR-1b or AR-1c is not merged (no `composeRuntimeSetup`, no descriptors, no `createOrdinaryModuleFactories`);
the CMS SHA-256 values differ (the pin must be migrated first, in its own reviewed step); an open PR edits the same files.
Check that `HostInputs` is derived (`FactoryDependencies<...>` of the ordinary Host declaration, no hand-written slot
list); if it is still a literal, stop and report (AR-1b B3 was changed or not merged). If `OrdinaryRuntimeFactories`
no longer names any value type by hand, close item 3 of #189 instead of opening a PR.

## 3. Scope and non-goals

In scope: the value types in `OrdinaryRuntimeFactories`; one structural test that keeps them derived (section 5).

Not in scope: `HostInputs` (done by AR-1b); the shape of `OrdinaryRuntimeFactories` (method names, parameters, return
records, the `resources` argument, the `createOrdinaryModuleFactories` wrapper); construction or cleanup order; ids, revisions, profiles, bindings; the AST
gates; tests other than the structural test; contained-turn code.

## 4. Decisions that apply (facts)

- CMS "Testing modules" rule 1 and the module rules: types come from the module's own contract descriptors; a module
  never imports the Host's map.
- Production code never imports `@get-modular/conformance` (ADR-0033); derive value types from the descriptor type (`Contract` from
  `@get-modular/assembly`), not with `ContractValue` from conformance.
- The root `package.json`, CI files and the AR2-pinned `test` scripts are frozen (`scripts/ci/conformance.ts:171-179`,
  `scripts/architecture/ar2-test-execution-inventory.mjs:16-25`).

## 5. Commits

### One commit `refactor(embedded-runtime): type ordinary Host factories from the contract descriptors`

In the feature `ordinary-runtime-assembly.ts`, add one helper and use it for every value type in
`OrdinaryRuntimeFactories`:

```ts
import type { Contract } from "@get-modular/assembly";
/** The value a contract carries, read from its descriptor so the Host factories follow a changed contract. */
type ValueOf<T extends Contract<string, unknown, number>> = T extends Contract<string, infer V, number> ? V : never;

export interface OrdinaryRuntimeFactories {
  operationStore(): Promise<ValueOf<typeof OrdinaryStore>>;
  security(resources: Resources): Promise<{ readonly port: ValueOf<typeof OrdinarySecurity>; readonly registerSecrets: ValueOf<typeof OrdinaryRegisterSecrets> }>;
  providerAccess(registerSecrets: ValueOf<typeof OrdinaryRegisterSecrets>, resources: Resources): Promise<ValueOf<typeof OrdinaryProviderAccess>>;
  workspace(): Promise<ValueOf<typeof OrdinaryWorkspace>>;
  artifacts(): Promise<ValueOf<typeof OrdinaryArtifacts>>;
  process(prepareLaunch: ValueOf<typeof OrdinaryPrepareLaunch>): Promise<ValueOf<typeof OrdinaryProcess>>;
  provider(resources: Resources): Promise<{ readonly provider: ValueOf<typeof OrdinaryProvider>; readonly prepareLaunch: ValueOf<typeof OrdinaryPrepareLaunch> }>;
}
```

The value is read from the descriptor with `infer` because indexing `CapabilitiesOf<T>[T["id"]]["value"]` with a generic `T` stops compiling once `CapabilitiesOf` remaps its keys (TS2536). The `Contract` type is exported by `@get-modular/assembly` in 0.3.x.

Keep the method set, parameter order and `resources` arguments exactly as AR-1c left them; only the type expressions
change. Delete type aliases that become unused (for example a local `RegisterSecrets`, if nothing else uses it).

One new test, structural on purpose. A compile-time assertion would be tautological: the derived and the hand-written
types are identical, so it passes before and after the change. What must not come back is a hand-written value type,
so the test reads the source. In `packages/apps/embedded-runtime/tests/package/ordinary-runtime-assembly.test.ts` add:

```ts
test("ordinary Host factory types are read from the contract descriptors", async () => {
  // Hand-written value types drift from the contracts; only descriptor-derived types are allowed here.
  const path = new URL("../../src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts", import.meta.url);
  const { program, errors } = parseSync(path.pathname, await readFile(path, "utf8"));
  assert.equal(errors.length, 0);
  const declaration = program.body.map(node => node.type === "ExportNamedDeclaration" ? node.declaration : node)
    .find(node => node?.type === "TSInterfaceDeclaration" && node.id.name === "OrdinaryRuntimeFactories");
  assert.ok(declaration?.type === "TSInterfaceDeclaration", "OrdinaryRuntimeFactories interface");
  const references: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") { return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (record["type"] === "TSTypeReference") { references.push(String((record["typeName"] as { name?: unknown }).name)); }
    for (const [key, value] of Object.entries(record)) { if (key !== "parent") { visit(value); } }
  };
  visit(declaration.body);
  assert.deepEqual([...new Set(references)].toSorted(), ["Promise", "Resources", "ValueOf"]);
});
```

`parseSync` comes from `oxc-parser`: add `"oxc-parser": "catalog:"` to `packages/apps/embedded-runtime/package.json`
`devDependencies` (agent-execution declares it the same way for its tests; `test.embedded-runtime` in
`architecture/foundation/source-dependencies.yaml` already allows it), then `pnpm install` and
`pnpm install --frozen-lockfile`. `readFile` comes from `node:fs/promises`. Write the test first and check that it fails on the base (it reports at least `OrdinaryTurnDependencies`
and `RegisterSecrets`, plus whichever of `OrdinaryLaunchRecipe`, `NodeOrdinaryProcessOptions` and `OrdinaryProcessPort`
the merged interface still names), then make the type change; record both runs in the PR body. If the merged
interface needs another type name (for example a renamed `Resources`), stop and ask; do not widen the allowed set.

Gates: `pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm --filter @agent-teams/embedded-runtime typecheck`,
`pnpm --filter @agent-teams/embedded-runtime test`, `pnpm architecture:get-modular-adoption`,
`pnpm test:get-modular-adoption`, `pnpm architecture:feature-modules:active`, `pnpm foundation:check`.

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

## 7. Risks and stop conditions

- `ValueOf` does not resolve to the same type as before for some contract (the build or a test starts failing): stop
  and report the contract; do not cast.
- Keeping `verifyOrdinaryHostOwnership` or `verifyOrdinaryGraph` green would need a gate change: stop.
- Any existing assertion would have to change: stop.
- A type error that only `as never`, `any` or a double cast would silence: stop; it is a Get Modular finding.

## 8. Must not

- Change runtime behaviour, method shapes, the module factory wrapper, the AST gates, the root `package.json`, CI files,
  or any `package.json` except the one `oxc-parser` development dependency of embedded-runtime.
- Import `@get-modular/conformance` from production code; add a public export.
- Use destructive git commands or a non-local git identity; mention AI tools anywhere.

## 9. Done when

- `git grep -n -P 'OrdinaryTurnDependencies\["|(?<!Ordinary)RegisterSecrets\b|OrdinaryLaunchRecipe|NodeOrdinaryProcessOptions|OrdinaryProcessPort' -- packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts`
  shows no use inside `OrdinaryRuntimeFactories` (descriptor definitions may still name them as `defineContract<V>` arguments).
- The structural test fails on the base and passes after the change (both runs in the PR body); all gates green.

## 10. Review checklist

1. Re-run section 2 on the PR base; confirm which commits were needed.
2. Mutation: change the value type of `OrdinaryRegisterSecrets` in its `defineContract<...>` to `(operationId: string) => boolean`;
   `pnpm --filter @agent-teams/embedded-runtime typecheck` must fail where the Host supplies `registerSecrets`
   (`ordinary-agent-runtime-host.ts`). Revert.
3. Mutation: change the value type of `OrdinaryStore` in its `defineContract<...>`; the Host's `operationStore` factory
   in `ordinary-agent-runtime-host.ts` must fail to compile. Revert.
3a. Mutation: put back one hand-written type (`workspace(): Promise<OrdinaryTurnDependencies["workspace"]>`); the
   structural test must fail naming `OrdinaryTurnDependencies`. Revert.
4. `git diff origin/main` touches only the feature `ordinary-runtime-assembly.ts`,
   `tests/package/ordinary-runtime-assembly.test.ts`, the embedded-runtime `package.json` (`oxc-parser` only) and the lock; the method names, parameters and return records of
   `OrdinaryRuntimeFactories` are unchanged.
5. Commits carry the repository's local identity; no AI tool or assistant is mentioned anywhere.
