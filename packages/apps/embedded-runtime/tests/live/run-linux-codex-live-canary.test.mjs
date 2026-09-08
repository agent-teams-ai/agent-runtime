import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE, decodeBytes, validateConfiguration, createLinuxCodexLiveCanaryDriver} from './run-linux-codex-live-canary.mjs';
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
test('failed dedicated FD admission consumes durable attempt and never allows a second run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ar69-driver-'));
  try {
    mkdirSync(join(root, 'project'), {mode: 0o700});
    const driver = createLinuxCodexLiveCanaryDriver(config(root), 999999);
    const result = await driver.run();
    assert.equal(result.cleanup, 'released'); // No Pool or owner was constructed.
    const attempt = JSON.parse(readFileSync(join(root, 'evidence', 'attempt.json'), 'utf8'));
    assert.equal(attempt.actualSourceSHA, SOURCE);
    assert.equal(attempt.state, 'consumed-before-setup-no-retry');
    assert.ok(readdirSync(join(root, 'evidence')).some(name => name.endsWith('-unknown.json')));
    await assert.rejects(driver.run());
    assert.deepEqual(readdirSync(join(root, 'project')), []);
    assert.throws(() => createLinuxCodexLiveCanaryDriver({...config(root), ownerApproved: false}, 999999));
  } finally {rmSync(root, {recursive: true, force: true});}
});
