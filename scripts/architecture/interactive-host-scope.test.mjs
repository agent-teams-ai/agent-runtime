import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {readLocalPackageImports} from './feature-module-config.mjs';
import {createPathIndex, canonicalRoot} from './feature-module-paths.mjs';
import {declaredModuleConsumption} from './feature-module-tests.mjs';
import {curatedModuleImportIssues} from './feature-module-edges.mjs';

const spi = 'packages/contexts/agent-execution/src/interactive-contracts.ts';
const root = await canonicalRoot(fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''));

const profile = JSON.parse(await readFile(new URL('../../architecture/feature-module-standard/candidate-profile.json', import.meta.url)));
const modules = new Map(profile.scope.productionModules.map(module => [module.sourceRoot, module]));

test('the real canonical type-only SPI resolves from declared manifest export without permitting private package aliases', async () => {
  const imported = await readLocalPackageImports({root, productionRoots: ['packages/contexts/agent-execution/src'],
    issue: (code, path, line, message) => ({code, path, line, message}), pathIndex: createPathIndex([spi]), declaredModules: modules});
  const from = 'packages/apps/embedded-runtime/src/features/interactive-session-runtime/adapters/outbound/provider-generation-fence.ts';
  assert.equal(imported.resolve(from, '@agent-teams/agent-execution/interactive-contracts').path, spi);
  assert.equal(imported.resolve(from, '@agent-teams/agent-execution/private-driver').kind, 'invalid');
});

test('the curated SPI remains type-only for an otherwise authorized composition or adapter module edge', () => {
  const sourceRoot = 'packages/apps/embedded-runtime/src';
  const sourceFeature = {id: 'interactive-session-runtime', root: sourceRoot + '/features/interactive-session-runtime', entrypoints: {}};
  const context = {declaredModules: modules, isAssembly: false, sourceFeature, targetPath: spi,
    path: sourceFeature.root + '/adapters/outbound/provider-generation-fence.ts', layerForPath: () => 'adapters',
    declaredModuleEdges: new Map([['embedded-runtime->agent-execution', new Set(['type', 'runtime'])]]),
    observedModuleEdges: new Map(), moduleEdgeLocations: new Map(), issue: code => ({code})};
  assert.deepEqual(curatedModuleImportIssues({...context, imported: {kind: 'type', line: 1}}), []);
  assert.deepEqual(curatedModuleImportIssues({...context, imported: {kind: 'runtime', line: 1}}).map(issue => issue.code), ['FM_INVALID_LAYER_DIRECTION']);
});

test('package tests consume only the explicitly declared erased SPI edge', () => {
  const context = {declaredModules: modules, productionRoot: 'packages/apps/embedded-runtime/src',
    declaredModuleEdges: new Map([['embedded-runtime->agent-execution', new Set(['type'])]])};
  const target = {self: true, path: spi};
  assert.equal(declaredModuleConsumption(context, target, {kind: 'type'}), true);
  assert.equal(declaredModuleConsumption(context, target, {kind: 'runtime'}), false);
  assert.equal(declaredModuleConsumption({...context, declaredModuleEdges: new Map()}, target, {kind: 'type'}), false);
  assert.equal(declaredModuleConsumption({...context, declaredModuleEdges: new Map([['embedded-runtime->agent-execution', new Set(['runtime'])]])}, target, {kind: 'type'}), false);
});
