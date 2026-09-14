import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createPostgresOrdinaryProviderAccessOwner, materializationPostgresSchemaDigest, type MaterializationPostgresPool, type OrdinaryCodexAuthCapture, type OrdinaryPaBinding} from '../../../dist/composition.js';
import {ordinaryPaSchemaDigest} from '../../../dist/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-schema.js';

const binding: OrdinaryPaBinding = {tenantId: 'TEST', projectId: 'TEST', operationId: 'TEST-operation', attemptId: 'TEST-attempt', executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1'};
function fixture(pause: 'consume' | 'binding' | 'none') {
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const rows = new Map<string, Record<string, unknown>>();
  let paused = false, disposed = 0, retired = 0;
  const pool: MaterializationPostgresPool = {async connect() {
    let inserted = false, replaced = false;
    return {release() {}, async query(sql, values = []) {
      const key = String(values[0]);
      if (sql.startsWith('SELECT version,digest')) {return {rows: [{version: 1, digest: ordinaryPaSchemaDigest}], rowCount: 1};}
      if (sql.startsWith('SELECT version, digest')) {return {rows: [{version: 1, digest: await materializationPostgresSchemaDigest()}], rowCount: 1};}
      if (sql.startsWith('INSERT INTO provider_access.ordinary_grant')) {
        inserted = true;
        rows.set(key, {binding: JSON.parse(String(values[1])), snapshot: JSON.parse(String(values[2])), expires_at: values[3], retired_at: null, disposition: null, settlement_id: null, requests_started: 0, requests_completed: 0, requests_failed: 0});
      } else if (sql.startsWith('SELECT * FROM provider_access.ordinary_grant')) {
        const row = rows.get(key); return {rows: row ? [row] : [], rowCount: row ? 1 : 0};
      } else if (sql.startsWith('UPDATE provider_access.ordinary_grant SET retired_at')) {
        retired += 1; rows.get(key)!.retired_at = values[1];
      } else if (sql.startsWith('SELECT head_version, binding')) {return {rows: [{head_version: '0', binding: null}], rowCount: 1};}
      else if (sql.startsWith('UPDATE provider_access.materialization_owner')) {replaced = true;}
      else if (sql === 'COMMIT') {
        if (!paused && ((pause === 'consume' && inserted) || (pause === 'binding' && replaced))) {
          paused = true; entered.resolve(); await resume.promise;
        }
      } else {assert.ok(sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SELECT set_config') || sql.startsWith('INSERT INTO provider_access.materialization_owner'), sql);}
      return {rows: [], rowCount: 1};
    }};
  }};
  const capture: OrdinaryCodexAuthCapture = {
    settled: Promise.resolve(), dispose() {disposed += 1;},
    async capture() {return {accountId: 'TEST-account', generation: 1, captureRef: 'TEST-capture', expiresAt: Date.now() + 49000, deadline: performance.now() + 49000, sourceIdentity: 'TEST-source', modelObserved: true};},
    withCredentialOutputTokens(_operation, consume) {assert.equal(consume(['TEST-token', 'TEST-account']), true);},
    admit(selection, admission) {
      assert.equal(admission.admit({operationRef: selection.operationRef, binding: selection.binding, recipe: 'codex-chatgpt', fields: [{name: 'token', valueBytes: new TextEncoder().encode('TEST-token')}, {name: 'accountId', valueBytes: new TextEncoder().encode('TEST-account')}]}).kind, 'admitted');
    },
  };
  return {owner: createPostgresOrdinaryProviderAccessOwner({pool, registerSecrets: () => true}), capture, rows, entered, resume, counts: () => ({disposed, retired})};
}

test('owner disposal joins consume COMMIT and retires the late grant before closing', {timeout: 5000}, async () => {
  const f = fixture('consume');
  const consuming = assert.rejects(f.owner.consume(binding, f.capture, new AbortController().signal));
  await f.entered.promise;
  let closed = false;
  const disposal = f.owner.dispose().then(() => {closed = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(f.counts().retired, 0);
  f.resume.resolve();
  await Promise.all([consuming, disposal]);
  assert.deepEqual(f.counts(), {disposed: 1, retired: 1});
  assert.ok([...f.rows.values()].every(row => row.retired_at !== null));
  await f.owner.dispose(); assert.deepEqual(f.counts(), {disposed: 1, retired: 1});
});

for (const boundary of ['binding', 'broker'] as const) for (const winner of ['retire', 'dispose'] as const) {
  test(`${winner} joins pending ${boundary} construction and materialize cannot publish`, {timeout: 5000}, async t => {
    const listening = Promise.withResolvers<http.Server>();
    let serverCloses = 0, listens = 0;
    t.mock.method(http.Server.prototype, 'listen', function (this: http.Server) {listens += 1; listening.resolve(this); return this;});
    t.mock.method(http.Server.prototype, 'address', () => ({address: '127.0.0.1', family: 'IPv4', port: 12345}));
    t.mock.method(http.Server.prototype, 'close', function (this: http.Server, callback?: (error?: Error) => void) {serverCloses += 1; callback?.(); return this;});
    t.mock.method(http.Server.prototype, 'closeAllConnections', () => {});
    const f = fixture(boundary === 'binding' ? 'binding' : 'none');
    const grant = await f.owner.consume(binding, f.capture, new AbortController().signal);
    let failure: unknown;
    const materializing = assert.rejects(grant.materialize(), error => {failure = error; return true;});
    // A pre-barrier refusal must fail the fixture instead of leaving its barrier pending.
    const barrier = boundary === 'broker' ? listening.promise : f.entered.promise.then(() => undefined);
    const server = await Promise.race([barrier, materializing.then(() => {throw new Error(`TEST materialize failed before ${boundary} barrier`, {cause: failure});})]);
    let closed = false;
    const retirement = (winner === 'retire' ? grant.retire() : f.owner.dispose()).then(() => {closed = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(f.counts().retired, 0);
    if (server) {server.emit('listening');} else {f.resume.resolve();}
    await Promise.all([materializing, retirement]);
    await f.owner.dispose(); await grant.retire(); await assert.rejects(grant.materialize());
    assert.deepEqual(f.counts(), {disposed: 1, retired: 1});
    assert.equal(listens, boundary === 'broker' ? 1 : 0);
    assert.equal(serverCloses, boundary === 'broker' ? 1 : 0);
  });
}
