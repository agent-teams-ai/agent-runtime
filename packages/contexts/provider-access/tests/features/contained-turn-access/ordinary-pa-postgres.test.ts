import { createOrdinaryAuthMetadata } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-capture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrdinaryPaStore, ordinaryPaDigest } from '../../../dist/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-store.js';
import { OrdinaryPaUnavailable, createPostgresOrdinaryProviderAccessOwner } from '../../../dist/composition.js';
import { createPostgresCredentialRenderingOwner } from '../../../dist/features/contained-turn-access/composition/postgres-credential-rendering-owner.js';
import type { OrdinaryPaBinding, OrdinaryCodexAuthCapture, MaterializationPostgresPool } from '../../../dist/composition.js';
import { renderingFixture } from './credential-rendering-test-fixture.ts';
const url = process.env.ORDINARY_PA_TEST_POSTGRES_URL;
const binding = (operationId: string): OrdinaryPaBinding => ({ operationId, attemptId: 'attempt-synthetic', tenantId: 'tenant-synthetic', projectId: 'project-synthetic',
  executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1' });

const facts = () => ({ generation: 1, accountId: 'synthetic-account', expiresAt: Date.now() + 59000 });

test('ordinary PA PostgreSQL grants, counters, retirement and original rendering authority', { skip: !url, timeout: 60000 }, async t => {
  const parsed = new URL(url!);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, 'localhost'); assert.equal(parsed.pathname, '/postgres');
  assert.deepEqual([...parsed.searchParams.keys()], ['host']); assert.match(parsed.searchParams.get('host')!, /^\/tmp\/ordinary-pa-pg-TEST-[a-zA-Z0-9_-]+$/);
  const { Pool } = await import('pg'); const pool = new Pool({ connectionString: url, max: 8 });
  t.after(() => pool.end());
  assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='provider_access'")).rowCount, 0, 'fresh disposable cluster only');
  const one = createOrdinaryPaStore(pool), two = createOrdinaryPaStore(pool);
  t.after(() => { one.dispose(); two.dispose(); });
  await Promise.all([one.migrate(), two.migrate()]);
  const exact = binding('operation-race'), selected = facts();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? one : two).consume(exact, selected)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, results.map(result => result.status === 'rejected' ? String(result.reason) : 'fulfilled').join('; '));
  const original = await one.observe(exact); assert.ok(original);
  assert.equal((await two.observe(exact))!.authority.ownerReceiptId, original.authority.ownerReceiptId);
  await assert.rejects(two.observe({ ...exact, attemptId: 'foreign-attempt' }));
  assert.equal(await two.observe({ ...exact, tenantId: 'foreign-tenant' }), undefined);
  const first = await one.beginRequest(exact, ordinaryPaDigest('first'), 5);
  await assert.rejects(two.beginRequest(exact, ordinaryPaDigest('next'), 4));
  await assert.rejects(one.retire(exact));
  await one.endRequest(exact, first, true);
  await assert.rejects(two.beginRequest(exact, ordinaryPaDigest('first'), 5));
  const second = await two.beginRequest(exact, ordinaryPaDigest('next'), 4); await two.endRequest(exact, second, true);
  const retired = await one.retire(exact); assert.ok(retired.retiredAt);
  const settled = await one.settle(exact, 'claim_committed');
  assert.equal((await two.settle(exact, 'claim_committed')).settlementReceiptId, settled.settlementReceiptId);
  await assert.rejects(two.settle(exact, 'abandoned_without_claim'));
  await assert.rejects(two.beginRequest(exact, ordinaryPaDigest('later'), 5));
  const observed = await two.observe(exact); assert.equal(observed!.requestsStarted, 2); assert.equal(observed!.requestsCompleted, 2);
  await assert.rejects(pool.query("UPDATE provider_access.ordinary_grant SET snapshot='{}'::jsonb"), /immutable/);
  await assert.rejects(pool.query('DELETE FROM provider_access.ordinary_grant'), /immutable/);
  await assert.rejects(pool.query('DELETE FROM provider_access.ordinary_request'), /immutable/);
  await assert.rejects(pool.query("UPDATE provider_access.ordinary_grant SET disposition=NULL,settlement_id=NULL"), /monotonic/);

  await t.test('actual capture metadata with fractional monotonic deadline persists as bigint expiry', async () => {
    const now = Date.now(), monotonicNow = 1234.375;
    const token = Buffer.from('synthetic.' + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600 })).toString('base64url') + '.unsigned');
    const accountId = Buffer.from('synthetic-account');
    try {
      const metadata = createOrdinaryAuthMetadata({ token, accountId }, { generation: 1, captureRef: 'synthetic-fractional',
        sourceIdentity: 'synthetic-source', deadline: monotonicNow + 49000.625 }, now, monotonicNow);
      assert.equal(metadata.expiresAt, now + 49000);
      assert.ok(metadata.expiresAt <= now + 60000);
      const saved = await one.consume(binding('operation-fractional-capture'), metadata);
      assert.equal(saved.authority.expiresAt, metadata.expiresAt);
    } finally { token.fill(0); accountId.fill(0); }
  });
  await t.test('lost consume COMMIT returns no fresh grant and readback preserves one pending grant', async () => {
    let lost = false;
    const wrapped: MaterializationPostgresPool = { async connect() {
      const client = await pool.connect();
      return { async query(sql, values) { const result = await client.query(sql, values); if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('synthetic lost ack'); } return result; }, release: discard => client.release(discard) };
    } };
    const uncertain = createOrdinaryPaStore(wrapped); const unknown = binding('operation-unknown');
    try { await assert.rejects(uncertain.consume(unknown, facts())); } finally { uncertain.dispose(); }
    assert.ok(await two.observe(unknown)); await assert.rejects(two.consume(unknown, facts()));
    const untouched = await two.observe(unknown); assert.equal(untouched!.requestsStarted, 0); assert.equal(untouched!.retiredAt, null);
  });
  await t.test('genuine PA renderer authority is identity-bearing across durable owner readbacks', async () => {
    const f = renderingFixture(); const a = createPostgresCredentialRenderingOwner(pool, f.selection);
    const b = createPostgresCredentialRenderingOwner(pool, f.selection);
    try {
      await a.control.migrate(); assert.equal(await a.control.replaceBinding(f.selection.binding, 0), 1);
      const token = Buffer.alloc(10); token.write('fixture-pa'); const accountId = Buffer.alloc(15); accountId.write('fixture-account');
      assert.equal(a.control.materialAdmission!.admit({ operationRef: f.selection.operationRef, recipe: f.selection.recipe,
        binding: f.selection.binding, fields: [{ name: 'token', valueBytes: token }, { name: 'accountId', valueBytes: accountId }] }).kind, 'admitted');
      const request = await f.request(); const permitted = await a.owner.authorization.authorize(request); assert.equal(permitted.kind, 'authorized');
      if (permitted.kind !== 'authorized') { throw new Error('expected original authority'); }
      assert.equal((await a.owner.rendering.render({ ...permitted.receipt })).kind, 'denied');
      const material = await a.owner.rendering.render(permitted.receipt); assert.equal(material.kind, 'rendered');
      if (material.kind === 'rendered') { material.credentials.release(); }
      const historical = await b.owner.authorization.observe({ authorizationRequestId: request.authorizationRequestId, requestDigest: request.requestDigest,
        tenantId: request.tenantId, projectId: request.projectId, scopeDigest: request.scopeDigest, provider: request.provider });
      assert.equal(historical.kind, 'observed');
      if (historical.kind === 'observed') { assert.equal((await b.owner.rendering.render(historical.receipt)).kind, 'denied'); }
    } finally { a.owner.dispose(); b.owner.dispose(); }
  });
  await t.test('synthetic capture materializes only loopback capability, registers secrets, retires and settles durably', async () => {
    const op = binding('operation-owner'), controller = new AbortController(), tokens: string[][] = [];
    const deadline = performance.now() + 50000;
    const synthetic: OrdinaryCodexAuthCapture = {
      settled: Promise.resolve(), dispose() {},
      async capture() { return { accountId: 'synthetic-account', generation: 1, captureRef: 'synthetic-capture', expiresAt: Date.now() + 49000,
        deadline, sourceIdentity: 'synthetic-source', modelObserved: true }; },
      withCredentialOutputTokens(operationId, consume) { assert.equal(operationId, op.operationId); assert.equal(consume(['synthetic-token', 'synthetic-account']), true); },
      admit(selection, admission) {
        const token = Buffer.alloc(15); token.write('synthetic-token'); const accountId = Buffer.alloc(17); accountId.write('synthetic-account');
        assert.equal(admission.admit({ operationRef: selection.operationRef, binding: selection.binding, recipe: selection.recipe,
          fields: [{ name: 'token', valueBytes: token }, { name: 'accountId', valueBytes: accountId }] }).kind, 'admitted');
      },
    };
    const lostAcks = new Set<string>();
    const lateAckPool: MaterializationPostgresPool = { async connect() {
      const client = await pool.connect(); let phase: string | undefined;
      return { async query(sql, values) {
        const result = await client.query(sql, values);
        if (sql.includes('SET retired_at=')) { phase = 'retire'; }
        if (sql.includes('SET disposition=')) { phase = 'settle'; }
        if (sql === 'COMMIT' && phase && !lostAcks.has(phase)) { lostAcks.add(phase); throw new Error('synthetic lost close ack'); }
        return result;
      }, release: discard => client.release(discard) };
    } };
    const owner = createPostgresOrdinaryProviderAccessOwner({ pool: lateAckPool, registerSecrets(operationId, secrets) { assert.equal(operationId, op.operationId); tokens.push([...secrets]); return true; } });
    try {
      await owner.migrate(); const grant = await owner.consume(op, synthetic, controller.signal); const material = await grant.materialize();
      assert.match(material.brokerEndpoint, /^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/);
      assert.equal(tokens.length, 1); assert.equal(tokens[0]!.length, 3);
      assert.deepEqual(Object.keys(material.environment), ['AR_ORDINARY_BROKER_CAPABILITY']);
      assert.equal(grant.admitCanonicalText(['synthetic-', 'token'].join('')), false);
      assert.equal(grant.admitArtifactBytes(Buffer.from('ordinary-session-ok\n')), true);
      await grant.retire(); const final = await grant.settle('abandoned_without_claim');
      assert.equal((await owner.observe(op))!.settlementReceiptId, final.settlementReceiptId);
      assert.deepEqual([...lostAcks].toSorted(), ['retire', 'settle']);
    } finally { await owner.dispose(); }
  });
});

test('public PA owner maps malformed bindings to its exported refusal and retires capture', async () => {
  let disposed = false;
  const owner = createPostgresOrdinaryProviderAccessOwner({pool: {async connect() {throw new Error('must not connect');}}, registerSecrets: () => true});
  const capture: OrdinaryCodexAuthCapture = {settled: Promise.resolve(), async capture() {throw new Error('must not capture');}, withCredentialOutputTokens() {}, admit() {}, dispose() {disposed = true;}};
  try {
    await assert.rejects(owner.consume({...binding('invalid'), operationId: ''}, capture, new AbortController().signal), error => error instanceof OrdinaryPaUnavailable);
    assert.equal(disposed, true);
    await assert.rejects(owner.observe({...binding('invalid'), attemptId: ''}), error => error instanceof OrdinaryPaUnavailable);
  } finally {await owner.dispose();}
});
