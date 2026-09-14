import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import {PassThrough} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {createAgentRuntimeHost} from '../dist/composition/agent-runtime-host.js';
import {OrdinaryCodexAuthCleanupIndeterminate} from '../../../contexts/provider-access/dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-contracts.js';

function forbidden(): never {throw new Error('TEST unexpected external action');}

test('real Host retains the real auth capture after indeterminate helper cleanup settles', async t => {
  let retained = 0;
  t.mock.module('../../../contexts/provider-access/dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-files.js', {namedExports: {
    async prepareAuthFiles() {return {home: '/TEST/private', sourceIdentity: 'TEST-source', async check() {}, async retain() {retained += 1;}, cleanup: forbidden};},
    authHelperArguments: () => [],
  }});
  const child = new childProcess.ChildProcess(); child.pid = 424242;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let spawns = 0, signals = 0, gone = false;
  t.mock.method(childProcess, 'spawn', () => {spawns += 1; return child;});
  t.mock.method(process, 'kill', (_pid, signal) => {
    assert.equal(_pid, -424242);
    if (signal !== 0) {signals += 1;}
    if (gone) {throw Object.assign(new Error('TEST absent group'), {code: 'ESRCH'});}
    return true;
  });
  // Advance only the monotonic observation clock; no real helper or long deadline wait.
  let now = 0; t.mock.method(performance, 'now', () => {now += 1000; return now;});
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const {createOrdinaryCodexAuthCapture} = await import('../../../contexts/provider-access/dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-capture.js');
  const {createPostgresOrdinaryProviderAccessOwner} = await import('../../../contexts/provider-access/dist/composition.js');
  const capture = createOrdinaryCodexAuthCapture({operationRef: 'TEST-operation', executable: '/TEST/absent', sourceDirectory: '/TEST/source', privateRoot: '/TEST/private', generation: 1, signal: new AbortController().signal, deadline: performance.now() + 20000,
    record: observation => {if (observation.outcome === 'started') {throw new Error('TEST journal failure');}},
  });
  const owner = createPostgresOrdinaryProviderAccessOwner({pool: {connect: forbidden}, registerSecrets: () => true});
  const host = createAgentRuntimeHost({
    codexSetup: {authorizeSetupInspection: {execute: forbidden}, discoverCodexInstallations: {execute: forbidden}, inspectCodexConfiguration: {execute: forbidden}, planCodexSetupInspection: {plan: forbidden}},
    claudeCodeSetup: {authorizeClaudeCodeSetupInspection: {execute: forbidden}, discoverClaudeCodeInstallations: {execute: forbidden}, inspectClaudeCodeConfiguration: {execute: forbidden}, planClaudeCodeSetupInspection: {plan: forbidden}},
  }, owner);
  await assert.rejects(owner.consume({tenantId: 'TEST', projectId: 'TEST', operationId: 'TEST-operation', attemptId: 'TEST-attempt', executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1'}, capture, new AbortController().signal), OrdinaryCodexAuthCleanupIndeterminate);
  await capture.settled;
  assert.equal(retained, 1); assert.equal(spawns, 1);
  const incomplete = (error: unknown) => error instanceof AggregateError && error.errors.some(cause => cause instanceof OrdinaryCodexAuthCleanupIndeterminate);
  await assert.rejects(host.dispose(), incomplete);
  child.emit('exit', 0);
  const signalled = signals;
  await assert.rejects(host.dispose(), incomplete);
  assert.equal(signals, signalled, 'never signal a group after leader exit');
  child.emit('close', 0); gone = true;
  await host.dispose(); await host.dispose(); await owner.dispose();
  assert.equal(signals, signalled); assert.equal(spawns, 1);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('close'), 0);
});
