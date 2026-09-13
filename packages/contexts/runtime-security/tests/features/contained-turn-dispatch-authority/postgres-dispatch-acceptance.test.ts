import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresDispatchAcceptanceStore, createDispatchAcceptanceFeature,
  createNodeSha256DispatchDigest } from '../../../dist/composition.js';
import { createHarness, deferred, scope } from './postgres-dispatch.fixtures.ts';

const fixture = async () => {
  const f = createHarness();
  const decisions = createPostgresDispatchAcceptanceStore({ pool: f.db,
    connectTimeoutMs: 200, queryTimeoutMs: 500, transactionTimeoutMs: 2000 });
  await decisions.migrate();
  const intent = { scope, operationId: 'operation-a', providerId: 'provider-a',
    intentDigest: 'intent-a', policyRevision: 'revision-a' };
  const policy = { scope, providerId: intent.providerId, intentDigest: intent.intentDigest,
    policyRevision: intent.policyRevision, enabled: true, revoked: false,
    constraintsDigest: 'constraints-a', containmentPolicyDigest: 'containment-a',
    validFromControlTime: 0, claimBeforeControlTime: 200 };
  const deps = { decisions, repository: f.repository,
    policy: { async read() {return policy;} }, clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest() };
  const api = createDispatchAcceptanceFeature(deps);
  return { ...f, decisions, intent, deps, api };
};

test('acceptance uses insert-only PostgreSQL adapter and waits for COMMIT acknowledgement', async () => {
  const f = await fixture();
  const entered = deferred(); const release = deferred();
  f.db.hook = async (client, sql, _values, execute) => {
    if (sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
      event.sql.includes('INSERT INTO runtime_security_dispatch_acceptance_v1.decisions'))) {
      entered.resolve(); await release.promise;
    }
    return execute();
  };
  let returned = false;
  const pending = f.api.evaluateForAcceptance(f.intent).then(value => {returned = true; return value;});
  await entered.promise;
  assert.equal(returned, false);
  assert.equal(f.db.tables.decisions.size, 0);
  release.resolve();
  const first = await pending;
  assert.equal(first.status, 'allowed');
  f.db.hook = undefined;
  assert.deepEqual(await createDispatchAcceptanceFeature(f.deps).evaluateForAcceptance(f.intent), first);
  assert.equal(f.db.tables.decisions.size, 1);
  f.db.assertReleased();
});

test('lost acceptance COMMIT acknowledgement is indeterminate; exact replay recovers original evidence', async () => {
  const f = await fixture();
  f.db.hook = async (client, sql, _values, execute) => {
    const result = await execute();
    if (sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
      event.sql.includes('INSERT INTO runtime_security_dispatch_acceptance_v1.decisions'))) {
      throw new Error('lost ack');
    }
    return result;
  };
  assert.equal((await f.api.evaluateForAcceptance(f.intent)).status, 'indeterminate');
  assert.equal(f.db.tables.decisions.size, 1);
  f.db.hook = undefined;
  const retained = await f.decisions.read(f.intent);
  const result = await f.api.evaluateForAcceptance(f.intent);
  assert.equal(result.status, 'allowed');
  if (result.status === 'allowed') {assert.deepEqual(result.decision, retained);}
  f.db.assertReleased();
});

test('acceptance conflicts never overwrite the original scoped operation decision', async () => {
  const f = await fixture();
  const first = await f.api.evaluateForAcceptance(f.intent);
  assert.equal(first.status, 'allowed');
  if (first.status !== 'allowed') {throw new Error('expected acceptance');}
  const altered = { ...first.decision, intentDigest: 'other' };
  assert.deepEqual(await f.decisions.retain(altered), first.decision);
  assert.deepEqual(await f.decisions.read(f.intent), first.decision);
  assert.equal(f.db.tables.decisions.size, 1);
});

test('maximum Unicode selectors use fixed-width keys and preserve exact replay', async () => {
  const f = await fixture();
  let seed = 69;
  const identifier = () => Array.from({ length: 512 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(0x800 + (seed >>> 8) % 0xd000);
  }).join('');
  const intent = { ...f.intent, operationId: identifier(),
    scope: { tenantId: identifier(), projectId: identifier(), scopeDigest: identifier() } };
  assert.ok(Buffer.byteLength(JSON.stringify({ operationId: intent.operationId, scope: intent.scope })) > 6000);
  const policy = { ...await f.deps.policy.read(), scope: intent.scope };
  const deps = { ...f.deps, policy: { async read() {return policy;} } };
  const first = await createDispatchAcceptanceFeature(deps).evaluateForAcceptance(intent);
  assert.equal(first.status, 'allowed');
  assert.deepEqual(await createDispatchAcceptanceFeature(deps).evaluateForAcceptance(intent), first);
  if (first.status !== 'allowed') {throw new Error('expected Unicode acceptance');}
  assert.deepEqual(await f.decisions.read(intent), first.decision);
  const keys = f.db.events.filter(event => event.sql.includes('INSERT INTO runtime_security_dispatch_acceptance_v1.decisions'));
  assert.ok(keys.length > 0);
  for (const event of keys) {assert.match(String(event.values[0]), /^[a-f0-9]{64}$/u);}
  f.db.assertReleased();
});

test('retained full selector mismatch fails closed on read and retain', async () => {
  for (const field of ['operationId', 'tenantId', 'projectId', 'scopeDigest'] as const) {
    const f = await fixture();
    const accepted = await f.api.evaluateForAcceptance(f.intent);
    if (accepted.status !== 'allowed') {throw new Error('expected acceptance');}
    const foreign = field === 'operationId' ? { ...accepted.decision, operationId: 'foreign' } :
      { ...accepted.decision, scope: { ...accepted.decision.scope, [field]: 'foreign' } };
    // Simulate a hash collision or corrupted row returned under the requested key.
    for (const key of f.db.tables.decisions.keys()) {
      f.db.tables.decisions.set(key, { decision: JSON.stringify(foreign) });
    }
    await assert.rejects(f.decisions.read(f.intent), /owner unavailable/u);
    await assert.rejects(f.decisions.retain(accepted.decision), /owner unavailable/u);
    f.db.assertReleased();
  }
});
