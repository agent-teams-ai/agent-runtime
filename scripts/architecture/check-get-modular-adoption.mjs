import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const schema = JSON.parse(await readFile(new URL('../../architecture/get-modular/consumer-profile.schema.json', import.meta.url)));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equalSet = (actual, expected, label) => assert.deepEqual([...actual].toSorted(), [...expected].toSorted(), label);
const within = (path, root) => path === root || path.startsWith(`${root}/`);

/** Metadata only. Active verification requires current Foundation policy and separately executed source diagnostics.
 * No source parsing, inferred legacy, or whole-repository conformance claim lives here.
 */
export function validateProfile(profile) {
  assert.ok(validate(profile), `consumer profile schema: ${JSON.stringify(validate.errors)}`);
  if (profile.status === 'pending') {
    assert.ok(profile.pending.length, 'pending profile must explain remaining evidence');
    return { status: 'pending', pending: profile.pending };
  }
  assert.equal(profile.pending.length, 0, 'active profile has pending evidence');
  assert.ok(profile.standard.commit && profile.standard.sha256, 'missing immutable standard pin');
  assert.ok(profile.authority.path, 'missing accepted authority');
  assert.ok(profile.productionRoots.length && profile.boundaries.length, 'missing activation census');
  equalSet(profile.packages.map(p => p.name), ['@get-modular/core', '@get-modular/assembly'], 'exact package pair');
  assert.equal(new Set(profile.boundaries.map(b => b.id)).size, profile.boundaries.length, 'duplicate boundary');
  return { status: 'active' };
}

/** Inputs must come from the current checkout: Foundation policy,
 * accepted-decision registry, exact standard checkout bytes, and artifact custody.
 * Injection permits disposable negative fixtures without executing provider code.
 */
export function verifyAdoption(profile, evidence) {
  assert.equal(validateProfile(profile).status, 'active', 'adoption remains pending');
  const { policy, files, scripts, decisions, standard, artifacts } = evidence;
  assert.equal(standard.commit, profile.standard.commit, 'central commit drift');
  assert.equal(digest(standard.bytes), profile.standard.sha256, 'central bytes drift');
  assert.ok(standard.bytes.includes('consumer-module-standard') || standard.bytes.includes('Consumer module standard'), 'central anchor missing');
  assert.ok(standard.bytes.includes(profile.standard.decision), 'central ADR reference missing');
  assert.ok(decisions.some(d => d.id === profile.authority.id && d.path === profile.authority.path), 'accepted ADR missing');
  const get = path => { assert.ok(files.has(path), `stale or missing path: ${path}`); return files.get(path); };
  assert.ok(get(profile.authority.path).includes('architecture/get-modular/consumer-profile.json'), 'authority reciprocal profile link missing');
  assert.equal(digest(get(profile.fms.profile)), profile.fms.sha256, 'FMS profile changed');
  const fms = JSON.parse(get(profile.fms.profile));
  assert.equal(fms.status, 'active', 'FMS activation changed');
  equalSet(fms.features.map(f => f.id), profile.fms.features, 'FMS scope changed');
  equalSet(policy.governedRoots.filter(r => r.startsWith('packages/')), profile.productionRoots, 'production roots drift');
  const boundaries = policy.boundaries.filter(b => b.roots.some(r => profile.productionRoots.some(p => within(r, p))));
  equalSet(boundaries.map(b => b.id), profile.boundaries.map(b => b.id), 'unknown or stale boundary');
  for (const boundary of profile.boundaries) {
    const current = boundaries.find(b => b.id === boundary.id);
    equalSet(current.roots, boundary.roots, `roots drift: ${boundary.id}`);
    equalSet(current.entrypoints, boundary.entrypoints, `entrypoints drift: ${boundary.id}`);
    boundary.entrypoints.forEach(get);
    // Relationships are reviewed declarations, not a source-derived census.
    boundary.relationships.forEach(edge => get(edge.from));
    if (boundary.status === 'adopted') {assert.ok(profile.compositions.some(c => c.boundary === boundary.id), 'adopted mapping missing');}
  }
  for (const composition of profile.compositions) {
    assert.ok(profile.boundaries.some(b => b.id === composition.boundary && b.status === 'adopted' && b.entrypoints.includes(composition.entrypoint)), 'mapping boundary mismatch');
    [composition.entrypoint, composition.declarations, composition.profile, composition.factories, ...composition.tests].forEach(get);
    assert.ok(composition.tests.length, 'mapping tests missing');
  }
  for (const exception of profile.exceptions) {
    assert.ok(profile.boundaries.some(b => b.id === exception.boundary), 'stale exception boundary');
    assert.ok(exception.paths.length, 'empty exception');
    exception.paths.forEach(get);
    assert.ok(decisions.some(d => d.path === exception.authority), 'exception authority not accepted');
  }
  for (const pkg of profile.packages) {
    const artifact = artifacts.find(a => a.name === pkg.name && a.version === pkg.version);
    assert.ok(artifact && digest(artifact.bytes) === pkg.archiveSha256, 'package archive drift');
  }
  assert.ok(Object.keys(profile.enforcement.commands).length, 'commands missing');
  for (const [name, command] of Object.entries(profile.enforcement.commands)) {
    assert.equal(scripts[name], command, `command drift: ${name}`);
    assert.ok(!/[|;\n]/.test(command) && !command.includes('allow-diagnostics'), 'nonblocking command');
    const executable = command.match(/^node (?:--test )?(scripts\/[^ ]+\.mjs)$/)?.[1];
    if (executable) {get(executable);}
    for (const root of profile.enforcement.roots) {
      assert.ok(scripts[root]?.split(' && ').includes(`pnpm ${name}`), `root gate missing: ${root}/${name}`);
    }
  }
  return { status: 'verified-metadata', scope: profile.authority.scope, boundaries: boundaries.length,
    reviewRequired: ['new relationships inside existing boundaries', 'new capabilities inside existing source paths', 'semantic ownership'] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const profile = JSON.parse(await readFile(new URL('../../architecture/get-modular/consumer-profile.json', import.meta.url)));
  const result = validateProfile(profile);
  console.log(JSON.stringify(result));
  // Metadata validation is deliberately not an active adoption gate.
  if (result.status !== 'pending') {throw new Error('Active gate requires finalized local pin/artifact evidence loader; metadata alone is not adoption evidence');}
}
