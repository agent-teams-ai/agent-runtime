import assert from 'node:assert/strict';
import {test} from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {allocateLinuxCodexLiveAdminDirectories} from './linux-codex-live-admin-directories.ts';
import {encodeContainedTurnArtifactManifest, computeContainedTurnArtifactTreeDigest} from '../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-artifact-manifest.js';
import {decodeBytes, validateConfiguration, createLinuxCodexLiveCanaryDriver, createCleanupController, createRedactor} from './run-linux-codex-live-canary.mjs';
import {collectLinuxCodexLiveEvidence} from './linux-codex-live-evidence.mjs';
const SOURCE = '1'.repeat(40); // Explicit synthetic approved revision, never a runtime pin.

const bytes = {encoding: 'base64', data: 'e30='};
const config = root => ({ownerApproved: true, disposableDatabase: true, disposableTestParent: true,
  databaseUrl: 'postgresql://test@127.0.0.1:5432/ar69_pa_test_driver',
  evidenceDirectory: join(root, 'evidence'), approval: {commandId: 'command:driver', testId: 'driver', marker: 'hello', markerFile: 'marker.txt'},
  hostPins: {sourceRevision: SOURCE, testParent: join(root, 'project'), native: {catalogSource: bytes}, certificateAuthorities: [bytes]}});
test('explicit byte conversion rejects noncanonical or path inputs; owns dedicated arrays', () => {
  const a = decodeBytes(bytes), b = decodeBytes(bytes);
  assert.equal(Object.getPrototypeOf(a), Uint8Array.prototype);
  assert.notEqual(a.buffer, b.buffer);
  assert.equal(a.byteLength, a.buffer.byteLength);
  for (const value of ['/home/auth', {encoding: 'base64', data: 'e30'}, {encoding: 'base64', data: '!!!!'}]) {
    assert.throws(() => decodeBytes(value));
  }
});
test('DB guard refuses ambient, non-disposable and overridden targets before any I/O', () => {
  const c = config('/tmp/driver');
  assert.equal(validateConfiguration(c).hostPins.native.catalogSource.byteLength, 2);
  for (const url of ['postgresql://test@127.0.0.1:5432/postgres',
    c.databaseUrl + '?host=elsewhere', c.databaseUrl.replace('127.0.0.1', 'example.com'),
    c.databaseUrl.replace('test@', 'test:secret@')]) {
    assert.throws(() => validateConfiguration({...c, databaseUrl: url}));
  }
  assert.throws(() => createLinuxCodexLiveCanaryDriver(c, 0));
});
test('failed dedicated FD admission consumes durable attempt and never allows a second run', async t => {
  t.mock.method(childProcess, 'execFileSync', (_file, args) => args.includes('status') ? '' : SOURCE);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ar69-driver-')));
  try {
    mkdirSync(join(root, 'project'), {mode: 0o700});
    const driver = createLinuxCodexLiveCanaryDriver(config(root), 999999);
    assert.equal(await driver.cleanup(), 'pending'); // Admission has not acquired or released owners.
    const result = await driver.run();
    assert.equal(result.cleanup, 'released'); // No Pool or owner was constructed.
    const attempt = JSON.parse(readFileSync(join(root, 'evidence', 'attempt.json'), 'utf8'));
    assert.equal(attempt.actualSourceSHA, SOURCE);
    assert.equal(attempt.state, 'consumed-before-setup-no-retry');
    assert.ok(readdirSync(join(root, 'evidence')).some(name => name.endsWith('-unknown.json')));
    const savedAttempt = readFileSync(join(root, 'evidence', 'attempt.json'), 'utf8');
    await assert.rejects(driver.run());
    const anotherDriver = createLinuxCodexLiveCanaryDriver(config(root), 999999);
    await assert.rejects(anotherDriver.run());
    assert.equal(readFileSync(join(root, 'evidence', 'attempt.json'), 'utf8'), savedAttempt);
    assert.deepEqual(readdirSync(join(root, 'project')), []);
    assert.throws(() => createLinuxCodexLiveCanaryDriver({...config(root), ownerApproved: false}, 999999));
  } finally {rmSync(root, {recursive: true, force: true});}
});

