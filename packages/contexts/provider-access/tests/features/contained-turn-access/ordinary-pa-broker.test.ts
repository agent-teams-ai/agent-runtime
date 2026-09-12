import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createOrdinaryPaBroker } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-pa-broker.js';
import { createOrdinaryPaSecretGuard } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-pa-secret-guard.js';
import { renderingFixture } from './credential-rendering-test-fixture.ts';
import type { OrdinaryPaUpstream } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-pa-upstream.js';
import type { OrdinaryPaBinding } from '../../../dist/index.js';

const binding: OrdinaryPaBinding = { operationId: 'synthetic-operation', attemptId: 'synthetic-attempt', tenantId: 'synthetic-tenant', projectId: 'synthetic-project',
  executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1' };
const capabilityText = 'a'.repeat(64);
const bytes = async function* (value: string) { yield Buffer.from(value); };
const post = (endpoint: string, input: object, capability = capabilityText): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
  const body = JSON.stringify(input);
  const outgoing = request(endpoint + '/responses', { method: 'POST', agent: false, headers: {
    authorization: 'Bearer ' + capability, 'content-type': 'application/json', version: '0.153.4', 'content-length': Buffer.byteLength(body),
  } }, incoming => {
    let text = ''; incoming.on('data', chunk => { text += chunk.toString(); });
    incoming.on('end', () => resolve({ status: incoming.statusCode!, text })); incoming.on('error', reject);
  });
  outgoing.on('error', reject); outgoing.end(body);
});
async function fixture(upstream: OrdinaryPaUpstream, failBegin = false) {
  const f = renderingFixture(), renderer = f.create(), guard = createOrdinaryPaSecretGuard();
  const capability = Buffer.alloc(64); capability.write(capabilityText);
  guard.install(['fixture-pa', 'fixture-account', capabilityText]);
  const digests = new Set<string>(), ended: Array<{ sequence: number; success: boolean }> = [];
  let count = 0, original: object | undefined;
  const broker = await createOrdinaryPaBroker({ binding, selection: f.selection, capability, secretGuard: guard, upstream,
    renderer: { dispose: renderer.dispose, authorization: { ...renderer.authorization,
      async authorize(input) { const result = await renderer.authorization.authorize(input); if (result.kind === 'authorized') { original = result.receipt; } return result; },
    }, rendering: { render(receipt) { assert.equal(receipt, original, 'renderer requires original authority identity'); return renderer.rendering.render(receipt); } } },
    store: {
      async beginRequest(_binding, digest) {
        if (failBegin || digests.has(digest)) { throw new Error('synthetic consume refused'); }
        digests.add(digest); return ++count;
      },
      async endRequest(_binding, sequence, success) { ended.push({ sequence, success }); },
    },
  });
  return { broker, ended, async close() { await broker.close(); renderer.dispose(); guard.dispose(); capability.fill(0); } };
}
const payload = (text = 'first') => ({ model: 'gpt-5.3-codex-spark', stream: true, input: text });
test('ordinary broker keeps original PA receipt and admits sequential tool/model continuations', async t => {
  const headers: Readonly<Record<string, string>>[] = [];
  const f = await fixture({ async request(_body, value) { headers.push(value); return { status: 200, body: bytes('data: {"type":"response.completed"}\n\n'), close() {} }; } });
  t.after(() => f.close());
  assert.equal((await post(f.broker.endpoint, payload())).status, 200);
  assert.equal((await post(f.broker.endpoint, payload('continuation'))).status, 200);
  assert.equal(headers.length, 2);
  assert.equal(headers[0]!.authorization, 'Bearer fixture-pa');
  assert.equal(headers[0]!['chatgpt-account-id'], 'fixture-account');
  assert.ok(!Object.values(headers[0]!).includes('Bearer ' + capabilityText));
  assert.deepEqual(f.ended, [{ sequence: 1, success: true }, { sequence: 2, success: true }]);
});
for (const [label, upstream] of [
  ['503', { async request() { return { status: 503, body: bytes('secret upstream diagnostic'), close() {} }; } }],
  ['redirect', { async request() { return { status: 307, body: bytes('location elsewhere'), close() {} }; } }],
  ['connection failure', { async request() { throw new Error('secret upstream diagnostic'); } }],
] as const) {
  test(`ordinary broker closes admission after ${label} without retry or raw error`, async t => {
    let calls = 0;
    const f = await fixture({ request(...args) { calls += 1; return upstream.request(...args); } }); t.after(() => f.close());
    const result = await post(f.broker.endpoint, payload());
    assert.equal(result.status, 502); assert.equal(result.text, '{"error":"ordinary_provider_unavailable"}');
    assert.equal((await post(f.broker.endpoint, payload('next'))).status, 502);
    assert.equal(calls, 1); assert.deepEqual(f.ended, [{ sequence: 1, success: false }]);
  });
}
test('wrong capability and unknown durable consume never open upstream', async t => {
  let calls = 0;
  const upstream: OrdinaryPaUpstream = { async request() { calls += 1; throw new Error('must not open'); } };
  const wrong = await fixture(upstream); t.after(() => wrong.close());
  assert.equal((await post(wrong.broker.endpoint, payload(), 'wrong')).status, 502);
  const unknown = await fixture(upstream, true); t.after(() => unknown.close());
  assert.equal((await post(unknown.broker.endpoint, payload())).status, 502);
  assert.equal(calls, 0);
});
test('replayed body is refused; cumulative secret guard catches split output and complete artifact', async t => {
  let calls = 0;
  const f = await fixture({ async request() { calls += 1; return { status: 200, body: bytes('data: {}\n\n'), close() {} }; } }); t.after(() => f.close());
  assert.equal((await post(f.broker.endpoint, payload())).status, 200);
  assert.equal((await post(f.broker.endpoint, payload())).status, 502); assert.equal(calls, 1);
  const guard = createOrdinaryPaSecretGuard(); guard.install(['upstream-token', 'account-id', capabilityText]);
  assert.equal(guard.check('upstream-'), true); assert.equal(guard.check(['upstream-', 'token'].join('')), false);
  assert.equal(guard.artifact(Buffer.from('result upstream-token')), false);
  assert.equal(guard.artifact(Uint8Array.from([255])), false); guard.dispose();
  assert.equal(guard.check('clean'), false);
});
test('upstream secret in a bounded SSE response is never forwarded to the main process', async t => {
  const f = await fixture({ async request() { return { status: 200, body: bytes('data: {"text":"fixture-pa"}\n\n'), close() {} }; } }); t.after(() => f.close());
  const response = await post(f.broker.endpoint, payload()); assert.equal(response.status, 502); assert.ok(!response.text.includes('fixture-pa'));
});
