import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
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
  assert.ok(profile.standard.commit && profile.standard.sha256 && profile.standard.evidencePath, 'missing immutable standard pin');
  assert.ok(profile.authority.path, 'missing accepted authority');
  assert.ok(profile.productionRoots.length && profile.boundaries.length, 'missing activation census');
  assert.ok(profile.boundaries.some(b => b.status === 'adopted') && profile.compositions.length, 'active adoption requires a materialized composition');
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
  const authority = get(profile.authority.path);
  const recordPath = 'docs/architecture/get-modular-adoption.md';
  const directLink = authority.includes('architecture/get-modular/consumer-profile.json');
  const recordLink = authority.includes('../architecture/get-modular-adoption.md')
    && get(recordPath).includes('architecture/get-modular/consumer-profile.json')
    && get(recordPath).includes(profile.authority.id);
  assert.ok(directLink || recordLink, 'authority reciprocal profile link missing');
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
  assert.ok(Object.values(profile.enforcement.commands).includes('node scripts/architecture/check-get-modular-adoption.mjs'), 'canonical adoption checker missing');
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

async function readPackageArtifact(pkg, embedded, lock, bytes, workspace) {
  const specifier = embedded.dependencies?.[pkg.name];
  if (specifier === 'catalog:') {
    assert.equal(workspace.catalog?.[pkg.name], pkg.version, `exact catalog version drift: ${pkg.name}`);
    assert.equal(lock.catalogs?.default?.[pkg.name]?.specifier, pkg.version, `lock catalog specifier drift: ${pkg.name}`);
    assert.equal(lock.catalogs?.default?.[pkg.name]?.version, pkg.version, `lock catalog version drift: ${pkg.name}`);
  } else {
    assert.equal(specifier, pkg.version, `exact manifest version drift: ${pkg.name}`);
  }
  const locked = lock.importers?.['packages/apps/embedded-runtime']?.dependencies?.[pkg.name];
  assert.equal(locked?.specifier, specifier, `lock specifier drift: ${pkg.name}`);
  assert.equal(locked?.version, pkg.version, `lock version drift: ${pkg.name}`);
  const integrity = lock.packages?.[`${pkg.name}@${pkg.version}`]?.resolution?.integrity;
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+=*)$/.exec(integrity ?? '');
  assert.ok(match, `registry archive integrity missing: ${pkg.name}`);
  const archive = await bytes(pkg.archivePath);
  assert.equal(createHash(match[1]).update(archive).digest('base64'), match[2], `lock archive integrity drift: ${pkg.name}`);
  return { name: pkg.name, version: pkg.version, bytes: archive };
}

/** Self-contained offline loader. The accepted profile retains adoption-time Git
 * provenance; routine checks verify retained bytes, not the remote commit object.
 * Foundation owns ADR immutable digest validation and source policy parsing.
 */
export async function checkAdoption(root) {
  const consumerRoot = await realpath(root);
  const local = async path => {
    assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.split('/').includes('..'), 'unsafe evidence path');
    const full = await realpath(resolve(consumerRoot, path));
    const rel = relative(consumerRoot, full);
    assert.ok(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'evidence escapes consumer checkout');
    return full;
  };
  const bytes = async path => readFile(await local(path));
  const json = async path => JSON.parse(await bytes(path));
  const profile = await json('architecture/get-modular/consumer-profile.json');
  const status = validateProfile(profile);
  if (status.status === 'pending') { return status; }
  const { loadCapabilityConfig } = await import('../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/contract/config.js');
  const { readAcceptedArchitectureDecisionEvidence } = await import('../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js');
  const { loadStrictYamlFile } = await import('../../node_modules/@agent-teams/engineering-foundation/dist/strict-yaml.js');
  const policy = await loadCapabilityConfig(consumerRoot, 'architecture/foundation/source-dependencies.yaml');
  const accepted = await readAcceptedArchitectureDecisionEvidence({ consumerRoot,
    configPath: 'architecture/foundation/governance-architecture-decisions.yaml',
    baselinePath: 'architecture/decisions/accepted-decisions.json' });
  const registry = await json('architecture/decisions/accepted-decisions.json');
  const decisions = registry.decisions.filter(d => accepted.acceptedDecisionIds.includes(d.id) && accepted.acceptedDecisionPaths.includes(d.path));
  const manifest = await json('package.json');
  const importer = 'packages/apps/embedded-runtime';
  const embedded = await json(`${importer}/package.json`);
  const lock = await loadStrictYamlFile(consumerRoot, 'pnpm-lock.yaml', 'consumer-adoption-lock');
  const workspace = profile.packages.some(pkg => embedded.dependencies?.[pkg.name] === 'catalog:')
    ? await loadStrictYamlFile(consumerRoot, 'pnpm-workspace.yaml', 'consumer-adoption-workspace') : {};
  const artifacts = await Promise.all(profile.packages.map(pkg => readPackageArtifact(pkg, embedded, lock, bytes, workspace)));
  const paths = new Set([profile.authority.path, profile.fms.profile]);
  if ((await bytes(profile.authority.path)).toString('utf8').includes('../architecture/get-modular-adoption.md')) {
    paths.add('docs/architecture/get-modular-adoption.md');
  }
  for (const boundary of profile.boundaries) {
    for (const path of boundary.roots) { await stat(await local(path)); }
    boundary.entrypoints.forEach(path => paths.add(path));
    boundary.relationships.forEach(edge => paths.add(edge.from));
  }
  profile.productionRoots.forEach(path => paths.add(path));
  for (const composition of profile.compositions) {
    [composition.entrypoint, composition.declarations, composition.profile, composition.factories, ...composition.tests].forEach(path => paths.add(path));
  }
  for (const exception of profile.exceptions) {
    exception.paths.forEach(path => paths.add(path)); paths.add(exception.authority);
  }
  for (const command of Object.values(profile.enforcement.commands)) {
    const script = command.match(/^node (?:--test )?(scripts\/[^ ]+\.mjs)$/)?.[1];
    if (script) { paths.add(script); }
  }
  const files = new Map();
  for (const path of paths) {
    const full = await local(path);
    if ((await stat(full)).isFile()) { files.set(path, await readFile(full, 'utf8')); }
  }
  return verifyAdoption(profile, { policy, files, scripts: manifest.scripts, decisions, artifacts,
    standard: { commit: profile.standard.commit, bytes: (await bytes(profile.standard.evidencePath)).toString('utf8') } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--consumer'), 'usage: check-get-modular-adoption.mjs [--consumer path]');
  const root = process.argv[3] ?? fileURLToPath(new URL('../../', import.meta.url));
  const result = await checkAdoption(root);
  console.log(JSON.stringify(result));
  if (result.status !== 'verified-metadata') { process.exitCode = 1; }
}