// These owners model lifecycle uncertainty only, never provider execution or success.
function cleanupFixture(owner) {
  const events = [];
  let pool = true, evidenceAvailable = true;
  const controller = createCleanupController({
    collect() {events.push('collect'); if (!evidenceAvailable) {throw new Error('unavailable');}},
    getLive: () => owner, hasPool: () => pool,
    closePool: async () => {events.push('close-pool'); pool = false;},
    report: (kind, value) => {events.push({kind, value});}, getOperationId: () => 'operation:synthetic',
  });
  return {...controller, events, hasPool: () => pool, loseEvidence: () => {evidenceAvailable = false;}};
}
test('uncertain cleanup retains owners and pool; concurrent calls share one attempt until explicit retry', async () => {
  let finish, calls = 0;
  const fixture = cleanupFixture({directory: '/synthetic-unused', cleanup(call) {
    assert.ok(call.deadlineEpochMs > Date.now());
    assert.ok(call.signal instanceof AbortSignal);
    calls++;
    return new Promise(resolve => {finish = resolve;});
  }});
  const first = fixture.cleanup();
  assert.equal(fixture.cleanup(), first);
  assert.equal(calls, 1);
  finish('pending');
  assert.equal(await first, 'pending');
  assert.equal(fixture.hasPool(), true);
  assert.equal(fixture.isReleased(), false);
  const retry = fixture.cleanup();
  assert.equal(calls, 2);
  finish('released');
  assert.equal(await retry, 'released');
  assert.equal(fixture.hasPool(), false);
  assert.equal(fixture.isReleased(), true);
  assert.equal(await fixture.cleanup(), 'released');
  assert.equal(calls, 2);
  assert.equal(fixture.events.filter(value => value === 'close-pool').length, 1);
  assert.equal(fixture.events[0], 'collect');
});
test('throwing or absent cleanup and incomplete evidence retain the pool', async () => {
  for (const owner of [undefined, {cleanup() {throw new Error('unknown');}}]) {
    const fixture = cleanupFixture(owner);
    assert.equal(await fixture.cleanup(), 'pending');
    assert.equal(fixture.hasPool(), true);
    assert.equal(fixture.isReleased(), false);
  }
  let called = false;
  const fixture = cleanupFixture({cleanup() {called = true; return 'released';}});
  fixture.loseEvidence();
  assert.equal(await fixture.cleanup(), 'pending');
  assert.equal(called, false);
  assert.equal(fixture.hasPool(), true);
  assert.equal(fixture.events[1].kind, 'evidence-incomplete');
});
test('redaction covers plaintext, JSON escaping, base64, digest and URL encoding', () => {
  const token = 'synthetic-"token/with+escapes';
  const fields = {token, accountId: 'synthetic-account'};
  const redact = createRedactor(fields);
  for (const secret of Object.values(fields)) {
    for (const representation of [secret, JSON.stringify(secret).slice(1, -1),
      Buffer.from(secret).toString('base64'), encodeURIComponent(secret),
      createHash('sha256').update(secret).digest('hex')]) {
      assert.equal(redact(`prefix ${representation} suffix`), 'prefix [REDACTED] suffix');
    }
  }
  assert.equal(fields.token, token);
});

