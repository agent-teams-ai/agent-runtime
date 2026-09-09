import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promoteArchitectureDecisionBaseline } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js';
import { readSourceCensus, requireSourceDiagnostics, verifySourceCensus } from './get-modular-source-census.mjs';
import { loadCapabilityConfig } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/contract/config.js';
import { checkAdoption, digest, validateProfile, verifyAdoption } from './check-get-modular-adoption.mjs';

const pending = JSON.parse(await readFile(new URL('../../architecture/get-modular/consumer-profile.json', import.meta.url)));
function fixture() {
  const profile = structuredClone(pending);
  const standard = { commit: 'a'.repeat(40), bytes: 'Consumer module standard ADR-0026' };
  const fms = JSON.stringify({ status: 'active', features: profile.fms.features.map(id => ({ id })) });
  const files = new Map([
    [profile.fms.profile, fms], ['decision.md', 'architecture/get-modular/consumer-profile.json'],
    ['packages/test/src/composition.ts', 'export {};'], ['packages/test/src/legacy.ts', 'export {};'],
    ['mapping.ts', 'synthetic mapping'], ['tests/mapping.test.ts', 'synthetic test'],
    ['scripts/architecture/check-get-modular-adoption.mjs', 'synthetic checker'],
    ['scripts/architecture/check-get-modular-adoption.test.mjs', 'synthetic rejecting tests'],
  ]);
  Object.assign(profile, { status: 'active', pending: [], productionRoots: ['packages/test/src'],
    boundaries: [
      { id: 'composition.test', owner: 'Test', roots: ['packages/test/src'], entrypoints: ['packages/test/src/composition.ts'], status: 'adopted', rationale: 'synthetic slice', reviewTrigger: 'boundary change', relationships: [] },
      { id: 'composition.legacy', owner: 'Test', roots: ['packages/test/src/legacy.ts'], entrypoints: ['packages/test/src/legacy.ts'], status: 'not-adopted', rationale: 'retained direct edge', reviewTrigger: 'new edge', relationships: [{ from: 'packages/test/src/legacy.ts', to: 'test-library', mode: 'runtime' }] },
    ],
    compositions: [{ boundary: 'composition.test', entrypoint: 'packages/test/src/composition.ts', declarations: 'mapping.ts', profile: 'mapping.ts', factories: 'mapping.ts', tests: ['tests/mapping.test.ts'] }],
    packages: ['@get-modular/core', '@get-modular/assembly'].map(name => ({ name, version: '0.1.0', archiveSha256: digest('synthetic archive'), archivePath: `evidence/${name.split('/')[1]}.tgz` })),
    enforcement: { roots: ['check:fast', 'check'], commands: { 'architecture:adoption': 'node scripts/architecture/check-get-modular-adoption.mjs', 'test:adoption': 'node --test scripts/architecture/check-get-modular-adoption.test.mjs' } },
  });
  profile.standard.evidencePath = 'evidence/common-assembly.md'; profile.standard.commit = standard.commit; profile.standard.sha256 = digest(standard.bytes);
  profile.authority.path = 'decision.md'; profile.fms.sha256 = digest(fms);
  const evidence = { standard, files, decisions: [{ id: 'ADR-0015', path: 'decision.md' }],
    artifacts: profile.packages.map(p => ({ ...p, bytes: 'synthetic archive' })),
    scripts: { ...profile.enforcement.commands, check: 'pnpm architecture:adoption && pnpm test:adoption', 'check:fast': 'pnpm architecture:adoption && pnpm test:adoption' },
    policy: { governedRoots: profile.productionRoots, boundaries: structuredClone(profile.boundaries) },

  };
  return { profile, evidence };
}

