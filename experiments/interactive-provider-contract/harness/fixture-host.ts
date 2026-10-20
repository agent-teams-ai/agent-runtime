import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
/** Scenario-only authoritative state. No product store or durable-runtime imitation. */
export class FixtureLedger {
  private committed = new Map<string, { payload: string; result: { commandKey: string; committed: true; actor: string; tool: string } }>();
  private effects: { actor: string; tool: string; input: Record<string, unknown> }[] = [];
  invoke(actor: string, tool: string, input: Record<string, unknown>) {
    if (tool === 'readiness') {return { ready: true, revision: 'TEST-v1' };}
    if (tool === 'lookup') {return this.committed.get(String(input.idempotencyKey))?.result ?? { missing: true };}
    if (!['fixture_task', 'message_send'].includes(tool) || typeof input.idempotencyKey !== 'string') {throw new Error('invalid-command');}
    const payload = JSON.stringify([actor, tool, Object.keys(input).toSorted().map((key) => [key, input[key]])]);
    const previous = this.committed.get(input.idempotencyKey);
    if (previous) { if (previous.payload !== payload) {throw new Error('conflict');} return previous.result; }
    const result = { commandKey: input.idempotencyKey, committed: true as const, actor, tool };
    this.committed.set(input.idempotencyKey, { payload, result }); this.effects.push({ actor, tool, input: structuredClone(input) }); return result;
  }
  snapshot() { return structuredClone(this.effects); }
}
const toolDefinitions = [
  { name: 'readiness', description: 'Read-only test-host readiness', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'lookup', description: 'Read-only canonical command lookup', inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'] }, annotations: { readOnlyHint: true } },
  { name: 'fixture_task', description: 'Commit a disposable fixture task with an explicit command key', inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' }, label: { type: 'string' } }, required: ['idempotencyKey', 'label'] } },
  { name: 'message_send', description: 'Commit a disposable message to test recipient B', inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' }, to: { type: 'string', enum: ['B'] }, text: { type: 'string' } }, required: ['idempotencyKey', 'to', 'text'] } },
];
export async function startFixtureHost(bindings: Record<string, string>) {
  const ledger = new FixtureLedger();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ ready: true, revision: 'TEST-v1' })); return; }
    const actor = bindings[String(req.headers.authorization)];
    if (!actor) { res.writeHead(403); res.end('{}'); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end('{}'); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413); res.end('{}'); return; } chunks.push(chunk); }
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number | string; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      let result: unknown;
      if (message.method === 'initialize') {result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'TEST-interactive-provider', version: '1' } };}
      else if (message.method === 'tools/list') {result = { tools: toolDefinitions };}
      else if (message.method === 'tools/call') {
        try { result = { content: [{ type: 'text', text: JSON.stringify(ledger.invoke(actor, String(message.params?.name), message.params?.arguments ?? {})) }] }; }
        catch { result = { isError: true, content: [{ type: 'text', text: 'typed fixture command conflict or invalid input' }] }; }
      } else {result = {};}
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { res.writeHead(400); res.end('{}'); }
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, ledger, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) {reject(error);} else {resolve();} }); server.closeIdleConnections(); }) };
}