test('canonical alias inputs still fail the production private-directory guard', async t => {
  t.mock.method(childProcess, 'execFileSync', (_file, args) => args.includes('status') ? '' : SOURCE);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ar69-driver-alias-')));
  try {
    mkdirSync(join(root, 'project'), {mode: 0o700});
    symlinkSync(root, join(root, 'alias'), 'dir');
    const driver = createLinuxCodexLiveCanaryDriver(config(join(root, 'alias')), 999999);
    await assert.rejects(driver.run());
    assert.deepEqual(readdirSync(root).toSorted(), ['alias', 'project']);
    await assert.rejects(driver.run());
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('different approved revision and dirty tracked source reject before filesystem admission', async t => {
  let dirty = false;
  t.mock.method(childProcess, 'execFileSync', (_file, args) => args.includes('status') ? (dirty ? ' M tracked.ts' : '') : SOURCE);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const c = config('/nonexistent-ar69-admission-only');
  c.hostPins.sourceRevision = '2'.repeat(40);
  await assert.rejects(createLinuxCodexLiveCanaryDriver(c, 999999).run(), /Explicit disposable canary/u);
  c.hostPins.sourceRevision = SOURCE;
  dirty = true;
  await assert.rejects(createLinuxCodexLiveCanaryDriver(c, 999999).run(), /Explicit disposable canary/u);
});

// Public driver tests with explicit synthetic dependencies; these are not live E2E evidence.
async function publicFixture(t, status = 'unknown') {
  const fs = (await import('node:fs')).default;
  const {registerHooks} = await import('node:module');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ar69-public-driver-')));
  mkdirSync(join(root, 'project'), {mode: 0o700});
  const events = [], values = [];
  const state = {markerObserved: false, failReport: false};
  const turn = () => ({status: 'observed', turn: {status, operationId: 'operation:synthetic'}});
  const live = {directory: join(root, 'project'),
    async submit() {events.push('submit'); const value = turn(); values.push(value); return value;},
    async observe() {events.push('observe'); const value = turn(); values.push(value); return value;},
    async cancel() {events.push('cancel'); const value = turn(); values.push(value); return value;},
    async cleanup() {events.push('cleanup'); return 'released';}};
  globalThis.ar69DriverFixture = {live, events, collect(input) {
    assert.equal(input.root, join(live.directory, 'disposable'));
    assert.equal(input.approval.markerFile, 'marker.txt');
    assert.equal(input.operationId, 'operation:synthetic');
    assert.deepEqual(input.observations, values.slice(-512));
    for (let i = 0; i < input.observations.length; i++) {
      assert.equal(input.observations[i], values.slice(-512)[i]);
    }
    events.push('collect');
    return {markerObserved: state.markerObserved, records: [{kind: 'receipt', value: {synthetic: true}}]};
  }};
  const sources = {
    pg: 'export class Pool {on() {} async end() {globalThis.ar69DriverFixture.events.push("pool-end");}}',
    './linux-codex-live-canary-config.ts': 'export async function setupLinuxCodexLiveCanary() {globalThis.ar69DriverFixture.events.push("setup"); await globalThis.ar69DriverFixture.setup?.(); return globalThis.ar69DriverFixture.live;}',
    './linux-codex-live-evidence.mjs': 'export function collectLinuxCodexLiveEvidence(input) {return globalThis.ar69DriverFixture.collect(input);}',
  };
  const hooks = registerHooks({resolve(specifier, context, next) {
    return sources[specifier] ? {url: `ar69-fixture:${specifier}`, shortCircuit: true} : next(specifier, context);
  }, load(url, context, next) {
    return url.startsWith('ar69-fixture:') ? {format: 'module', source: sources[url.slice(13)], shortCircuit: true} : next(url, context);
  }});
  const credential = fs.openSync(join(root, 'credential'), 'wx+', 0o600);
  fs.writeSync(credential, JSON.stringify({token: 'synthetic-token', accountId: 'synthetic-account'}));
  const originalStat = fs.fstatSync, originalRead = fs.readSync, originalWrite = fs.writeFileSync;
  let readOffset = 0, credentialReading = true;
  t.mock.method(fs, 'fstatSync', (fd, ...args) => fd === credential && credentialReading ? {isFIFO: () => true} : originalStat(fd, ...args));
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const count = originalRead(fd, buffer, offset, length, fd === credential && credentialReading ? readOffset : position);
    if (fd === credential && credentialReading) {readOffset += count; if (!count) {credentialReading = false;}}
    return count;
  });
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (state.failReport && events.includes('submit')) {throw new Error('synthetic disk failure');}
    return originalWrite(...args);
  });
  t.mock.method(childProcess, 'execFileSync', (_file, args) => args.includes('status') ? '' : SOURCE);
  syncBuiltinESMExports();
  t.after(() => {
    hooks.deregister(); t.mock.restoreAll(); syncBuiltinESMExports();
    delete globalThis.ar69DriverFixture;
    rmSync(root, {recursive: true, force: true});
  });
  return {driver: createLinuxCodexLiveCanaryDriver(config(root), credential), events, state, root, credential, originalStat, live};
}