test('repository profile activates only the scoped passive setup', () => {
  assert.equal(validateProfile(pending).status, 'active');
  const profile = structuredClone(pending); profile.status = 'pending'; profile.pending = ['missing evidence'];
  assert.throws(() => verifyAdoption(profile, {}), /pending/);
});
test('adopted slice, unchanged FMS and declared legacy metadata pass', () => {
  const { profile, evidence } = fixture();
  assert.equal(verifyAdoption(profile, evidence).status, 'verified-metadata');
});
const mutations = [
  ['coordinated no-op command replacement', (p, e) => {
    p.enforcement.commands['architecture:adoption'] = 'node -e ""';
    e.scripts['architecture:adoption'] = 'node -e ""';
  }, /canonical adoption checker missing/],
  ['unrelated command cannot substitute adoption checker', (p, e) => {
    p.enforcement.commands = { lint: 'node scripts/lint.mjs' };
    e.scripts.lint = 'node scripts/lint.mjs';
    e.scripts.check = 'pnpm lint'; e.scripts['check:fast'] = 'pnpm lint';
    e.files.set('scripts/lint.mjs', 'synthetic lint');
  }, /canonical adoption checker missing/],
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
  ['commented root chain bypass', (_p, e) => { e.scripts['check:fast'] = 'true # && pnpm architecture:adoption'; }, /nonblocking root command/],
  ['coordinated rejecting test gate removal', (p, e) => { delete p.enforcement.commands['test:adoption']; delete e.scripts['test:adoption']; e.scripts.check = 'pnpm architecture:adoption'; e.scripts['check:fast'] = 'pnpm architecture:adoption'; }, /canonical adoption rejecting tests missing/],
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
      allow: { boundaries: b.id === 'composition.test' ? ['composition.legacy'] : [], packages: [], builtins: [], runtimeReferences: [] } })) });
  await write('package.json', { name: '@test/root', scripts: evidence.scripts });
  await write('packages/apps/embedded-runtime/package.json', { dependencies: Object.fromEntries(profile.packages.map(p => [p.name, p.version])) });
  const integrity = `sha512-${createHash('sha512').update('synthetic archive').digest('base64')}`;
  const lock = { lockfileVersion: '9.0', importers: { 'packages/apps/embedded-runtime': {
    dependencies: Object.fromEntries(profile.packages.map(p => [p.name, { specifier: p.version, version: p.version }])) } },
    packages: Object.fromEntries(profile.packages.map(p => [`${p.name}@${p.version}`, { resolution: { integrity } }])) };
  await write('pnpm-lock.yaml', lock);
  await write('pnpm-workspace.yaml', { packages: ['packages/test'] });
  await write('packages/test/package.json', { name: '@test/fixture', version: '1.0.0' });
  const policy = await loadCapabilityConfig(root, 'architecture/foundation/source-dependencies.yaml');
  const census = await readSourceCensus(root, policy);
  profile.sourceCensus = { packageRoots: census.packageRoots, featureRoots: census.featureRoots };
  profile.boundaries.forEach(b => { b.relationships = census.relationships[b.id]; });
  for (const pkg of profile.packages) { await write(pkg.archivePath, 'synthetic archive'); }
  await write(profile.standard.evidencePath, evidence.standard.bytes);
  await write('architecture/get-modular/consumer-profile.json', profile);
  return { root, profile, lock, write };
}

