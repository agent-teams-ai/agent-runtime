import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresDispatchAcceptanceStore, createDispatchAcceptanceFeature,
  createNodeSha256DispatchDigest } from '../dist/composition.js';
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
