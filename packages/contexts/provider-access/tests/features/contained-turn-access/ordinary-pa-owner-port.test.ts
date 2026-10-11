import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrdinaryProviderAccessOwner } from '../../../dist/features/contained-turn-access/composition/ordinary-provider-access-owner.js';
import { newOrdinaryPaGrant } from '../../../dist/features/contained-turn-access/domain/ordinary-provider-access.js';
import type { OrdinaryPaGrantStore } from '../../../dist/features/contained-turn-access/application/ports/outbound/ordinary-pa-grant-store.js';
import type { OrdinaryPaMaterializationStores } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-pa-materialization-stores.js';
import type { OrdinaryCodexAuthCapture } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-contracts.js';
import type { OrdinaryPaBinding, OrdinaryPaSnapshot } from '../../../dist/composition.js';

const binding: OrdinaryPaBinding = { operationId: 'operation-port', attemptId: 'attempt-synthetic', tenantId: 'tenant-synthetic', projectId: 'project-synthetic',
  executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1' };
const materialization: OrdinaryPaMaterializationStores = { forOperation() { throw new Error('materialization is not used before materialize()'); } };
const capture = () => {
  let disposed = 0;
  const value: OrdinaryCodexAuthCapture = { settled: Promise.resolve(), dispose() { disposed += 1; },
    async capture() { return { accountId: 'synthetic-account', generation: 1, captureRef: 'synthetic-capture', expiresAt: Date.now() + 49_000,
      deadline: performance.now() + 50_000, sourceIdentity: 'synthetic-source', modelObserved: true }; },
    withCredentialOutputTokens() {}, admit() {} };
  return { value, disposed: () => disposed };
};
/** In-memory grant store that records calls and lets a test lose the answer of one write. */
function memoryGrants(options: { lose?: 'insertGrant' | 'retire' | 'settle'; reject?: boolean } = {}) {
  let current: OrdinaryPaSnapshot | undefined; const calls: string[] = [];
  const lose = (name: string) => { calls.push(name); if (options.lose === name) { throw new Error('synthetic lost acknowledgement'); } };
  const store: OrdinaryPaGrantStore = {
    async insertGrant(grant) {
      calls.push('insertGrant');
      if (options.reject || current) { return { kind: 'rejected' }; }
      current = { authority: grant.snapshot.authority, generation: grant.snapshot.generation, accountId: grant.snapshot.accountId, materializationId: grant.snapshot.materializationId,
        retiredAt: null, disposition: null, settlementReceiptId: null, requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0 };
      if (options.lose === 'insertGrant') { throw new Error('synthetic lost acknowledgement'); }
      return { kind: 'inserted', snapshot: current };
    },
    async observe() { calls.push('observe'); return current; },
    async retire() { current = { ...current!, retiredAt: current!.retiredAt ?? new Date().toISOString() }; lose('retire'); return current; },
    async settle(_binding, disposition, settlementId) {
      current = { ...current!, disposition, settlementReceiptId: settlementId }; lose('settle'); return current;
    },
    async beginRequest() { throw new Error('unused'); },
    async endRequest() { throw new Error('unused'); },
  };
  return { store, calls };
}
const owner = (grants: OrdinaryPaGrantStore) => createOrdinaryProviderAccessOwner({ grants, materialization, registerSecrets: () => true });

test('a rejected or unknown insert refuses consume, disposes the capture and never asks for a second grant', async () => {
  for (const options of [{ reject: true }, { lose: 'insertGrant' as const }]) {
    const { store, calls } = memoryGrants(options), probe = capture(), instance = owner(store);
    try {
      await assert.rejects(instance.consume(binding, probe.value, new AbortController().signal), { code: 'ORDINARY_PA_UNAVAILABLE' });
      assert.deepEqual(calls, ['insertGrant'], 'no readback and no retry');
      assert.ok(probe.disposed() >= 1);
    } finally { await instance.dispose(); }
  }
});

test('owner accepts a lost retire or settle acknowledgement only when the stored state matches', async () => {
  const { store, calls } = memoryGrants({ lose: 'retire' }), instance = owner(store);
  try {
    const grant = await instance.consume(binding, capture().value, new AbortController().signal);
    assert.ok((await grant.retire()).retiredAt, 'readback shows the retirement');
    assert.deepEqual(calls.filter(call => call === 'observe').length, 1);
  } finally { await instance.dispose(); }

  const settleLost = memoryGrants({ lose: 'settle' }), settling = owner(settleLost.store);
  try {
    const grant = await settling.consume(binding, capture().value, new AbortController().signal);
    await grant.retire();
    assert.equal((await grant.settle('claim_committed')).disposition, 'claim_committed');
  } finally { await settling.dispose(); }

  // A readback that does not show the requested disposition must not be accepted.
  const mismatch = memoryGrants(), mismatched = owner({ ...mismatch.store,
    async settle(exact, _disposition, settlementId) { await mismatch.store.settle(exact, 'claim_committed', settlementId); throw new Error('synthetic lost acknowledgement'); } });
  try {
    const grant = await mismatched.consume(binding, capture().value, new AbortController().signal);
    await grant.retire();
    await assert.rejects(grant.settle('abandoned_without_claim'), { code: 'ORDINARY_PA_UNAVAILABLE' });
  } finally { await mismatched.dispose(); }
});

test('domain candidate carries exactly what the port stores', () => {
  const grant = newOrdinaryPaGrant(binding, { generation: 1, accountId: 'synthetic-account', expiresAt: Date.now() + 30_000 },
    { now: Date.now(), newId: () => crypto.randomUUID(), digest: value => JSON.stringify(value) });
  assert.deepEqual(Object.keys(grant.snapshot), ['authority', 'generation', 'accountId', 'materializationId']);
});

/** Keyed in-memory grant store; `retire` is supplied by the test so it can block or fail per binding. */
function keyedGrants(retire: (binding: OrdinaryPaBinding, stamp: () => OrdinaryPaSnapshot) => Promise<OrdinaryPaSnapshot>) {
  const rows = new Map<string, OrdinaryPaSnapshot>();
  const store = {
    async insertGrant(grant) {
      const snapshot: OrdinaryPaSnapshot = { authority: grant.snapshot.authority, generation: grant.snapshot.generation, accountId: grant.snapshot.accountId,
        materializationId: grant.snapshot.materializationId, retiredAt: null, disposition: null, settlementReceiptId: null,
        requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0 };
      rows.set(grant.binding.operationId, snapshot);
      return { kind: 'inserted', snapshot };
    },
    async observe(exact) { return rows.get(exact.operationId); },
    async retire(exact) {
      return retire(exact, () => {
        const row = rows.get(exact.operationId)!, stamped = { ...row, retiredAt: row.retiredAt ?? new Date().toISOString() };
        rows.set(exact.operationId, stamped); return stamped;
      });
    },
    async settle() { throw new Error('unused'); },
    async beginRequest() { throw new Error('unused'); },
    async endRequest() { throw new Error('unused'); },
  } satisfies OrdinaryPaGrantStore;
  return { store, rows };
}
const consumeMany = (instance: ReturnType<typeof owner>, count: number) => Promise.all(Array.from({ length: count }, (_, index) =>
  instance.consume({ ...binding, operationId: `operation-grant-${index}` }, capture().value, new AbortController().signal)));

test('64 grants retire concurrently on dispose', { timeout: 10_000 }, async () => {
  let started = 0, running = 0, maxConcurrentRetirements = 0;
  const barrier = Promise.withResolvers<void>();
  const { store, rows } = keyedGrants(async (_exact, stamp) => {
    started += 1; running += 1; maxConcurrentRetirements = Math.max(maxConcurrentRetirements, running);
    if (started === 64) { barrier.resolve(); }
    await barrier.promise; running -= 1;
    return stamp();
  });
  const instance = owner(store);
  await consumeMany(instance, 64);
  await instance.dispose();
  assert.equal(maxConcurrentRetirements, 64);
  assert.ok([...rows.values()].every(row => row.retiredAt !== null));
});

test('one failing retirement is isolated and retried alone', async () => {
  let calls = 0, failed = false;
  const { store, rows } = keyedGrants(async (exact, stamp) => {
    calls += 1;
    if (exact.operationId === 'operation-grant-7' && !failed) { failed = true; throw new Error('synthetic retire failure'); }
    return stamp();
  });
  const instance = owner(store);
  await consumeMany(instance, 64);
  await assert.rejects(instance.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'ORDINARY_PA_UNAVAILABLE');
    assert.equal(error.errors.length, 1);
    return true;
  });
  assert.equal([...rows.values()].filter(row => row.retiredAt !== null).length, 63);
  await instance.dispose();
  assert.equal(calls, 65);
});
