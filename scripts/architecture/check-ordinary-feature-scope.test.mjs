import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {validateOrdinaryScope, inboundImportIssues} from './check-ordinary-feature-scope.mjs';
import {scopedFeaturePrimitives as fms} from './check-feature-modules.mjs';
import {verifyOrdinaryGraph, verifyOrdinaryHostOwnership, ordinaryCompositionPath} from './ordinary-composition-evidence.mjs';

const root = new URL('../../', import.meta.url);
export const profile = JSON.parse(await readFile(new URL('architecture/feature-module-standard/ordinary-scope.json', root)));
const decisions = JSON.parse(await readFile(new URL('architecture/decisions/accepted-decisions.json', root))).decisions;
const paths = [...new Set([...profile.files, ...profile.compositionDependencies.map(edge => edge.to)])];
const graph = await readFile(new URL(ordinaryCompositionPath, root), 'utf8');

test('ordinary scoped profile retains accepted owner and exact source census', () => {
  assert.deepEqual(validateOrdinaryScope(profile, paths, decisions), []);
  for (const mutate of [p => {p.status = 'pending';}, p => {p.authority = 'ADR-0015';},
    p => {p.files.pop();}, p => {p.files.push('packages/unknown.ts');}, p => {p.exceptions = ['*'];},
    p => {p.feature.roles = ['contracts'];}, p => {p.compositionDependencies[0].from = p.feature.root + '/application/hidden.ts';}]) {
    const candidate = structuredClone(profile); mutate(candidate);
    assert.ok(validateOrdinaryScope(candidate, paths, decisions).length > 0);
  }
  assert.ok(validateOrdinaryScope(profile, [...paths, profile.feature.root + '/adapters/new-capability.ts'], decisions).length > 0);
  assert.ok(validateOrdinaryScope(profile, [...paths, 'packages/contexts/runtime-security/src/ordinary-hidden.ts'], decisions).length > 0);
  assert.ok(validateOrdinaryScope(profile, paths, decisions.filter(d => d.id !== 'ADR-0090')).length > 0);
});

function imports(role, specifier, target, seams = []) {
  const feature = {id: 'fixture', root: 'packages/apps/embedded-runtime/src/features/fixture', entrypoints: {}};
  const path = `${feature.root}/${role}/source.ts`;
  return fms.inspectImport({features: [feature], sourceFeature: feature, path, isAssembly: false,
    imported: {specifier, kind: 'runtime', line: 1}, localPackageImports: {resolve: () => target ? {kind: 'local', path: target} : {kind: 'external'}},
    productionRoots: ['packages/apps/embedded-runtime/src'], identityPaths: [], declaredModules: new Map(), declaredEdges: new Map(),
    declaredModuleEdges: new Map(), observedModuleEdges: new Map(), moduleEdgeLocations: new Map(),
    compositionDependencies: seams, observedCompositionDependencies: new Set()});
}
test('scoped checks reuse rejecting Node/SDK/layer and exact legacy seam rules', () => {
  assert.ok(imports('application', 'node:fs').some(i => i.code === 'FM_NODE_BUILTIN_IMPORT'));
  assert.ok(imports('domain', '@get-modular/core').some(i => i.code === 'FM_EXTERNAL_IMPORT'));
  const oldTarget = 'packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts';
  const from = 'packages/apps/embedded-runtime/src/features/fixture/composition/source.ts';
  assert.deepEqual(imports('composition', '../../../composition/runtime-setup-assembly.js', oldTarget, [{from, to: oldTarget, kind: 'runtime'}]), []);
  assert.ok(imports('composition', './new.js', oldTarget).some(i => i.code === 'FM_UNDECLARED_LOCAL_DEPENDENCY'));
  const applicationSource = from.replace('/composition/source.ts', '/application/source.ts');
  assert.ok(imports('application', './new.js', oldTarget, [{from: applicationSource, to: oldTarget, kind: 'runtime'}]).length > 0);
  assert.ok(imports('application', '../adapters/source.js', 'packages/apps/embedded-runtime/src/features/fixture/adapters/source.ts').some(i => i.code === 'FM_INVALID_LAYER_DIRECTION'));
});

