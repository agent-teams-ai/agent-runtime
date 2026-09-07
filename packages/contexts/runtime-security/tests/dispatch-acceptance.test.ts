import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchAcceptanceFeature, createNodeSha256DispatchDigest } from '../dist/composition.js';
import type { DispatchAcceptanceDecision, DispatchAcceptancePolicy, DispatchAcceptanceIntent,
  DispatchAcceptanceStore } from '../dist/composition.js';
import { createHarness, deferred, input, scope, operation, settlement } from './postgres-dispatch.fixtures.ts';

const intent: DispatchAcceptanceIntent = { operationId: 'operation-a', scope,
  providerId: 'provider-a', intentDigest: 'intent-a', policyRevision: 'authority-revision-7' };
const rule: DispatchAcceptancePolicy = { scope, providerId: intent.providerId,
  intentDigest: intent.intentDigest, policyRevision: intent.policyRevision,
  enabled: true, revoked: false, constraintsDigest: 'constraints-digest-a',
  containmentPolicyDigest: 'containment-policy-digest-a', validFromControlTime: 50,
  claimBeforeControlTime: 200 };
const fixture = async () => {
  const pg = createHarness();
  await pg.repository.migrate();
  let now = 100;
  let policy: DispatchAcceptancePolicy | undefined = rule;
  const retained = new Map<string, DispatchAcceptanceDecision>();
  const key = (value: DispatchAcceptanceIntent) => JSON.stringify([value.scope, value.operationId]);
  const decisions: DispatchAcceptanceStore = {
    async read(value) {return retained.get(key(value));},
    async retain(value) {
      const prior = retained.get(key(value));
      if (prior !== undefined) {return prior;}
      retained.set(key(value), structuredClone(value));
      return value;
    },
  };
  const deps = { repository: pg.repository, decisions, policy: { async read() {return policy;} },
    clock: { now: () => now }, digest: createNodeSha256DispatchDigest() };
  const api = createDispatchAcceptanceFeature(deps);
  const allowed = await api.evaluateForAcceptance(intent);
  assert.equal(allowed.status, 'allowed');
  if (allowed.status !== 'allowed') {throw new Error('expected scoped acceptance');}
  const request = input({ acceptedAuthorityDigest: allowed.decision.decisionDigest,
    expectedAuthorityHeadDigest: allowed.decision.decisionDigest });
  const prepared = { acceptance: intent, decisionDigest: allowed.decision.decisionDigest,
    authorityGeneration: request.authorityGeneration, providerBindingDigest: request.providerBindingDigest,
    claimBindingDigest: request.claimBindingDigest, requestDigest: request.requestDigest,
    grantRequestId: request.grantRequestId };
  return { ...pg, api, deps, prepared, request, allowed,
    setPolicy: (value: DispatchAcceptancePolicy | undefined) => {policy = value;},
    setNow: (value: number) => {now = value; pg.setTime(value);} };
};

test('scoped policy produces a retained decision; restart and replay preserve identity/deadline', async () => {
  const f = await fixture();
  f.setNow(150);
  assert.deepEqual(await createDispatchAcceptanceFeature(f.deps).evaluateForAcceptance(intent), f.allowed);
  const result = await f.api.publishAndConsumeForDispatch(f.prepared, f.request);
  assert.equal(result.status, 'consumed');
  if (result.status === 'consumed') {
    assert.equal(result.receipt.claimBeforeControlTime, 200);
    assert.equal(result.receipt.authorityHeadDigestAtConsumption, f.allowed.decision.decisionDigest);
    assert.equal((await f.api.settleDispatchConsumption(settlement(result.receipt.consumptionDigest))).status, 'settled');
  }
  f.setNow(250);
  await f.repository.revokeAuthority(operation(f.request), '1');
  assert.deepEqual(await f.api.publishAndConsumeForDispatch(f.prepared, f.request), result);
  assert.equal((await f.repository.readAuthority(operation(f.request))).headVersion, '2');
  f.db.assertReleased();
});

