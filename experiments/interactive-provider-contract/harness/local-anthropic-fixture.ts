/** Synthetic model endpoint + read-only MCP fixture. No real provider/auth access. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' ? value as RecordValue : {};

export type ModelRequest = { marker: string; hasToolResult: boolean; hasPriorTurn: boolean };

function summarize(body: RecordValue): ModelRequest {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let marker = '';
  let hasToolResult = false;
  for (const value of messages.toReversed()) {
    const message = object(value);
    if (message.role !== 'user') {continue;}
    const content = message.content;
    const blocks = Array.isArray(content) ? content.map(object) : [];
    if (blocks.some((block) => block.type === 'tool_result')) {hasToolResult = true;}
    const text = typeof content === 'string' ? content : blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const match = /SDK_FIXTURE_(A_ONE|A_TWO|A_THREE|B_ONE|B_PERMISSION|B_AFTER_PERMISSION|B_CANCEL)/.exec(text);
    if (match) { marker = match[1] ?? ''; break; }
  }
  return { marker, hasToolResult, hasPriorTurn: JSON.stringify(messages).includes('SDK_FIXTURE_A_ONE') };
}

function sendStream(response: ServerResponse, id: string, block: RecordValue, stop: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (type: string, value: RecordValue) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  if (block.type === 'text') {
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
  } else {
    emit('content_block_start', { index: 0, content_block: { ...block, input: {} } });
    emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  }
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  emit('message_stop', {});
  response.end();
}

export async function startLocalModelFixture(): Promise<{ url: string; requests: ModelRequest[]; close: () => Promise<void> }> {
  const requests: ModelRequest[] = [];
  let sequence = 0;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url?.startsWith('/v1/messages/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":1}'); return; }
    if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 2_000_000) { response.writeHead(413); response.end(); return; }
      chunks.push(buffer);
    }
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    const summary = summarize(body);
    requests.push(summary);
    if (!summary.marker) { response.writeHead(400); response.end('{"error":{"type":"invalid_request_error","message":"fixture marker missing"}}'); return; }
    sequence += 1;
    const id = `msg_sdk_fixture_${sequence}`;
    if (['A_ONE', 'B_PERMISSION', 'B_CANCEL'].includes(summary.marker) && !summary.hasToolResult) {
      const tools = Array.isArray(body.tools) ? body.tools.map(object) : [];
      const ping = tools.find((tool) => typeof tool.name === 'string' && tool.name.endsWith('__ping'));
      if (!ping) { response.writeHead(400); response.end('{"error":{"type":"invalid_request_error","message":"fixture ping tool missing"}}'); return; }
      sendStream(response, id, { type: 'tool_use', id: `tool_fixture_${sequence}`, name: ping.name, input: { marker: summary.marker } }, 'tool_use');
    } else {sendStream(response, id, { type: 'text', text: `FIXTURE_DONE_${summary.marker}` }, 'end_turn');}
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) {response.writeHead(500);} response.end(); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') {throw new Error('fixture address unavailable');}
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }) };
}

function runReadonlyMcpFixture(pidPath: string, callsPath: string): void {
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = object(JSON.parse(line) as unknown);
    if (!Object.hasOwn(request, 'id')) {return;}
    let result: unknown = {};
    if (request.method === 'initialize') {result = { protocolVersion: object(request.params).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'readonly-sdk-fixture', version: '1.0.0' } };}
    if (request.method === 'tools/list') {result = { tools: [{ name: 'ping', description: 'Read-only TEST echo; no team/task state.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }] };}
    if (request.method === 'tools/call') {
      const params = object(request.params);
      if (params.name !== 'ping') { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'unknown fixture tool' } })}\n`); return; }
      const marker = object(params.arguments).marker;
      appendFileSync(callsPath, `${JSON.stringify({ name: 'ping', marker })}\n`, { mode: 0o600 });
      result = { content: [{ type: 'text', text: `FIXTURE_PONG_${String(marker)}` }] };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  });
  lines.on('close', () => { process.exitCode = 0; });
}

if (process.argv[2] === '--mcp') {
  const pidPath = process.argv[3]; const callsPath = process.argv[4];
  if (!pidPath || !callsPath) {throw new Error('fixture paths required');}
  runReadonlyMcpFixture(pidPath, callsPath);
}
