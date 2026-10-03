import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { decideOrdinaryPaBeginRequest, decideOrdinaryPaEndRequest, decideOrdinaryPaRetire, decideOrdinaryPaSettle, newOrdinaryPaGrant,
  snapshotOrdinaryPaRequest } from '../../../dist/features/contained-turn-access/domain/ordinary-provider-access.js';
import type { OrdinaryPaBinding, OrdinaryPaSnapshot } from '../../../dist/composition.js';

const binding: OrdinaryPaBinding = { operationId: 'operation-decision', attemptId: 'attempt-synthetic', tenantId: 'tenant-synthetic', projectId: 'project-synthetic',
  executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1' };
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = 1_000_000;
/** No stored row for the binding. */
const absent: OrdinaryPaSnapshot | undefined = new Map<string, OrdinaryPaSnapshot>().get('none');
const environment = () => { let next = 0; return { now, newId: () => `id-${++next}`, digest }; };
const selected = { generation: 1, accountId: 'synthetic-account', expiresAt: now + 59_000 };
const state = (patch: Partial<OrdinaryPaSnapshot> = {}): OrdinaryPaSnapshot => {
  const grant = newOrdinaryPaGrant(binding, selected, environment());
  return { authority: grant.snapshot.authority, generation: 1, accountId: 'synthetic-account', materializationId: grant.snapshot.materializationId,
    retiredAt: null, disposition: null, settlementReceiptId: null, requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0, ...patch };
};

test('new grant candidate refuses an expired, over-long or malformed selection and never reuses an id', () => {
  const refuse = (patch: Partial<typeof selected>) => assert.throws(() => newOrdinaryPaGrant(binding, { ...selected, ...patch }, environment()), { code: 'ORDINARY_PA_UNAVAILABLE' });
  refuse({ expiresAt: now }); refuse({ expiresAt: now - 1 }); refuse({ expiresAt: now + 60_001 });
  refuse({ generation: 0 }); refuse({ generation: 1.5 }); refuse({ accountId: '' }); refuse({ accountId: 'a'.repeat(257) });
  assert.throws(() => newOrdinaryPaGrant({ ...binding, tenantId: '' }, selected, environment()), { code: 'ORDINARY_PA_UNAVAILABLE' });
  const grant = newOrdinaryPaGrant(binding, { ...selected, expiresAt: now + 60_000 }, environment());
  assert.equal(new Set([grant.snapshot.authority.grantId, grant.snapshot.authority.ownerReceiptId, grant.snapshot.materializationId]).size, 3);
  assert.equal(grant.expiresAt, grant.snapshot.authority.expiresAt);
});

test('retire needs every started request ended and keeps the first retirement', () => {
  assert.equal(decideOrdinaryPaRetire(absent).kind, 'refused');
  assert.equal(decideOrdinaryPaRetire(state({ requestsStarted: 1 })).kind, 'refused');
  assert.equal(decideOrdinaryPaRetire(state({ requestsStarted: 2, requestsCompleted: 1 })).kind, 'refused');
  assert.equal(decideOrdinaryPaRetire(state({ requestsStarted: 2, requestsCompleted: 1, requestsFailed: 1 })).kind, 'write');
  assert.equal(decideOrdinaryPaRetire(state({ retiredAt: '2026-10-02T00:00:00.000Z' })).kind, 'keep');
});

test('settle needs retirement, repeats the same disposition and refuses a different one', () => {
  const retiredAt = '2026-10-02T00:00:00.000Z';
  assert.equal(decideOrdinaryPaSettle(absent, 'claim_committed').kind, 'refused');
  assert.equal(decideOrdinaryPaSettle(state(), 'claim_committed').kind, 'refused');
  assert.equal(decideOrdinaryPaSettle(state({ retiredAt }), 'claim_committed').kind, 'write');
  const settled = state({ retiredAt, disposition: 'claim_committed', settlementReceiptId: 'receipt' });
  assert.equal(decideOrdinaryPaSettle(settled, 'claim_committed').kind, 'keep');
  assert.equal(decideOrdinaryPaSettle(settled, 'abandoned_without_claim').kind, 'refused');
});

test('request begin is monotonic, one at a time, capped at 64 and closed by retirement, settlement, failure and expiry', () => {
  const begin = (patch: Partial<OrdinaryPaSnapshot>, at = now) => decideOrdinaryPaBeginRequest(state(patch), at);
  assert.deepEqual(begin({}), { kind: 'begin', sequence: 1 });
  assert.deepEqual(begin({ requestsStarted: 5, requestsCompleted: 5 }), { kind: 'begin', sequence: 6 });
  assert.equal(begin({ requestsStarted: 1 }).kind, 'refused', 'previous request still started');
  assert.equal(begin({ requestsStarted: 1, requestsCompleted: 1, retiredAt: '2026-10-02T00:00:00.000Z' }).kind, 'refused');
  assert.equal(begin({ requestsStarted: 1, requestsCompleted: 1, retiredAt: 'x', disposition: 'claim_committed', settlementReceiptId: 'r' }).kind, 'refused');
  assert.equal(begin({ requestsStarted: 1, requestsFailed: 1 }).kind, 'refused');
  assert.equal(begin({ requestsStarted: 63, requestsCompleted: 63 }).kind, 'begin');
  assert.equal(begin({ requestsStarted: 64, requestsCompleted: 64 }).kind, 'refused', 'request 65');
  assert.equal(begin({}, selected.expiresAt).kind, 'refused', 'expired grant');
  assert.equal(decideOrdinaryPaBeginRequest(absent, now).kind, 'refused');
});

test('request end accepts only the newest started request, once', () => {
  assert.equal(decideOrdinaryPaEndRequest(state({ requestsStarted: 2, requestsCompleted: 1 }), 2).kind, 'end');
  assert.equal(decideOrdinaryPaEndRequest(state({ requestsStarted: 2, requestsCompleted: 1 }), 1).kind, 'refused');
  assert.equal(decideOrdinaryPaEndRequest(state({ requestsStarted: 2, requestsCompleted: 2 }), 2).kind, 'refused', 'already ended');
  assert.equal(decideOrdinaryPaEndRequest(state({ requestsStarted: 1 }), 0).kind, 'refused');
  assert.equal(decideOrdinaryPaEndRequest(state({ requestsStarted: 1 }), 1.5).kind, 'refused');
  assert.equal(decideOrdinaryPaEndRequest(absent, 1).kind, 'refused');
});

test('request facts need a sha256 digest and a bounded positive size', () => {
  const good = 'sha256:' + 'a'.repeat(64);
  assert.deepEqual(snapshotOrdinaryPaRequest({ bodyDigest: good, byteLength: 1_048_576 }), { bodyDigest: good, byteLength: 1_048_576 });
  for (const bad of [{ bodyDigest: 'sha256:short', byteLength: 5 }, { bodyDigest: good, byteLength: 0 }, { bodyDigest: good, byteLength: 1_048_577 }, { bodyDigest: good, byteLength: 1.5 }]) {
    assert.throws(() => snapshotOrdinaryPaRequest(bad), { code: 'ORDINARY_PA_UNAVAILABLE' });
  }
});
