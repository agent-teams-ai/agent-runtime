import assert from 'node:assert/strict';
import {test} from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {decodeBytes, validateConfiguration, createLinuxCodexLiveCanaryDriver, createCleanupController, createRedactor} from './run-linux-codex-live-canary.mjs';
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