test('public unknown result retains observe/cancel until explicit cleanup', async t => {
  const {driver, events} = await publicFixture(t);
  const result = await driver.run();
  assert.equal(result.cleanup, 'pending');
  assert.ok(!events.includes('cleanup'));
  assert.equal((await driver.observe()).turn.status, 'unknown');
  assert.equal((await driver.cancel()).turn.status, 'unknown');
  for (let i = 0; i < 520; i++) {await driver.observe();}
  assert.equal(await driver.cleanup(), 'released');
  assert.deepEqual(events.slice(-3), ['collect', 'cleanup', 'pool-end']);
  assert.deepEqual(await driver.observe(), {status: 'unavailable'});
});
test('public succeeded result releases only after collected marker evidence', async t => {
  const {driver, events, state, root} = await publicFixture(t, 'succeeded');
  state.markerObserved = true;
  const result = await driver.run();
  assert.equal(result.cleanup, 'released');
  assert.equal(result.markerObserved, true);
  assert.ok(events.indexOf('collect') < events.indexOf('cleanup'));
  const receipt = readdirSync(join(root, 'evidence')).find(name => name.endsWith('-receipt.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'evidence', receipt))).value, {synthetic: true});
});
test('public report disk failure retains owners until persistence recovery permits explicit cleanup', async t => {
  const {driver, state, events, root} = await publicFixture(t, 'succeeded');
  state.markerObserved = true; state.failReport = true;
  const result = await driver.run();
  assert.equal(result.cleanup, 'pending');
  assert.equal(result.evidenceWriteFailed, true);
  assert.equal(result.operationId, 'operation:synthetic');
  assert.equal((await driver.observe()).turn.status, 'succeeded');
  assert.equal((await driver.cancel()).turn.status, 'succeeded');
  assert.equal(await driver.cleanup(), 'pending');
  assert.ok(!events.includes('cleanup'));
  assert.ok(!events.includes('pool-end'));
  state.failReport = false;
  const originalCleanup = globalThis.ar69DriverFixture.live.cleanup;
  globalThis.ar69DriverFixture.live.cleanup = async () => {
    const records = readdirSync(join(root, 'evidence')).filter(name => name !== 'attempt.json')
      .map(name => readFileSync(join(root, 'evidence', name), 'utf8')).filter(Boolean).map(JSON.parse);
    for (const kind of ['submit', 'observe', 'cancel', 'receipt', 'evidence-incomplete']) {
      assert.ok(records.some(record => record.kind === kind), `persisted ${kind} before disposal`);
    }
    return originalCleanup();
  };
  assert.equal(await driver.cleanup(), 'released');
  assert.equal(result.evidenceWriteFailed, true); // Historical failure is not cleared by recovery.
  assert.deepEqual(events.slice(-3), ['collect', 'cleanup', 'pool-end']);
  assert.equal(events.filter(event => event === 'submit').length, 1);
  await assert.rejects(driver.run());
});

test('first run closes credential once on wrong type, source, and filesystem failure; rerun preserves reused FD', async t => {
  const fs = (await import('node:fs')).default;
  let source = SOURCE;
  t.mock.method(childProcess, 'execFileSync', (_file, args) => args.includes('status') ? '' : source);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  for (const failure of ['type', 'source', 'filesystem']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ar69-fd-driver-')));
    try {
      mkdirSync(join(root, 'project'), {mode: 0o700});
      const fd = fs.openSync(join(root, 'credential'), 'wx', 0o600);
      source = failure === 'source' ? '2'.repeat(40) : SOURCE;
      const c = config(root);
      if (failure === 'filesystem') {c.hostPins.testParent = join(root, 'missing');}
      const driver = createLinuxCodexLiveCanaryDriver(c, fd);
      if (failure === 'type') {await driver.run();} else {await assert.rejects(driver.run());}
      assert.throws(() => fs.fstatSync(fd), {code: 'EBADF'});
      const reused = fs.openSync(join(root, 'credential'), 'r');
      try {
        assert.equal(reused, fd);
        await assert.rejects(driver.run());
        assert.ok(fs.fstatSync(reused).isFile());
      } finally {fs.closeSync(reused);}
    } finally {rmSync(root, {recursive: true, force: true});}
  }
});

test('evidence parent fsync failure prevents setup and closes the credential', async t => {
  const fs = (await import('node:fs')).default;
  const {driver, events, root} = await publicFixture(t);
  const originalOpen = fs.openSync, originalSync = fs.fsyncSync;
  let parentFd;
  t.mock.method(fs, 'openSync', (path, ...args) => {
    const fd = originalOpen(path, ...args);
    if (path === root) {parentFd = fd;}
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fd === parentFd) {throw new Error('synthetic parent fsync failure');}
    return originalSync(fd);
  });
  syncBuiltinESMExports();
  await assert.rejects(driver.run(), /parent fsync failure/u);
  assert.deepEqual(events, []);
  assert.deepEqual(readdirSync(join(root, 'evidence')), []);
});

test('credential read failure closes its descriptor without double closing a reused number', async t => {
  const fs = (await import('node:fs')).default;
  const {driver, events, credential, originalStat} = await publicFixture(t);
  const originalClose = fs.closeSync, originalRead = fs.readSync;
  let credentialClosed = false, invalidCloses = 0;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    if (fd === credential && !credentialClosed) {throw new Error('synthetic read failure');}
    return originalRead(fd, ...args);
  });
  t.mock.method(fs, 'closeSync', fd => {
    if (fd === credential) {credentialClosed = true;}
    try {return originalClose(fd);} catch (error) {invalidCloses++; throw error;}
  });
  syncBuiltinESMExports();
  const result = await driver.run();
  assert.equal(result.cleanup, 'released');
  assert.equal(credentialClosed, true);
  assert.equal(invalidCloses, 0);
  assert.throws(() => originalStat(credential), {code: 'EBADF'});
  assert.deepEqual(events, []);
});