test('unknown scope/provider/intent/revision and disabled/expired/revoked/unavailable policy fail closed', async () => {
  const f = await fixture();
  for (const change of [{ scope: { ...scope, tenantId: 'other' } },
    { providerId: 'other' }, { intentDigest: 'other' }, { policyRevision: 'other' }]) {
    assert.equal((await f.api.evaluateForAcceptance({ ...intent, ...change })).status, 'denied');
  }
  for (const policy of [undefined, { ...rule, enabled: false }, { ...rule, revoked: true },
    { ...rule, validFromControlTime: 101 }, { ...rule, claimBeforeControlTime: 100 }]) {
    f.setPolicy(policy);
    assert.equal((await f.api.evaluateForAcceptance(intent)).status, 'denied');
    assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'indeterminate');
  }
  assert.equal(f.db.tables.authority_heads.size, 0);
  assert.equal(f.db.tables.consumptions.size, 0);
});

test('each substituted request fact is refused before publication; accessor is never invoked', async () => {
  const f = await fixture();
  for (const field of ['operationId', 'providerId', 'authorityGeneration', 'requestDigest',
    'grantRequestId', 'claimBindingDigest', 'providerBindingDigest', 'acceptedAuthorityDigest',
    'expectedAuthorityHeadDigest', 'expectedAuthorityRevision', 'expectedConstraintsDigest',
    'expectedContainmentPolicyDigest'] as const) {
    assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared,
      { ...f.request, [field]: 'substituted' })).status, 'indeterminate', field);
  }
  assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared,
    { ...f.request, scope: { ...scope, projectId: 'other' } })).status, 'indeterminate');
  let invoked = false;
  const hostile = { ...intent, get intentDigest() {invoked = true; throw new Error('getter');} };
  assert.equal((await f.api.evaluateForAcceptance(hostile)).status, 'indeterminate');
  assert.equal(invoked, false);
  assert.equal(f.db.tables.authority_heads.size, 0);
});

test('publication COMMIT acknowledgement is an awaited barrier', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  f.db.hook = async (client, sql, _values, execute) => {
    if (sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
      event.sql.includes('INSERT INTO runtime_security_dispatch_v1.authority_heads'))) {
      entered.resolve(); await release.promise;
    }
    return execute();
  };
  const pending = f.api.publishAndConsumeForDispatch(f.prepared, f.request);
  await entered.promise;
  assert.equal(f.db.tables.consumptions.size, 0);
  assert.equal(f.db.tables.consume_requests.size, 0);
  release.resolve();
  assert.equal((await pending).status, 'consumed');
  f.db.assertReleased();
});

test('lost publication acknowledgement requires exact owner read; rollback cannot consume', async () => {
  for (const committed of [true, false]) {
    const f = await fixture();
    let intercepted = false;
    f.db.hook = async (client, sql, _values, execute) => {
      if (!intercepted && sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
        event.sql.includes('INSERT INTO runtime_security_dispatch_v1.authority_heads'))) {
        intercepted = true;
        if (committed) {await execute();}
        throw new Error('ack lost');
      }
      return execute();
    };
    const result = await f.api.publishAndConsumeForDispatch(f.prepared, f.request);
    assert.equal(result.status, committed ? 'consumed' : 'indeterminate');
    assert.equal(f.db.tables.consumptions.size, committed ? 1 : 0);
    f.db.assertReleased();
  }
});

test('revoking absence and conflicting heads cannot be overwritten', async () => {
  const f = await fixture();
  await f.repository.revokeAuthority(operation(f.request), '0');
  assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'indeterminate');
  assert.deepEqual(await f.repository.readAuthority(operation(f.request)), { headVersion: '1' });
  const g = await fixture();
  const stop = { ...g.deps, repository: { ...g.repository,
    async consumeAtomically() {throw new Error('hold consumption');} } };
  await createDispatchAcceptanceFeature(stop).publishAndConsumeForDispatch(g.prepared, g.request);
  const changed = { ...g.prepared, requestDigest: 'different' };
  assert.equal((await g.api.publishAndConsumeForDispatch(changed,
    { ...g.request, requestDigest: 'different' })).status, 'indeterminate');
  assert.equal((await g.repository.readAuthority(operation(g.request))).authority?.requestDigest, g.request.requestDigest);
});

test('missing-head result remains not_found and publication never repairs it', async () => {
  const f = await fixture();
  assert.deepEqual(await f.api.observeDispatchConsumption(f.request), { status: 'not_found' });
  // Exercise the old consumer first, as a misordered external composition would.
  const legacy = (await import('../dist/composition.js')).createContainedTurnDispatchAuthorityFeature({ repository: f.repository, clock: f.deps.clock, digest: f.deps.digest }).dispatchAuthorityV1;
  assert.deepEqual(await legacy.consumeForDispatch(f.request), { status: 'not_found' });
  assert.deepEqual(await f.api.publishAndConsumeForDispatch(f.prepared, f.request), { status: 'not_found' });
  assert.equal(f.db.tables.authority_heads.size, 0);
});

