import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promoteArchitectureDecisionBaseline } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js';
import { checkAdoption, digest, validateProfile, verifyAdoption } from './check-get-modular-adoption.mjs';

const pending = JSON.parse(await readFile(new URL('../../architecture/get-modular/consumer-profile.json', import.meta.url)));
function fixture() {
  const profile = structuredClone(pending);
  const standard = { commit: 'a'.repeat(40), bytes: 'Consumer module standard ADR-0026' };
  const fms = JSON.stringify({ status: 'active', features: profile.fms.features.map(id => ({ id })) });
  const files = new Map([
    [profile.fms.profile, fms], ['decision.md', 'architecture/get-modular/consumer-profile.json'],
    ['packages/test/src/composition.ts', 'synthetic entry'], ['packages/test/src/legacy.ts', 'synthetic legacy'],
    ['mapping.ts', 'synthetic mapping'], ['tests/mapping.test.ts', 'synthetic test'],
    ['scripts/architecture/check-get-modular-adoption.mjs', 'synthetic checker'],
  ]);
  Object.assign(profile, { status: 'active', pending: [], productionRoots: ['packages/test/src'],
    boundaries: [
      { id: 'composition.test', owner: 'Test', roots: ['packages/test/src'], entrypoints: ['packages/test/src/composition.ts'], status: 'adopted', rationale: 'synthetic slice', reviewTrigger: 'boundary change', relationships: [] },
      { id: 'composition.legacy', owner: 'Test', roots: ['packages/test/src/legacy.ts'], entrypoints: ['packages/test/src/legacy.ts'], status: 'not-adopted', rationale: 'retained direct edge', reviewTrigger: 'new edge', relationships: [{ from: 'packages/test/src/legacy.ts', to: 'test-library' }] },
    ],
    compositions: [{ boundary: 'composition.test', entrypoint: 'packages/test/src/composition.ts', declarations: 'mapping.ts', profile: 'mapping.ts', factories: 'mapping.ts', tests: ['tests/mapping.test.ts'] }],
    packages: ['@get-modular/core', '@get-modular/assembly'].map(name => ({ name, version: '0.1.0', archiveSha256: digest('synthetic archive'), archivePath: `evidence/${name.split('/')[1]}.tgz` })),
    enforcement: { roots: ['check:fast', 'check'], commands: { 'architecture:adoption': 'node scripts/architecture/check-get-modular-adoption.mjs' } },
  });
  profile.standard.evidencePath = 'evidence/common-assembly.md'; profile.standard.commit = standard.commit; profile.standard.sha256 = digest(standard.bytes);
  profile.authority.path = 'decision.md'; profile.fms.sha256 = digest(fms);
  const evidence = { standard, files, decisions: [{ id: 'ADR-0015', path: 'decision.md' }],
    artifacts: profile.packages.map(p => ({ ...p, bytes: 'synthetic archive' })),
    scripts: { ...profile.enforcement.commands, check: 'pnpm architecture:adoption', 'check:fast': 'pnpm architecture:adoption' },
    policy: { governedRoots: profile.productionRoots, boundaries: structuredClone(profile.boundaries) },

  };
  return { profile, evidence };
}

test('repository profile honestly stays pending without invented pins', () => {
  assert.equal(validateProfile(pending).status, 'pending');
  assert.throws(() => verifyAdoption(pending, {}), /pending/);
});
test('adopted slice, unchanged FMS and declared legacy metadata pass', () => {
  const { profile, evidence } = fixture();
  assert.equal(verifyAdoption(profile, evidence).status, 'verified-metadata');
});
const mutations = [
  ['active profile cannot classify everything as legacy', p => { p.boundaries.forEach(b => { b.status = 'not-adopted'; }); p.compositions = []; }, /requires a materialized composition/],
  ['active profile requires a composition mapping', p => { p.compositions = []; }, /requires a materialized composition/],
  ['unknown profile key', p => { p.conformant = true; }, /schema/],
  ['wildcard exception', p => { p.exceptions = [{ boundary: 'composition.test', rule: 'wiring', paths: ['packages/**'], authority: 'decision.md', owner: 'Test', rationale: 'test', reviewTrigger: 'test' }]; }, /schema/],
  ['central commit drift', (_p, e) => { e.standard.commit = 'b'.repeat(40); }, /commit drift/],
  ['central bytes drift', (_p, e) => { e.standard.bytes += 'drift'; }, /bytes drift/],
  ['missing accepted ADR', (_p, e) => { e.decisions = []; }, /accepted ADR/],
  ['missing reciprocal link', (_p, e) => { e.files.set('decision.md', 'unrelated'); }, /reciprocal/],
  ['FMS scope drift', (_p, e) => { e.files.set(pending.fms.profile, '{}'); }, /FMS profile changed/],
  ['new production root', (_p, e) => { e.policy.governedRoots = ['packages/new/src']; }, /roots drift/],
  ['new boundary', (_p, e) => { e.policy.boundaries.push({ id: 'new', roots: ['packages/test/src/new'] }); }, /boundary/],
  ['new entrypoint', (_p, e) => { e.policy.boundaries[0].entrypoints.push('new.ts'); }, /entrypoints drift/],
  ['stale mapped source', (_p, e) => { e.files.delete('mapping.ts'); }, /stale/],
  ['deleted checker', (_p, e) => { e.files.delete('scripts/architecture/check-get-modular-adoption.mjs'); }, /missing path/],
  ['no-op replacement', (_p, e) => { e.scripts['architecture:adoption'] = 'node -e ""'; }, /command drift/],
  ['removed fast gate', (_p, e) => { e.scripts['check:fast'] = 'pnpm lint'; }, /root gate missing/],
  ['archive drift', (_p, e) => { e.artifacts[0].bytes += 'drift'; }, /archive drift/],
  ['stale exception', p => { p.exceptions = [{ boundary: 'missing', rule: 'wiring', paths: ['mapping.ts'], authority: 'decision.md', owner: 'Test', rationale: 'test', reviewTrigger: 'test' }]; }, /stale exception/],
];
for (const [name, mutate, expected] of mutations) {test(name, () => {
  const { profile, evidence } = fixture(); mutate(profile, evidence);
  assert.throws(() => verifyAdoption(profile, evidence), expected);
});}

