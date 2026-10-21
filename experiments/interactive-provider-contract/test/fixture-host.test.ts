import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureLedger, startFixtureHost } from '../harness/fixture-host.ts';
test('fixture canonical command replay, conflicting payload and lost response lookup never repeat the committed effect', () => {
  const host = new FixtureLedger();
  const payload = { idempotencyKey: 'intent-A', label: 'fixture' };
  const first = host.invoke('A', 'fixture_task', payload);
  assert.deepEqual(host.invoke('A', 'fixture_task', { label: 'fixture', idempotencyKey: 'intent-A' }), first);
  assert.throws(() => host.invoke('A', 'fixture_task', { ...payload, label: 'conflict' }), /conflict/);
  assert.throws(() => host.invoke('B', 'fixture_task', payload), /conflict/);
  assert.deepEqual(host.invoke('A', 'lookup', { idempotencyKey: 'intent-A' }), first);
  assert.equal(host.snapshot().length, 1);
});
test('read-only fixture handshake does not commit and MCP binding is host-controlled', async () => {
  const host = await startFixtureHost({ 'Bearer TEST-A': 'A' });
  try {
    const health = await fetch(`${host.url}/health`); assert.equal(health.status, 200); assert.equal(host.ledger.snapshot().length, 0);
    const denied = await fetch(`${host.url}/mcp`, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
    const list = await fetch(`${host.url}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer TEST-A' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = await list.json() as { result: { tools: { name: string }[] } }; assert(result.result.tools.some((tool) => tool.name === 'fixture_task')); assert.equal(host.ledger.snapshot().length, 0);
  } finally { await host.close(); }
});