test('ordinary eight owner declarations and exact seven required turn slots reject graph drift', () => {
  assert.doesNotThrow(() => verifyOrdinaryGraph(graph));
  for (const [before, after] of [
    ['OrdinaryStore.slot("operation-store", required())', 'OrdinaryWorkspace.slot("operation-store", required())'],
    ['OrdinaryPrepareLaunch.slot("prepare-launch", required())', 'OrdinaryPrepareLaunch.slot("prepare-launch", optional())'],
    ['{id: "agent-runtime/ordinary/store", revision: 1}', '{id: "agent-runtime/ordinary/store", revision: 2}'],
    ['implementationId: "agent-runtime/ordinary/store/postgres"', 'implementationId: "agent-runtime/ordinary/store/hidden"'],
    ['moduleId: "agent-runtime/ordinary/store",', 'moduleId: "agent-runtime/ordinary/hidden",'],
    ['slotId: "prepare-launch", providerImplementationIds: ["agent-runtime/ordinary/provider/codex"]', 'slotId: "prepare-launch", providerImplementationIds: ["agent-runtime/ordinary/workspace/node"]'],
    ['provides: [OrdinaryProcess.provide()]', 'provides: [OrdinaryProvider.provide()]'],
    ['authority: "agent-runtime"', 'authority: "agent-teams"'],
  ]) {
    assert.ok(graph.includes(before), `stale mutant ${before}`);
    assert.throws(() => verifyOrdinaryGraph(graph.replace(before, after)));
  }
  assert.throws(() => verifyOrdinaryGraph(`${graph}\nexport const hiddenNested = [declareModule({moduleId: "agent-runtime/ordinary/hidden", implementationId: "agent-runtime/ordinary/hidden/default", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [], slots: []})];`), /outside the exported census/);
  assert.throws(() => verifyOrdinaryGraph(`${graph}\nexport const hiddenDeclaration = declareModule({moduleId: "agent-runtime/ordinary/hidden", implementationId: "agent-runtime/ordinary/hidden/default", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [], slots: []});`));
});


test('ordinary inbound adapter rejects Node and SDK imports', () => {
  for (const specifier of ['node:fs', '@openai/codex-sdk']) {
    assert.equal(inboundImportIssues('feature/adapters/inbound/entry.ts', {specifier, line: 1})[0].code, 'FM_INBOUND_EXTERNAL_IMPORT');
  }
  assert.deepEqual(inboundImportIssues('feature/adapters/outbound/entry.ts', {specifier: 'node:fs', line: 1}), []);
});


test('ordinary Host ownership handoff rejects a dropped or substituted closed root', async () => {
  const source = await readFile(new URL('packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts', root), 'utf8');
  assert.doesNotThrow(() => verifyOrdinaryHostOwnership(source));
  for (const [before, after] of [
    ['}, dependencies["ordinary-turn"]);', '});'],
    ['}, dependencies["ordinary-turn"]);', '}, dependencies["ordinary-process"]);'],
    ['createAgentRuntimeHost(dependencies, ordinaryOwner)', 'createAgentRuntimeHost(dependencies)'],
    ['OrdinaryTurn.slot("ordinary-turn", required())', 'OrdinaryTurn.slot("ordinary-turn", optional())'],
    ['providerImplementationIds: ["agent-runtime/ordinary/turn/default"]', 'providerImplementationIds: ["agent-runtime/ordinary/store/postgres"]'],
  ]) {
    assert.ok(source.includes(before), 'stale ordinary ownership mutant');
    assert.throws(() => verifyOrdinaryHostOwnership(source.replace(before, after)));
  }
});