test('actual filesystem loader and CLI validate offline retained identities', async t => {
  const { root } = await diskFixture(t);
  const result = await checkAdoption(root);
  assert.equal(result.status, 'verified');
  assert.ok(result.reviewRequired.includes('semantic ownership'));
  const output = execFileSync(process.execPath, [new URL('./check-get-modular-adoption.mjs', import.meta.url).pathname, '--consumer', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).status, 'verified');
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

for (const fault of [null, 'workspace-range', 'catalog-specifier', 'catalog-version', 'importer-specifier']) {
  test(`catalog-backed exact artifact verification: ${fault ?? 'accepted'}`, async t => {
    const f = await diskFixture(t);
    const catalog = Object.fromEntries(f.profile.packages.map(p => [p.name, p.version]));
    f.lock.catalogs = { default: Object.fromEntries(f.profile.packages.map(p => [p.name, { specifier: p.version, version: p.version }])) };
    for (const p of f.profile.packages) {f.lock.importers['packages/apps/embedded-runtime'].dependencies[p.name].specifier = 'catalog:';}
    if (fault === 'workspace-range') {catalog['@get-modular/core'] = '^0.1.0';}
    if (fault === 'catalog-specifier') {f.lock.catalogs.default['@get-modular/core'].specifier = '^0.1.0';}
    if (fault === 'catalog-version') {f.lock.catalogs.default['@get-modular/core'].version = '0.2.0';}
    if (fault === 'importer-specifier') {f.lock.importers['packages/apps/embedded-runtime'].dependencies['@get-modular/core'].specifier = '0.1.0';}
    await f.write('pnpm-workspace.yaml', { packages: ['packages/test'], catalog });
    await f.write('pnpm-lock.yaml', f.lock);
    await f.write('packages/apps/embedded-runtime/package.json', { dependencies: Object.fromEntries(f.profile.packages.map(p => [p.name, 'catalog:'])) });
    if (fault) {await assert.rejects(checkAdoption(f.root), /(?:catalog|lock specifier).*drift/);}
    else {assert.equal((await checkAdoption(f.root)).status, 'verified');}
  });
}

for (const [name, mutate, pattern] of [
  ['unknown feature in an existing owner', f => f.write('packages/test/src/features/new-feature/index.ts', 'export {};'), /feature census drift/],
  ['unknown workspace package', async f => { await f.write('pnpm-workspace.yaml', { packages: ['packages/*'] }); await f.write('packages/new/package.json', { name: '@test/new', version: '1.0.0' }); await f.write('packages/new/src/index.ts', 'export {};'); }, /unclassified production source/],
  ['new permitted edge in existing boundaries', f => f.write('packages/test/src/composition.ts', "import type {} from './legacy.js';"), /relationships drift/],
  ['stale reviewed relationship', async f => { f.profile.boundaries[0].relationships.push({ from: 'packages/test/src/composition.ts', to: 'packages/test/src/legacy.ts', mode: 'type-only' }); await f.write('architecture/get-modular/consumer-profile.json', f.profile); }, /relationships drift/],
  ['missing live census', async f => { delete f.profile.sourceCensus; await f.write('architecture/get-modular/consumer-profile.json', f.profile); }, /source census missing/],
]) {
  test(`live loader rejects ${name}`, async t => { const f = await diskFixture(t); await mutate(f); await assert.rejects(checkAdoption(f.root), pattern); });
}

test('census rejects new edges and type-to-runtime widening even when policy permits both', () => {
  const profile = { productionRoots: ['packages/test/src'], sourceCensus: { packageRoots: [], featureRoots: [] }, boundaries: [{ id: 'legacy', relationships: [{ from: 'a.ts', to: 'b.ts', mode: 'type-only' }] }] };
  const census = { ...profile.sourceCensus, productionRoots: profile.productionRoots, relationships: { legacy: structuredClone(profile.boundaries[0].relationships) } };
  verifySourceCensus(profile, census);
  census.relationships.legacy[0].mode = 'runtime';
  assert.throws(() => verifySourceCensus(profile, census), /relationships drift/);
  census.relationships.legacy = [{ from: 'new.ts', to: 'b.ts', mode: 'type-only' }];
  assert.throws(() => verifySourceCensus(profile, census), /relationships drift/);
});

async function retainFixtureCensus(f) {
  const policy = await loadCapabilityConfig(f.root, 'architecture/foundation/source-dependencies.yaml');
  const census = await readSourceCensus(f.root, policy);
  f.profile.sourceCensus = { packageRoots: census.packageRoots, featureRoots: census.featureRoots };
  f.profile.boundaries.forEach(b => { b.relationships = census.relationships[b.id]; });
  await f.write('architecture/get-modular/consumer-profile.json', f.profile);
}

test('live parser rejects type-to-runtime widening of a reviewed permitted relationship', async t => {
  const f = await diskFixture(t);
  await f.write('packages/test/src/composition.ts', "import type {} from './legacy.js';");
  await retainFixtureCensus(f);
  assert.equal((await checkAdoption(f.root)).status, 'verified');
  await f.write('packages/test/src/composition.ts', "import './legacy.js';");
  await assert.rejects(checkAdoption(f.root), /relationships drift/);
});

test('same-feature helpers are allowed, but a new same-boundary cross-feature edge is rejected', async t => {
  const f = await diskFixture(t);
  await f.write('packages/test/src/features/one/index.ts', 'export {};');
  await f.write('packages/test/src/features/two/index.ts', 'export {};');
  // Even a declared feature entrypoint may depend on its own fixed helper.
  f.profile.boundaries[0].entrypoints.push('packages/test/src/features/one/index.ts');
  const configPath = 'architecture/foundation/source-dependencies.yaml';
  const config = JSON.parse(await readFile(join(f.root, configPath), 'utf8'));
  config.boundaries[0].entrypoints.push('packages/test/src/features/one/index.ts');
  await f.write(configPath, config);
  await retainFixtureCensus(f);
  await f.write('packages/test/src/features/one/helper.ts', 'export {};');
  await f.write('packages/test/src/features/one/index.ts', "import './helper.js';");
  assert.equal((await checkAdoption(f.root)).status, 'verified');
  await f.write('packages/test/src/features/one/index.ts', "import '../two/index.js';");
  await assert.rejects(checkAdoption(f.root), /relationships drift/);
});

test('active profile retains the two direct contained-turn seams without claiming their migration', () => {
  const composition = pending.boundaries.find(b => b.id === 'composition.embedded-runtime');
  for (const leaf of ['agent-runtime-host', 'contained-turn-feature-composition']) {
    assert.ok(composition.relationships.some(edge => edge.from.endsWith('/host-custodied-agent-runtime-host.ts') && edge.to.endsWith(`/${leaf}.ts`) && edge.mode === 'runtime'));
  }
  assert.match(composition.rationale, /contained-turn.*remains direct/);
  assert.equal(pending.compositions.length, 1);
  assert.equal(pending.compositions[0].factorySymbol, 'createDefaultAgentRuntimeHost');
});

test('PR71 reviewed owners and helpers retain exact live relationships without expanding adoption', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const policy = await loadCapabilityConfig(root, 'architecture/foundation/source-dependencies.yaml');
  const census = await readSourceCensus(root, policy);
  verifySourceCensus(pending, census);
  // Explicit semantic review subjects, not a regenerated list from the live graph.
  const subjects = {
    'adapter.agent-execution.docker-custody': ['node-docker-route-provenance'],
    'adapter.agent-execution.host-custody': ['contained-turn-kernel-custody-open-attempts'],
    'composition.embedded-runtime': [
      'contained-turn-current-authority', 'linux-codex-contained-turn-owner',
      'linux-codex-deployment-authority', 'linux-codex-deployment',
      'linux-codex-node-recipe-consumption', 'linux-codex-node-recipe',
    ],
    'production.agent-execution': [
      'codex-native-broker-file-installer', 'contained-turn-route-enforcement-capability',
      'deferred-codex-native-broker-files', 'docker-codex-current-kernel-owner',
      'docker-codex-effect-custody-owner', 'docker-consumption-observations',
      'node-docker-deployment-recipe', 'node-docker-route-provenance',
    ],
  };
  for (const [id, sources] of Object.entries(subjects)) {
    const boundary = pending.boundaries.find(b => b.id === id);
    assert.equal(boundary.status, id === 'composition.embedded-runtime' ? 'adopted' : 'not-adopted');
    for (const source of sources) {
      const edges = boundary.relationships.filter(edge => basename(edge.from) === `${source}.ts`);
      assert.ok(edges.length, `missing reviewed subject: ${id}/${source}`);
      for (const edge of edges) {
        for (const [mutation, mutate] of [
          ['omitted', (retained, index) => retained.splice(index, 1)],
          ['mode-changed', (retained, index) => {retained[index].mode = edge.mode === 'runtime' ? 'type-only' : 'runtime';}],
        ]) {
          const profile = structuredClone(pending);
          const retained = profile.boundaries.find(b => b.id === id).relationships;
          const index = boundary.relationships.indexOf(edge);
          mutate(retained, index);
          assert.throws(() => verifySourceCensus(profile, census), /live relationships drift/,
            `${mutation}: ${edge.from} -> ${edge.to}`);
        }
      }
    }
  }
  const helper = pending.boundaries.find(b => b.id === 'composition.embedded-runtime').relationships
    .filter(edge => edge.from.endsWith('/linux-codex-node-recipe-consumption.ts'));
  assert.deepEqual(helper.map(edge => [edge.to, edge.mode]), [['@agent-teams/agent-execution/composition', 'type-only']]);
  assert.deepEqual(pending.boundaries.filter(b => b.status === 'adopted').map(b => b.id), ['composition.embedded-runtime']);
  assert.deepEqual(pending.compositions.map(c => c.factorySymbol), ['createDefaultAgentRuntimeHost']);
  assert.deepEqual(pending.exceptions, []);
});

for (const direction of ['export-new-host', 'wrap-existing-entrypoint']) {
  test(`live loader rejects a new same-boundary composition seam: ${direction}`, async t => {
    const f = await diskFixture(t);
    const entrypoint = 'packages/test/src/composition.ts';
    const newHost = 'packages/test/src/composition/new-independent-host.ts';
    if (direction === 'export-new-host') {
      await f.write(newHost, 'export const createNewHost = () => ({});');
      await f.write(entrypoint, "export { createNewHost } from './composition/new-independent-host.js';");
    } else {
      await f.write(newHost, "export * from '../composition.js';");
    }
    await requireSourceDiagnostics(f.root);
    await assert.rejects(checkAdoption(f.root), /relationships drift/);
  });
}
