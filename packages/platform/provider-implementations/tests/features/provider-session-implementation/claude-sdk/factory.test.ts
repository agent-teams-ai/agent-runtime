import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { DriverFactory, Event, OpenConfig } from '@agent-teams/agent-execution/interactive-contracts';
import { createClaudeDriverFactory } from '../../../../src/claude.ts';
import { configuration, QueryFixture, request } from './support.ts';

test('canonical DriverFactory uses a pinned Host projection and preserves runtime input/operation ownership', async () => {
  const sdk = new QueryFixture();
  const capabilities = ['text', 'permission'];
  let observed: OpenConfig | undefined;
  const c = configuration();
  const factory: DriverFactory = createClaudeDriverFactory({
    capabilities,
    resolveConfiguration: async value => { observed = value; return c; },
    readCheckpoint: async () => { throw new Error('fresh open must not read checkpoint'); },
  }, sdk.boundary);
  capabilities.push('not-qualified');
  const opened = await factory.open(request);
  assert.deepEqual(opened.capabilities, ['text', 'permission']);
  assert.deepEqual(observed, request);
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed?.requiredCapabilities));
  const events: Event[] = [];
  const observer = (async () => { for await (const event of opened.driver.observe()) { events.push(event); } })();
  try {
    c.model = 'later-mutation';
    const receipt = await opened.driver.submit({ inputId: 'input-1', operationRef: 'operation-1', content: 'test' });
    assert.deepEqual(receipt, { ok: true, value: { inputId: 'input-1', operationRef: 'operation-1', delivery: 'client-consumed', providerAcceptance: 'unknown' } });
    await setImmediate();
    assert.equal(sdk.options.model, 'fixture-model');
    sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs[0]?.uuid });
    await setImmediate();
    assert.ok(events.some(event => event.kind === 'result' && event.outcome === 'succeeded' && event.inputId === 'input-1' && event.operationRef === 'operation-1'));
  } finally { assert.equal((await opened.driver.close()).cleanup, 'confirmed'); await observer; }
});

test('unsupported capability and mismatched configuration reject before query construction', async () => {
  const sdk = new QueryFixture();
  let resolutions = 0;
  let c = configuration();
  const factory = createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => { resolutions++; return c; }, readCheckpoint: async () => {} }, sdk.boundary);
  await assert.rejects(factory.open({ ...request, requiredCapabilities: ['unqualified'] }), /claude.driver.unsupported/u);
  assert.equal(resolutions, 0);
  for (const bad of [{ ...c, sessionRef: 'other-session' }, { ...c, configRevision: 'other-revision' }]) {
    c = bad;
    await assert.rejects(factory.open(request), /claude.driver.invalid-config/u);
  }
  assert.equal(sdk.calls, 0);
});

test('restore reads only an explicit checkpoint reference and never falls back to a fresh native session', async () => {
  const sdk = new QueryFixture();
  let checkpoint: unknown;
  const reads: string[] = [];
  const factory = createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => configuration(), readCheckpoint: async reference => { reads.push(reference); return checkpoint; } }, sdk.boundary);
  await assert.rejects(factory.open({ ...request, checkpointRef: 'missing' }), /claude.driver.checkpoint-missing/u);
  assert.equal(sdk.calls, 0);
  const first = await factory.open(request);
  const cp = first.driver.checkpoint(); assert.ok(cp.ok);
  checkpoint = cp.value;
  const native = sdk.options.sessionId;
  await first.driver.close();
  // A new physical SDK iterator represents the caller-owned recovered execution.
  const restoredSdk = new QueryFixture();
  const restored = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => configuration(), readCheckpoint: async reference => { reads.push(reference); return checkpoint; } }, restoredSdk.boundary).open({ ...request, generation: 2, checkpointRef: 'original' });
  try {
    assert.equal(restoredSdk.options.resume, native);
    assert.equal(restoredSdk.options.sessionId, undefined);
    assert.deepEqual(reads, ['missing', 'original']);
  } finally { await restored.driver.close(); }
});

test('native team message/registry tools cannot bypass the external product authority', async () => {
  const sdk = new QueryFixture();
  for (const nativeTool of ['SendMessage', 'ListAgents', 'TeamCreate', 'TaskUpdate', 'Agent']) {
    const c = configuration(); c.nativeTools = [nativeTool];
    const factory = createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary);
    await assert.rejects(factory.open(request), /claude.driver.invalid-config/u);
  }
  assert.equal(sdk.calls, 0);
});

test('close during the awaited per-input readiness probe cannot release a late SDK handoff', async () => {
  const sdk = new QueryFixture(); const c = configuration();
  let finishProbe!: (healthy: boolean) => void; let probes = 0;
  const held = new Promise<boolean>(resolve => { finishProbe = resolve; });
  c.probe = () => { probes++; return probes === 1 ? Promise.resolve(true) : held; };
  const opened = await createClaudeDriverFactory({ capabilities: ['text'],
    resolveConfiguration: async () => c, readCheckpoint: async () => {},
  }, sdk.boundary).open(request);
  try {
    const submission = opened.driver.submit({ inputId: 'held-input', operationRef: 'held-operation', content: 'TEST' });
    await setImmediate(); assert.equal(probes, 2);
    const closing = opened.driver.close(); finishProbe(true);
    assert.deepEqual(await submission, { ok: false, code: 'unknown' });
    assert.equal((await closing).cleanup, 'confirmed'); await setImmediate();
    assert.equal(sdk.inputs.length, 0);
  } finally { finishProbe(false); await opened.driver.close(); }
});
