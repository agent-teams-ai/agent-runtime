import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { digest, validateProfile, verifyAdoption } from './check-get-modular-adoption.mjs';

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
      { id: 'composition.legacy', owner: 'Test', roots: ['packages/test/src/legacy'], entrypoints: ['packages/test/src/legacy.ts'], status: 'not-adopted', rationale: 'retained direct edge', reviewTrigger: 'new edge', relationships: [{ from: 'packages/test/src/legacy.ts', to: 'test-library' }] },
    ],
    compositions: [{ boundary: 'composition.test', entrypoint: 'packages/test/src/composition.ts', declarations: 'mapping.ts', profile: 'mapping.ts', factories: 'mapping.ts', tests: ['tests/mapping.test.ts'] }],
    packages: ['@get-modular/core', '@get-modular/assembly'].map(name => ({ name, version: '0.1.0', archiveSha256: digest('synthetic archive') })),
    enforcement: { roots: ['check:fast', 'check'], commands: { 'architecture:adoption': 'node scripts/architecture/check-get-modular-adoption.mjs' } },
  });
  profile.standard.commit = standard.commit; profile.standard.sha256 = digest(standard.bytes);
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