test('concurrent exact publication consumes once and returns identical receipts', async () => {
  const f = await fixture();
  const results = await Promise.all([f.api.publishAndConsumeForDispatch(f.prepared, f.request),
    f.api.publishAndConsumeForDispatch(f.prepared, f.request)]);
  assert.equal(results[0].status, 'consumed');
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.db.tables.consumptions.size, 1);
  assert.equal((await f.repository.readAuthority(operation(f.request))).headVersion, '1');
});

test('lost acknowledgement plus unavailable exact read stays indeterminate without consumption', async () => {
  const f = await fixture();
  let lost = false;
  f.db.hook = async (client, sql, _values, execute) => {
    if (sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
      event.sql.includes('INSERT INTO runtime_security_dispatch_v1.authority_heads'))) {
      await execute(); lost = true; throw new Error('lost ack');
    }
    if (lost && sql.includes('FROM runtime_security_dispatch_v1.authority_heads')) {throw new Error('read unavailable');}
    return execute();
  };
  assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'indeterminate');
  assert.equal(f.db.tables.authority_heads.size, 1);
  assert.equal(f.db.tables.consumptions.size, 0);
  f.db.hook = undefined;
  assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'consumed');
});

test('policy mutation cannot widen retained acceptance, and prepared acceptance substitutions fail closed', async () => {
  const f = await fixture();
  f.setPolicy({ ...rule, claimBeforeControlTime: 300 });
  assert.equal((await f.api.evaluateForAcceptance(intent)).status, 'denied');
  assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'indeterminate');
  f.setPolicy(rule);
  for (const changed of [{ decisionDigest: 'different' },
    { acceptance: { ...intent, intentDigest: 'different' } },
    { acceptance: { ...intent, policyRevision: 'different' } }]) {
    assert.equal((await f.api.publishAndConsumeForDispatch({ ...f.prepared, ...changed }, f.request)).status, 'indeterminate');
  }
  assert.equal(f.db.tables.authority_heads.size, 0);
});

test('policy revocation during publication acknowledgement prevents subsequent consumption', async () => {
  const f = await fixture();
  f.db.hook = async (client, sql, _values, execute) => {
    if (sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
      event.sql.includes('INSERT INTO runtime_security_dispatch_v1.authority_heads'))) {
      f.setPolicy({ ...rule, revoked: true });
    }
    return execute();
  };
  assert.equal((await f.api.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'indeterminate');
  assert.equal(f.db.tables.consumptions.size, 0);
});

test('head revocation racing publication acknowledgement prevents consumption in the existing owner transaction', async () => {
  const f = await fixture();
  let revoked = false;
  f.db.hook = async (client, sql, _values, execute) => {
    const result = await execute();
    if (!revoked && sql === 'COMMIT' && f.db.events.some(event => event.client === client.id &&
      event.sql.includes('INSERT INTO runtime_security_dispatch_v1.authority_heads'))) {
      revoked = true;
      await f.repository.revokeAuthority(operation(f.request), '1');
    }
    return result;
  };
  const result = await f.api.publishAndConsumeForDispatch(f.prepared, f.request);
  assert.equal(result.status, 'prevented');
  if (result.status === 'prevented') {assert.equal(result.evidence.reason, 'revoked');}
  assert.equal(f.db.tables.consumptions.size, 0);
  assert.equal((await f.repository.readAuthority(operation(f.request))).headVersion, '2');
});

test('hostile policy and publication record accessors never run', async () => {
  const f = await fixture();
  let invoked = false;
  f.setPolicy({ ...rule, get enabled() {invoked = true; return true;} });
  assert.equal((await f.api.evaluateForAcceptance(intent)).status, 'indeterminate');
  assert.equal(invoked, false);
  f.setPolicy(rule);
  const feature = createDispatchAcceptanceFeature({ ...f.deps,
    repository: { ...f.repository, async readAuthority() {
      return { get headVersion() {invoked = true; return '0';} };
    } } });
  assert.equal((await feature.publishAndConsumeForDispatch(f.prepared, f.request)).status, 'indeterminate');
  assert.equal(invoked, false);
});