test('running public result retains access after polling deadline', async t => {
  const {driver, events} = await publicFixture(t, 'running');
  let now = 0;
  t.mock.method(Date, 'now', () => {now += 180_001; return now;});
  const result = await driver.run();
  assert.equal(result.cleanup, 'pending');
  assert.equal((await driver.observe()).turn.status, 'running');
  assert.equal((await driver.cancel()).turn.status, 'running');
  assert.ok(!events.includes('cleanup'));
  assert.equal(await driver.cleanup(), 'released');
});
test('succeeded without collected marker evidence retains the public owner', async t => {
  const {driver, events} = await publicFixture(t, 'succeeded');
  const result = await driver.run();
  assert.equal(result.cleanup, 'pending');
  assert.equal(result.markerObserved, false);
  assert.ok(!events.includes('cleanup'));
  assert.equal((await driver.observe()).turn.status, 'succeeded');
  assert.equal(await driver.cleanup(), 'released');
});

test('failed observation cannot release on a stale succeeded submit value', async t => {
  const {driver, events, state, live} = await publicFixture(t, 'succeeded');
  state.markerObserved = true;
  live.observe = async () => {throw new Error('synthetic observation failure');};
  const result = await driver.run();
  assert.equal(result.observedStatus, 'unknown');
  assert.equal(result.cleanup, 'pending');
  assert.ok(!events.includes('cleanup'));
  assert.equal((await driver.cancel()).turn.status, 'succeeded');
  assert.equal(await driver.cleanup(), 'released');
});

