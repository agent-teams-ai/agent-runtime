import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {mkdtempSync, mkdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createLinuxCodexLiveCanaryDriver} from './run-linux-codex-live-canary.mjs';
import {join} from 'node:path';
export const SOURCE = '1'.repeat(40); // Explicit synthetic approved revision, never a runtime pin.

export const bytes = {encoding: 'base64', data: 'e30='};
export const config = root => ({ownerApproved: true, disposableDatabase: true, disposableTestParent: true,
  databaseUrl: 'postgresql://test@127.0.0.1:5432/ar69_pa_test_driver',
  evidenceDirectory: join(root, 'evidence'), approval: {commandId: 'command:driver', testId: 'driver', marker: 'hello', markerFile: 'marker.txt'},
  hostPins: {sourceRevision: SOURCE, testParent: join(root, 'project'), native: {catalogSource: bytes}, certificateAuthorities: [bytes]}});

// Public driver tests with explicit synthetic dependencies; these are not live E2E evidence.
export async function publicFixture(t, status = 'unknown') {
  const fs = (await import('node:fs')).default;
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
    './linux-codex-live-canary-config.ts': 'export function createLinuxCodexLiveCanaryConfiguration(a, p) {globalThis.ar69DriverFixture.validate?.(a, p);} export async function setupLinuxCodexLiveCanary() {globalThis.ar69DriverFixture.events.push("setup"); await globalThis.ar69DriverFixture.setup?.(); return globalThis.ar69DriverFixture.live;}',
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
