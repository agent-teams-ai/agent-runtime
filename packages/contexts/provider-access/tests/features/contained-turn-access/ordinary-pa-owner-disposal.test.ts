import assert from 'node:assert/strict';
import test from 'node:test';
import {createPostgresOrdinaryProviderAccessOwner} from '../../../dist/features/contained-turn-access/composition/ordinary-provider-access-owner.js';
import {ordinaryPaSchemaDigest} from '../../../dist/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-schema.js';
import type {MaterializationPostgresPool} from '../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-transactions.js';
import type {OrdinaryCodexAuthCapture} from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-contracts.js';

function unavailable(): never {throw new Error("TEST setup must not execute", {cause: "synthetic setup"});}

// SQL is an in-memory disposable port; no server, capture, broker or provider runs.
for (const boundary of ['retirement', 'capture'] as const) {
test(`pending capture failure does not starve real PA owner ${boundary} retries or independent capture disposal`, async () => {
  const rows = new Map<string, Record<string, unknown>>();
  let updates = 0; let failures = boundary === 'retirement' ? 1 : 0; let capturesDisposed = 0; let connections = 0;
  let captureFailures = boundary === 'capture' ? 1 : 0; let captureDisposalCalls = 0;
  const pool: MaterializationPostgresPool = {async connect() {
    connections += 1;
    return {release() {}, async query(sql, values = []) {
      const key = String(values[0]);
      if (sql.startsWith('SELECT version,digest')) {return {rows: [{version: 1, digest: ordinaryPaSchemaDigest}], rowCount: 1};}
      if (sql.startsWith('INSERT INTO provider_access.ordinary_grant')) {
        rows.set(key, {binding: JSON.parse(String(values[1])), snapshot: JSON.parse(String(values[2])), expires_at: values[3], retired_at: null, disposition: null, settlement_id: null, requests_started: 0, requests_completed: 0, requests_failed: 0});
      } else if (sql.startsWith('UPDATE provider_access.ordinary_grant SET retired_at')) {
        updates += 1;
        if (failures-- > 0) {throw new Error('TEST transient retirement storage failure');}
        rows.get(key)!.retired_at = values[1];
      } else if (sql.startsWith('UPDATE provider_access.ordinary_grant SET disposition')) {
        rows.get(key)!.disposition = values[1]; rows.get(key)!.settlement_id = values[2];
      } else if (sql.startsWith('SELECT * FROM provider_access.ordinary_grant')) {
        const row = rows.get(key); return {rows: row ? [row] : [], rowCount: row ? 1 : 0};
      } else {assert.ok(sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SELECT set_config'), sql);}
      return {rows: [], rowCount: 1};
    }};
  }};
  const owner = createPostgresOrdinaryProviderAccessOwner({pool, registerSecrets: () => true});
  for (const suffix of ['one', 'two']) {
    const capture: OrdinaryCodexAuthCapture = {
      settled: Promise.resolve(), dispose() {captureDisposalCalls += 1; if (captureFailures-- > 0) {throw new Error('TEST capture disposal transient failure');} capturesDisposed += 1;},
      async capture() {return {accountId: 'TEST-account', generation: 1, captureRef: 'TEST-capture', expiresAt: Date.now() + 49000, deadline: performance.now() + 49000, sourceIdentity: 'TEST-source', modelObserved: true};},
      withCredentialOutputTokens() {assert.fail('must not capture credentials');}, admit() {assert.fail('must not materialize');},
    };
    await owner.consume({tenantId: 'TEST-tenant', projectId: 'TEST-project', operationId: `TEST-${suffix}`, attemptId: `TEST-attempt-${suffix}`, executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1'}, capture, new AbortController().signal);
  }
  const pendingCalls = [0, 0];
  const pendingFailure = new Error('TEST pending capture disposal failed', {cause: 'synthetic capture'});
  const pending = [0, 1].map(index => {
    let rejectCapture!: (error: unknown) => void;
    const captured = new Promise<never>((_resolve, reject) => {rejectCapture = reject;});
    const capture: OrdinaryCodexAuthCapture = {
      settled: Promise.resolve(), capture: () => captured,
      dispose() {
        pendingCalls[index] += 1;
        if (index === 0 && pendingCalls[index] === 1) {throw pendingFailure;}
        rejectCapture(pendingFailure);
      },
      withCredentialOutputTokens() {assert.fail('must not capture credentials');}, admit() {assert.fail('must not materialize');},
    };
    return assert.rejects(owner.consume({tenantId: 'TEST-tenant', projectId: 'TEST-project', operationId: `TEST-pending-${index}`, attemptId: `TEST-pending-attempt-${index}`, executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1'}, capture, new AbortController().signal));
  });
  const root = import.meta.url.slice(0, import.meta.url.indexOf('/packages/')) + '/';
  const {createAgentRuntimeHost} = await import(new URL('packages/apps/embedded-runtime/dist/composition/agent-runtime-host.js', root).href);
  const host = createAgentRuntimeHost({
    codexSetup: {authorizeSetupInspection: {execute: unavailable}, discoverCodexInstallations: {execute: unavailable}, inspectCodexConfiguration: {execute: unavailable}, planCodexSetupInspection: {plan: unavailable}},
    claudeCodeSetup: {authorizeClaudeCodeSetupInspection: {execute: unavailable}, discoverClaudeCodeInstallations: {execute: unavailable}, inspectClaudeCodeConfiguration: {execute: unavailable}, planClaudeCodeSetupInspection: {plan: unavailable}},
  }, owner);
  const first = host.dispose(); assert.equal(host.dispose(), first);
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.includes(pendingFailure) && error.errors.length === 2);
  assert.deepEqual(pendingCalls, [1, 1]);
  assert.equal(capturesDisposed, boundary === 'retirement' ? 2 : 1); assert.equal(updates, boundary === 'retirement' ? 2 : 1);
  await host.dispose(); await host.dispose(); await owner.dispose();
  await Promise.all(pending); assert.deepEqual(pendingCalls, [2, 1]);
  assert.equal(capturesDisposed, 2); assert.equal(updates, boundary === 'retirement' ? 3 : 2);
  assert.equal(captureDisposalCalls, boundary === 'retirement' ? 2 : 3);
  assert.ok([...rows.values()].every(row => row.retired_at !== null));
  const completedConnections = connections;
  await assert.rejects(owner.observe({tenantId: 'TEST-tenant', projectId: 'TEST-project', operationId: 'TEST-one', attemptId: 'TEST-attempt-one', executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1'}));
  assert.equal(connections, completedConnections);
});
}