async function diskFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-adoption-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const { profile, evidence } = fixture();
  profile.authority.path = 'docs/decisions/0015-test-adoption.md';
  for (const [path, value] of evidence.files) { await write(path, value); }
  await write(profile.authority.path, `---
id: ADR-0015
type: adr
status: accepted
owner: architecture
---
# ADR-0015: Test adoption

architecture/get-modular/consumer-profile.json
`);
  await write('docs/decisions/README.md', '# Decisions\n\n## Proposed\n\n## Accepted\n\n- [ADR-0015](0015-test-adoption.md)\n\n## Superseded\n');
  const decisionConfig = 'architecture/foundation/governance-architecture-decisions.yaml';
  await write(decisionConfig, { schemaVersion: 1, adrRoots: ['docs/decisions'], index: {
    path: 'docs/decisions/README.md', sections: { proposed: 'Proposed', accepted: 'Accepted', superseded: 'Superseded' } },
    acceptedBaselinePath: 'architecture/decisions/accepted-decisions.json' });
  await promoteArchitectureDecisionBaseline({ consumerRoot: root, configPath: decisionConfig });
  await write('architecture/foundation/source-dependencies.yaml', { schemaVersion: 1,
    workspace: { kind: 'pnpm', manifest: 'pnpm-workspace.yaml' }, governedRoots: profile.productionRoots,
    boundaries: profile.boundaries.map(b => ({ id: b.id, roots: b.roots, entrypoints: b.entrypoints,
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } })) });
  await write('package.json', { scripts: evidence.scripts });
  await write('packages/apps/embedded-runtime/package.json', { dependencies: Object.fromEntries(profile.packages.map(p => [p.name, p.version])) });
  const integrity = `sha512-${createHash('sha512').update('synthetic archive').digest('base64')}`;
  const lock = { lockfileVersion: '9.0', importers: { 'packages/apps/embedded-runtime': {
    dependencies: Object.fromEntries(profile.packages.map(p => [p.name, { specifier: p.version, version: p.version }])) } },
    packages: Object.fromEntries(profile.packages.map(p => [`${p.name}@${p.version}`, { resolution: { integrity } }])) };
  await write('pnpm-lock.yaml', lock);
  for (const pkg of profile.packages) { await write(pkg.archivePath, 'synthetic archive'); }
  await write(profile.standard.evidencePath, evidence.standard.bytes);
  await write('architecture/get-modular/consumer-profile.json', profile);
  return { root, profile, lock, write };
}

test('actual filesystem loader and CLI validate offline retained identities', async t => {
  const { root } = await diskFixture(t);
  const result = await checkAdoption(root);
  assert.equal(result.status, 'verified-metadata');
  assert.ok(result.reviewRequired.includes('semantic ownership'));
  const output = execFileSync(process.execPath, [new URL('./check-get-modular-adoption.mjs', import.meta.url).pathname, '--consumer', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).status, 'verified-metadata');
});
for (const [name, mutate, pattern] of [
  ['retained central bytes', f => f.write(f.profile.standard.evidencePath, 'drift'), /central bytes drift/],
  ['accepted ADR immutable bytes', f => f.write(f.profile.authority.path, 'rewritten'), /immutable governance catalog/],
  ['manifest exact version', f => f.write('packages/apps/embedded-runtime/package.json', { dependencies: {} }), /manifest version drift/],
  ['lock exact version', f => { f.lock.importers['packages/apps/embedded-runtime'].dependencies['@get-modular/core'].version = '0.2.0'; return f.write('pnpm-lock.yaml', f.lock); }, /lock version drift/],
  ['retained archive bytes', f => f.write(f.profile.packages[0].archivePath, 'drift'), /lock archive integrity drift/],
  ['missing retained archive', f => rm(join(f.root, f.profile.packages[0].archivePath)), /ENOENT/],
]) {
  test(`filesystem loader rejects ${name}`, async t => {
    const f = await diskFixture(t); await mutate(f);
    await assert.rejects(checkAdoption(f.root), pattern);
  });
}

 test('accepts ADR adoption-record reciprocity without rewriting accepted authority', () => {
  const { profile, evidence } = fixture();
  evidence.files.set(profile.authority.path, '[record](../architecture/get-modular-adoption.md)');
  evidence.files.set('docs/architecture/get-modular-adoption.md', 'ADR-0015 architecture/get-modular/consumer-profile.json');
  assert.equal(verifyAdoption(profile, evidence).status, 'verified-metadata');
  evidence.files.set('docs/architecture/get-modular-adoption.md', 'ADR-0015 unrelated');
  assert.throws(() => verifyAdoption(profile, evidence), /reciprocal/);
});
