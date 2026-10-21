import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
const analysisUrl = new URL("./feature-module-analysis.mjs", import.meta.url);
// The existing JavaScript checker is consumed through this exact development-only test port.
const {scopedFeaturePrimitives} = await import(analysisUrl.href) as {scopedFeaturePrimitives: {
  sameFeatureImportIssues(input: {path: string; targetPath: string; imported: {kind: string; syntax: string; line: number}; sourceFeature: {id: string; root: string; entrypoints: {public: string; internal: string}}}): readonly {code: string}[];
}};

const root = "packages/contexts/agent-execution/src/features/interactive-agent-session";
const bridge = `${root}/contracts/interactive-provider-driver.ts`;
const owner = `${root}/application/ports/outbound/interactive-provider-driver.ts`;
const feature = {id: "interactive-agent-session", root, entrypoints: {public: `${root}/index.ts`, internal: `${root}/internal.ts`}};
const inspect = (path: string, targetPath: string, kind = "type", syntax = "re-export") => scopedFeaturePrimitives.sameFeatureImportIssues({
  path, targetPath, imported: {kind, syntax, line: 1}, sourceFeature: feature,
});

export const interactiveSpiBridgeTest = test("ADR-0091 admits exactly one erased consumer-owned SPI bridge and rejects runtime/other layer edges", () => {
  assert.deepEqual(inspect(bridge, owner), []);
  const mutants: readonly [string, string, string?, string?][] = [
    [bridge, owner, "runtime", "re-export"], [bridge, owner, "type", "import"],
    [`${root}/contracts/other.ts`, owner], [bridge, `${root}/application/use-cases/interactive-session-owner.ts`],
    [`${root}/domain/session.ts`, bridge], [`${root}/application/use-cases/interactive-session-owner.ts`, bridge],
  ];
  for (const args of mutants) {assert.deepEqual(inspect(...args).map(issue => issue.code), ["FM_INVALID_LAYER_DIRECTION"]);}
});

export const interactiveSpiInterpretationTest = test("scoped SPI interpretation is explicit and the real outward bridge contains only named type re-exports", async () => {
  const note = JSON.parse(await readFile(new URL("../../architecture/interactive-agent-session/implementation.json", import.meta.url), "utf8"));
  assert.equal(note.authority, "ADR-0091"); assert.equal(note.spi.owner, owner); assert.equal(note.spi.bridge, bridge);
  assert.equal(note.spi.kind, "named-type-re-export-only"); assert.match(note.admittedLocalFmsExtension, /not unmodified FMS v1 conformance/u);
  const source = await readFile(new URL(`../../${bridge}`, import.meta.url), "utf8");
  assert.match(source, /^export type \{[A-Za-z, ]+\} from "\.\.\/application\/ports\/outbound\/interactive-provider-driver\.js";\n$/u);
});

const {curatedModuleImportIssues} = await import(new URL('./feature-module-edges.mjs', import.meta.url).href) as {
  curatedModuleImportIssues: (context: Record<string, unknown>) => readonly {code: string}[];
};

export const providerContractBoundaryTest = test('ADR-0093 admits only the canonical erased SPI forwards and rejects values, deep imports and undeclared edges', async () => {
  const profile = JSON.parse(await readFile(new URL('../../architecture/feature-module-standard/candidate-profile.json', import.meta.url), 'utf8'));
  const modules = new Map(profile.scope.productionModules.map((module: {sourceRoot: string}) => [module.sourceRoot, module]));
  const targetPath = 'packages/platform/provider-session-contracts/src/index.ts';
  const inspectContract = (path: string, kind = 'type', syntax = 're-export', target = targetPath, edges = true) => curatedModuleImportIssues({
    declaredModules: modules, path, targetPath: target, imported: {kind, syntax, line: 1}, isAssembly: path.endsWith('/src/interactive-contracts.ts'),
    sourceFeature: path === owner ? feature : undefined, layerForPath: () => 'application',
    declaredModuleEdges: new Map(edges ? [['agent-execution->provider-session-contracts', new Set(['type'])]] : []),
    observedModuleEdges: new Map(), moduleEdgeLocations: new Map(), issue: (code: string) => ({code}),
  }).map(issue => issue.code);
  for (const path of [owner, 'packages/contexts/agent-execution/src/interactive-contracts.ts']) {
    assert.deepEqual(inspectContract(path), []);
    assert.ok(inspectContract(path, 'runtime').includes('FM_INVALID_LAYER_DIRECTION'));
    assert.ok(inspectContract(path, 'type', 'import').includes('FM_INVALID_LAYER_DIRECTION'));
    assert.ok(inspectContract(path, 'type', 're-export', targetPath, false).includes('FM_UNDECLARED_MODULE_EDGE'));
    assert.ok(inspectContract(path, 'type', 're-export', 'packages/platform/provider-session-contracts/src/features/provider-session-contracts/contracts/session.ts').includes('FM_MODULE_DEEP_IMPORT'));
  }
  assert.ok(inspectContract(`${root}/domain/session.ts`).includes('FM_INVALID_LAYER_DIRECTION'));
  assert.ok(inspectContract(`${root}/application/use-cases/interactive-session-owner.ts`).includes('FM_INVALID_LAYER_DIRECTION'));
});
