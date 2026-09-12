import assert from 'node:assert/strict';
import {test as nodeTest} from 'node:test';
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;
import fs, {existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, linkSync, truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {collectLinuxCodexLiveEvidence} from './linux-codex-live-evidence.mjs';
import {encodeContainedTurnArtifactManifest, computeContainedTurnArtifactTreeDigest} from '@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-artifact-manifest.js';
import {createHash} from 'node:crypto';

const platform = new URL('../../../../platform/filesystem-custody/', import.meta.url);
const {createContainedTurnArtifactStore} = await import('@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-artifact-store.js');
const {bindContainedTurnRoot} = await import('@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-filesystem-custody.js');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const approval = {markerFile: 'approved.txt', marker: 'CANARY_123'};
const operationId = 'operation:evidence-test';
const scope = {tenantId: 'tenant:test', projectId: 'project:test'};
const nativeAvailable = existsSync(new URL('dist/rename-no-replace.node', platform)) ||
  existsSync(new URL('src/rename-no-replace.node', platform));

async function fixture(t, {path = approval.markerFile, content = approval.marker + '\n',
  output = [{cursor: 0, kind: 'assistant', text: approval.marker}], realStore = true, parent = tmpdir()} = {}) {
  const root = mkdtempSync(join(parent, 'linux-codex-live-evidence-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const roots = {};
  for (const [key, relative] of Object.entries({blobs: 'artifacts/blobs', manifests: 'artifacts/manifests',
    staging: 'artifacts/staging', stagingQuarantine: 'artifacts/staging-quarantine'})) {
    const directory = join(root, relative); mkdirSync(directory, {recursive: true, mode: 0o700});
    roots[key] = await bindContainedTurnRoot(directory, {private: true});
  }
  const store = createContainedTurnArtifactStore({roots, limits: {
    maxDepth: 8, maxEntries: 4096, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  }});
  const put = async (domain, payload) => {
    const digest = hash(payload);
    if (realStore) {await store.writeContentAddressed(domain, digest, payload);}
    else {
      // Explicit adversarial fixture construction; never called by the real-store acceptance test.
      const directory = join(root, 'artifacts', domain === 'blob' ? 'blobs' : 'manifests', digest.slice(0, 2));
      mkdirSync(directory, {recursive: true, mode: 0o700}); writeFileSync(join(directory, digest), payload);
    }
    return digest;
  };
  const bytes = Buffer.from(content);
  const entries = path === null ? [] : [{kind: 'file', path, mode: 0o600, size: bytes.length, digest: await put('blob', bytes)}];
  const projected = [];
  for (const item of output) {
    const outputBytes = Buffer.from(item.text);
    projected.push({cursor: item.cursor, kind: item.kind, size: outputBytes.length, digest: await put('blob', outputBytes)});
  }
  const manifest = {schemaVersion: 3, operationId, ...scope, entries, output: projected,
    treeDigest: computeContainedTurnArtifactTreeDigest(entries)};
  const manifestDigest = await put('manifest', encodeContainedTurnArtifactManifest(manifest));
  if (realStore) {assert.deepEqual((await store.verifyArtifact(manifestDigest)).manifest, manifest);}
  const workspaceName = `operation-${hash(JSON.stringify([scope.tenantId, scope.projectId, operationId]))}`;
  const resultRef = `urn:agent-runtime:contained-turn-result:${manifestDigest}`;
  const common = {manifestDigest, operationId, scope, treeDigest: manifest.treeDigest, workspaceName};
  const publication = {...common, schemaVersion: 1, resultRef,
    manifestReceiptRef: `urn:agent-runtime:artifact-manifest-sealed:${manifestDigest}`,
    resultReceiptRef: `urn:agent-runtime:result-published:${manifestDigest}`};
  for (const [directory, record] of [['artifacts/results', publication], ['workspaces/seals',
    {...common, schemaVersion: 2, rootIdentity: {dev: '1', ino: '1'}}]]) {
    mkdirSync(join(root, directory), {recursive: true, mode: 0o700});
    writeFileSync(join(root, directory, `${workspaceName}.json`), JSON.stringify(record));
  }
  const turn = {operationId, resultRef, artifactManifestRef: `urn:agent-runtime:artifact-manifest:${manifestDigest}`,
    status: 'succeeded', provider: 'codex', commandId: 'command:test', effectId: 'effect:test', revision: 2, output};
  const observations = [{status: 'observed', turn}];
  const input = {root, approval, operationId, observations};
  return {root, input, turn, manifest, manifestDigest, workspaceName,
    collect: () => collectLinuxCodexLiveEvidence(input),
    blobPath: digest => join(root, 'artifacts/blobs', digest.slice(0, 2), digest),
    manifestPath: join(root, 'artifacts/manifests', manifestDigest.slice(0, 2), manifestDigest)};
}

const realOptions = {skip: nativeAvailable ? false : 'Existing native filesystem-custody binary unavailable; no installation/build authorized'};
test('actual artifact store writes sharded manifest and blobs; public final and exact file prove marker', realOptions, async t => {
  const f = await fixture(t);
  const result = f.collect();
  assert.equal(result.markerObserved, true);
  assert.equal(result.records.filter(item => item.kind === 'artifact-receipt').length, 3);
  assert.ok(result.records.some(item => item.value.relativePath?.includes(`/manifests/${f.manifestDigest.slice(0, 2)}/`)));
  assert.deepEqual(f.input.observations, [{status: 'observed', turn: f.turn}]);
});
for (const [name, options] of [
  ['wrong approved path', {path: 'other.txt'}],
  ['output only', {path: null}],
  ['wrong file bytes', {content: `prefix ${approval.marker}\n`}],
  ['diagnostic only', {output: [{cursor: 0, kind: 'diagnostic', text: approval.marker}]}],
  ['assistant substring', {output: [{cursor: 0, kind: 'assistant', text: `Done: ${approval.marker}`}]}],
]) {
  test(`real store rejects ${name}`, realOptions, async t => {
    assert.equal((await fixture(t, options)).collect().markerObserved, false);
  });
}

// Corruption and no-follow tests are runnable even on a checkout without a built
// native addon. These are schema fixtures, not claimed as store-written evidence.
for (const [name, mutate] of [
  ['wrong operation', f => {f.input.operationId = 'other';}],
  ['missing public observations', f => {f.input.observations = [];}],
  ['input-shaped authority', f => {f.input.observations = [{operationId, output: f.turn.output, status: 'succeeded'}];}],
  ['unlinked result', f => {f.turn.resultRef += '0';}],
  ['public output mismatch', f => {f.turn.output = [{cursor: 0, kind: 'assistant', text: 'other'}];}],
  ['latest observation failed', f => {f.input.observations.push({status: 'observed', turn: {...f.turn, revision: 3, status: 'failed'}});}],
  ['manifest digest corruption', f => {writeFileSync(f.manifestPath, '{}');}],
  ['blob digest corruption', f => {writeFileSync(f.blobPath(f.manifest.entries[0].digest), 'wrong');}],
  ['unrelated blob corruption', f => {writeFileSync(f.blobPath(f.manifest.output[0].digest), 'wrong');}],
  ['wrong publication operation', f => {
    const path = join(f.root, 'artifacts/results', `${f.workspaceName}.json`);
    const record = JSON.parse(readFileSync(path)); record.operationId = 'other'; writeFileSync(path, JSON.stringify(record));
  }],
  ['missing seal', f => {rmSync(join(f.root, 'workspaces/seals', `${f.workspaceName}.json`));}],
  ['flat manifest layout', f => {renameSync(f.manifestPath, join(f.root, 'artifacts/manifests', f.manifestDigest));}],
  ['misplaced shard', f => {renameSync(join(f.root, 'artifacts/manifests', f.manifestDigest.slice(0, 2)), join(f.root, 'artifacts/manifests', f.manifestDigest.startsWith('00') ? '01' : '00'));}],
  ['symlinked category', f => {
    renameSync(join(f.root, 'artifacts/blobs'), join(f.root, 'saved')); symlinkSync('../saved', join(f.root, 'artifacts/blobs'));
  }],
  ['symlinked shard', f => {
    const shard = join(f.root, 'artifacts/blobs', f.manifest.entries[0].digest.slice(0, 2));
    renameSync(shard, join(f.root, 'saved')); symlinkSync('../../saved', shard);
  }],
  ['symlinked blob', f => {
    const path = f.blobPath(f.manifest.entries[0].digest); renameSync(path, join(f.root, 'saved')); symlinkSync(join(f.root, 'saved'), path);
  }],
  ['hardlinked blob', f => {linkSync(f.blobPath(f.manifest.entries[0].digest), join(f.root, 'alias'));}],
  ['oversized manifest', f => {truncateSync(f.manifestPath, 32 * 1024 * 1024 + 1);}],
  ['symlinked root', f => {symlinkSync(f.root, f.root + '-alias'); f.cleanup(f.root + '-alias'); f.input.root += '-alias';}],
]) {
  test(`fails closed: ${name}`, async t => {
    const f = await fixture(t, {realStore: false}); f.cleanup = path => t.after(() => rmSync(path, {force: true}));
    mutate(f); assert.equal(f.collect().markerObserved, false);
  });
}

test('schema decoder rejects a content-addressed manifest with invalid tree digest', async t => {
  const f = await fixture(t, {realStore: false});
  const record = JSON.parse(readFileSync(f.manifestPath)); record.treeDigest = '0'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(record)), id = hash(bytes);
  rmSync(f.manifestPath); mkdirSync(join(f.root, 'artifacts/manifests', id.slice(0, 2)), {recursive: true});
  writeFileSync(join(f.root, 'artifacts/manifests', id.slice(0, 2), id), bytes);
  assert.equal(f.collect().markerObserved, false);
});

test('schema fixture positive control (not real-store acceptance)', async t => {
  const f = await fixture(t, {realStore: false});
  assert.equal(f.collect().markerObserved, true);
});
for (const [name, options] of [
  ['wrong approved path', {path: 'other.txt'}], ['output only', {path: null}],
  ['file only', {output: []}], ['file substring', {content: `prefix ${approval.marker}\n`}],
  ['diagnostic only', {output: [{cursor: 0, kind: 'diagnostic', text: approval.marker}]}],
  ['assistant substring', {output: [{cursor: 0, kind: 'assistant', text: `Done: ${approval.marker}`}]}],
]) {
  test(`schema fixture rejects ${name}`, async t => {
    assert.equal((await fixture(t, {...options, realStore: false})).collect().markerObserved, false);
  });
}

test('bounds shard enumeration before attempting manifest reads', async t => {
  const f = await fixture(t, {realStore: false});
  const shard = join(f.root, 'artifacts/manifests/00'); mkdirSync(shard, {recursive: true});
  for (let index = 0; index < 4097; index++) {
    writeFileSync(join(shard, '00' + index.toString(16).padStart(62, '0')), '');
  }
  const result = f.collect();
  assert.equal(result.markerObserved, false);
  assert.equal(result.records.at(-1).kind, 'evidence-incomplete');
});

test('no writes or cleanup and deterministic records', async t => {
  const f = await fixture(t, {realStore: false});
  const before = readFileSync(f.manifestPath);
  const first = f.collect();
  assert.equal(first.markerObserved, true);
  assert.deepEqual(f.collect(), first);
  assert.deepEqual(readFileSync(f.manifestPath), before);
  assert.ok(existsSync(f.root));
});

test('unrelated parent entries do not invalidate retained artifact identities', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'ar69-evidence-parent-'));
  t.after(() => rmSync(parent, {recursive: true, force: true}));
  const f = await fixture(t, {realStore: false, parent});
  const original = fs.lstatSync;
  let changed = false;
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (!changed && String(path).endsWith('/' + basename(parent))) {
      changed = true;
      mkdirSync(join(parent, 'unrelated-owned-entry'));
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  assert.equal(f.collect().markerObserved, true);
  assert.equal(changed, true);
});
