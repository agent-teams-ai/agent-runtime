import assert from 'node:assert/strict';
import {glob, readFile} from 'node:fs/promises';
import test from 'node:test';
import {hostEvidencePaths, hostRoot, hostFeature, hostTests, hostAuthority, verifyInteractiveHostComposition} from './interactive-host-composition-evidence.mjs';
const paths = [...new Set([...hostEvidencePaths, ...await Array.fromAsync(glob(hostFeature + '/**/*.ts', {cwd: new URL('../../', import.meta.url)}))])];
const files = new Map(await Promise.all(paths.map(async path => [path, await readFile(new URL('../../' + path, import.meta.url), 'utf8')])));
const mapping = {authority: 'ADR-0091', entrypoint: hostFeature + '/internal.ts', implementation: hostRoot, declarations: hostFeature + '/composition/host.declaration.ts', profile: hostRoot,
  factories: hostFeature + '/composition/host.module.ts', tests: [hostTests]};
const decisions = [{id: 'ADR-0091', path: hostAuthority}];
const verify = (changed = files, value = mapping, accepted = decisions) => verifyInteractiveHostComposition(value, accepted, path => {
  assert.ok(changed.has(path), `missing ${path}`); return changed.get(path);
}, [...changed.keys()]);
test('current interactive Host has one layout-conformant feature/module and the closed independent graph', () => {
  const report = verify(); assert.equal(report.featureCount, 1); assert.equal(report.moduleCount, 1);
});
for (const [name, path, before, after, pattern] of [
  ['unknown group member', hostFeature + '/composition/interactive-session-runtime.group.ts', 'hostModule,', 'unreviewedModule,', /group members/],
  ['optional authority slot', hostFeature + '/composition/host.declaration.ts', 'Authority.slot("authority", required())', 'Authority.slot("authority", optional())', /required slots/],
  ['descriptor revision', hostFeature + '/composition/interactive-session-runtime.contracts.ts', 'revision: 1', 'revision: 2', /descriptor census/],
  ['root omitted input', hostRoot, 'ownership: ownershipInput', 'ownership: contextInput', /root inputs/],
  ['method-shaped port', hostFeature + '/contracts/interactive-session-host.ts', 'readonly dispose: () => Promise<void>', 'dispose(): Promise<void>', /arrow function/],
  ['mandatory runner omitted', 'packages/apps/embedded-runtime/scripts/run-package-tests.mjs', 'tests/features/interactive-session-runtime/host.test.ts', 'tests/other.test.ts', /mandatory runner/],
  ['wiring qualification omitted', hostTests, 'checkWiring(', 'ignoreWiring(', /qualification missing/],
  ['vendor contract registration site', hostTests, 'registerHostContractSuite((name, body) => test(name, body))', 'registerHostContractSuite(test)', /local native test callback/],
  ['no-op contract registration', hostTests, 'registerHostContractSuite((name, body) => test(name, body))', 'registerHostContractSuite((name, body) => undefined)', /local native test callback/],
  ['discarded contract body', hostTests, 'registerHostContractSuite((name, body) => test(name, body))', 'registerHostContractSuite((name, body) => test(name, () => undefined))', /preserve case name and body/],
  ['duplicate contract registration', hostTests, 'registerHostContractSuite((name, body) => test(name, body))', 'registerHostContractSuite((name, body) => test(name, body)); registerHostContractSuite((name, body) => test(name, body))', /one local contract registration/],

]) {
  test('interactive Host rejects ' + name, () => {
    const changed = new Map(files); assert.ok(changed.get(path).includes(before), 'negative fixture must mutate real source');
    changed.set(path, changed.get(path).replace(before, after)); assert.throws(() => verify(changed), pattern);
  });
}
test('interactive Host requires accepted scoped authority', () => assert.throws(() => verify(files, mapping, []), /accepted authority/));
test('interactive Host cannot omit its qualification mapping', () => assert.throws(() => verify(files, {...mapping, tests: []}), /qualification omitted/));

test('interactive Host checks every current feature source, including an unregistered extra module', () => {
  const changed = new Map(files); changed.set(hostFeature + '/composition/rogue.module.ts', 'export {};');
  assert.throws(() => verify(changed), /layout violations|CMS module layout|module count/);
});