test('public driver collects real admin layout before tree release (synthetic artifact bytes)', {skip: process.platform !== 'linux' && 'descriptor-relative collector requires Linux'}, async t => {
  const {writeFileSync, existsSync} = await import('node:fs');
  const {driver, root, live, events} = await publicFixture(t, 'succeeded');
  let tree;
  globalThis.ar69DriverFixture.setup = async () => {
    tree = await allocateLinuxCodexLiveAdminDirectories(join(root, 'project'));
    live.directory = tree.root; // The administrative entrypoint exposes this exact boundary.
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const put = (category, bytes) => {
      const id = hash(bytes), shard = join(tree.artifacts.root, category, id.slice(0, 2));
      mkdirSync(shard, {recursive: true, mode: 0o700});
      writeFileSync(join(shard, id), bytes);
      return id;
    };
    const operationId = 'operation:synthetic', scope = {tenantId: 'tenant:test', projectId: 'project:test'};
    const entries = [{kind: 'file', path: 'marker.txt', mode: 0o600, size: 6,
      digest: put('blobs', Buffer.from('hello\n'))}];
    const output = [{cursor: 0, kind: 'assistant', text: 'hello'}];
    const manifest = {schemaVersion: 3, operationId, ...scope, entries,
      output: [{cursor: 0, kind: 'assistant', size: 5, digest: put('blobs', Buffer.from('hello'))}],
      treeDigest: computeContainedTurnArtifactTreeDigest(entries)};
    const manifestDigest = put('manifests', encodeContainedTurnArtifactManifest(manifest));
    const workspaceName = `operation-${hash(JSON.stringify([scope.tenantId, scope.projectId, operationId]))}`;
    const resultRef = `urn:agent-runtime:contained-turn-result:${manifestDigest}`;
    const common = {operationId, scope, manifestDigest, workspaceName, treeDigest: manifest.treeDigest};
    for (const [path, value] of [
      [join(tree.artifacts.root, 'results'), {...common, schemaVersion: 1, resultRef,
        manifestReceiptRef: `urn:agent-runtime:artifact-manifest-sealed:${manifestDigest}`,
        resultReceiptRef: `urn:agent-runtime:result-published:${manifestDigest}`}],
      [join(tree.workspace.root, 'seals'), {...common, schemaVersion: 2, rootIdentity: {dev: '1', ino: '1'}}],
    ]) {
      mkdirSync(path, {recursive: true, mode: 0o700});
      writeFileSync(join(path, `${workspaceName}.json`), JSON.stringify(value));
    }
    const observation = {status: 'observed', turn: {operationId, status: 'succeeded', provider: 'codex',
      revision: 2, output, resultRef, artifactManifestRef: `urn:agent-runtime:artifact-manifest:${manifestDigest}`}};
    live.submit = async () => {events.push('submit'); return observation;};
    live.observe = async () => {events.push('observe'); return observation;};
    // Real collector and real directory allocator: no mock can normalize the wrong root.
    globalThis.ar69DriverFixture.collect = input => collectLinuxCodexLiveEvidence(input);
    assert.equal(collectLinuxCodexLiveEvidence({root: tree.root, approval: config(root).approval,
      operationId, observations: [observation]}).markerObserved, false);
    live.cleanup = async () => {
      const saved = readdirSync(join(root, 'evidence')).filter(name => name.endsWith('-artifact-receipt.json'));
      assert.equal(saved.length, 6); // Initial collection and pre-release collection.
      assert.ok(existsSync(tree.artifacts.root));
      events.push('cleanup');
      return tree.releaseAfterBootstrap(async () => 'released'); // Synthetic bootstrap owner only.
    };
  };
  const result = await driver.run();
  assert.equal(result.markerObserved, true);
  assert.equal(result.cleanup, 'released');
  assert.equal(existsSync(tree.root), false);
  assert.deepEqual(events, ['setup', 'submit', 'observe', 'cleanup', 'pool-end']);
});
