import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {checkModuleDependencyCasts, findDependencyRecordCasts, MODULE_ENTRY_POINTS} from './module-dependency-casts.mjs';

export const entryPoints = MODULE_ENTRY_POINTS;
const scan = source => findDependencyRecordCasts('sample.ts', source).map(({line, kind, entry}) => ({line, kind, entry}));
const kinds = source => scan(source).map(violation => violation.kind);
const isolateImport = 'import {isolate} from "@get-modular/conformance";\n';

test('rejects as never in isolate dependencies', () => {
  assert.deepEqual(scan(`${isolateImport}isolate(api, {declaration, factory, dependencies: {db: fake as never}});`), [{line: 2, kind: 'as never', entry: 'isolate'}]);
});

test('rejects a renamed import and a namespace call', () => {
  assert.deepEqual(kinds('import {isolate as build} from "@get-modular/conformance";\nbuild(api, {dependencies: {db: fake as never}});'), ['as never']);
  assert.deepEqual(kinds('import * as conformance from "@get-modular/conformance";\nconformance.isolate(api, {dependencies: {db: fake as any}});'), ['as any']);
  assert.deepEqual(kinds('import {isolate} from "./local.js";\nisolate(api, {dependencies: {db: fake as never}});'), []);
});

test('rejects one-hop const records', () => {
  assert.deepEqual(kinds(`${isolateImport}const deps = {db: fake} as unknown as Deps;\nisolate(api, {dependencies: deps});`), ['as unknown as']);
  assert.deepEqual(kinds(`${isolateImport}const inner = {db: fake as never};\nconst deps = inner;\nisolate(api, {dependencies: deps});`), []);
});

test('rejects entry-point records', () => {
  assert.deepEqual(kinds('createAgentRuntimeHost(dependencies as never);'), ['as never']);
  assert.deepEqual(kinds('new createOrdinaryTurnFeature({store: store as never});'), ['as never']);
  assert.deepEqual(kinds('host.createAgentRuntimeHost({...base, store: store as any});'), ['as any']);
  assert.deepEqual(kinds('createNodeOrdinaryProcess(<never>options);'), ['<never>']);
  assert.deepEqual(kinds('createNodeOrdinaryProcess(<any>options);'), ['<any>']);
  assert.deepEqual(kinds('createOrdinaryModuleFactories(flag ? first as never : second);'), ['as never']);
});

test('rejects satisfies FactoryDependencies and annotated records', () => {
  assert.deepEqual(kinds('const fake = {db: x as never} satisfies FactoryDependencies<Caps, typeof declaration>;'), ['as never']);
  assert.deepEqual(kinds('const fake: FactoryDependencies<Caps, typeof declaration> = {db: x as unknown as Db};'), ['as unknown as']);
});

test('rejects double casts through any and never', () => {
  assert.deepEqual(kinds('createAgentRuntimeHost(x as any as Deps);'), ['as any as']);
  assert.deepEqual(kinds('createAgentRuntimeHost((x as never) as Deps);'), ['as never as']);
});

test('accepts a reasoned exemption', () => {
  assert.deepEqual(kinds('// hostile-input: malformed on purpose\ncreateAgentRuntimeHost(x as never);'), []);
  assert.deepEqual(kinds('createAgentRuntimeHost(x as never); // hostile-input: malformed on purpose'), []);
  assert.deepEqual(kinds('// hostile-input: malformed on purpose\n\ncreateAgentRuntimeHost(x as never);'), ['as never']);
});

test('rejects an empty exemption', () => {
  assert.deepEqual(kinds('// hostile-input:\ncreateAgentRuntimeHost(x as never);'), ['empty hostile-input', 'as never']);
});

test('ignores other positions', () => {
  assert.deepEqual(scan('foo(x as never);'), []);
  assert.deepEqual(scan('createAgentRuntimeHost({async execute() { return x as never; }, run: () => y as any});'), []);
  assert.deepEqual(scan('createAgentRuntimeHost({template: `${x as never}`, other: call(y as never), member: z.w as never ? 1 : 2}.field);'), []);
  assert.deepEqual(scan('createAgentRuntimeHost(x as const);'), []);
  assert.deepEqual(scan('createAgentRuntimeHost(x as Port);'), []);
  assert.deepEqual(scan('createAgentRuntimeHost(x as unknown as Deps satisfies Other);').map(violation => violation.kind), ['as unknown as']);
});

test('fails closed on parse errors', () => {
  assert.deepEqual(kinds('createAgentRuntimeHost(x as ;'), ['parse error']);
});

test('flags stale entry points', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-dependency-casts-TEST-'));
  try {
    await mkdir(join(root, 'packages', 'apps', 'sample', 'src'), {recursive: true});
    await mkdir(join(root, 'packages', 'apps', 'sample', 'tests'), {recursive: true});
    const exports = MODULE_ENTRY_POINTS.filter(name => name !== 'createNodeOrdinaryProcess');
    await writeFile(join(root, 'packages', 'apps', 'sample', 'src', 'index.ts'), `export {${exports.join(', ')}};\n`);
    await assert.rejects(checkModuleDependencyCasts(root), /stale entry point createNodeOrdinaryProcess/u);
    await writeFile(join(root, 'packages', 'apps', 'sample', 'src', 'index.ts'), `${MODULE_ENTRY_POINTS.map(name => `export function ${name}() {}`).join('\n')}\n`);
    await writeFile(join(root, 'packages', 'apps', 'sample', 'tests', 'bad.test.ts'), 'createAgentRuntimeHost(x as never);\n');
    await assert.rejects(checkModuleDependencyCasts(root), /packages\/apps\/sample\/tests\/bad\.test\.ts:1 as never \(createAgentRuntimeHost\)/u);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('the repository has no type-erasing cast on a module dependency record', async () => {
  await checkModuleDependencyCasts(fileURLToPath(new URL('../../', import.meta.url)));
});
