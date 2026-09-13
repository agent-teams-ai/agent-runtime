import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { OrdinaryPaUnavailable, type OrdinaryPaBinding } from '../../contracts/ordinary-provider-access.js';
import type { CredentialRenderingOwner, CredentialRenderingSelection } from './credential-rendering-contracts.js';
import { authorizationRequestPayload } from '../../domain/materialization-authorization.js';
import { parseAuthFrame } from './ordinary-codex-auth-json.js';
import type { OrdinaryPaStore } from './postgres/ordinary-pa-store.js';
import type { OrdinaryPaSecretGuard } from './ordinary-pa-secret-guard.js';
import type { OrdinaryPaUpstream } from './ordinary-pa-upstream.js';

export interface OrdinaryPaBrokerOptions {
  readonly binding: OrdinaryPaBinding;
  readonly selection: CredentialRenderingSelection;
  readonly renderer: CredentialRenderingOwner;
  readonly store: Pick<OrdinaryPaStore, 'beginRequest' | 'endRequest'>;
  readonly upstream: OrdinaryPaUpstream;
  readonly capability: Buffer;
  readonly secretGuard: OrdinaryPaSecretGuard;
}
const refused = () => new OrdinaryPaUnavailable();
const forwarded = new Set(['accept', 'content-type', 'user-agent', 'originator', 'version', 'session_id', 'x-codex-turn-metadata', 'x-codex-beta-features', 'openai-beta']);
async function boundedBytes(stream: AsyncIterable<Uint8Array>, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const value of stream) {
      size += value.byteLength; if (size > maximum) { throw refused(); }
      const bytes = Buffer.alloc(value.byteLength); bytes.set(value); chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally { for (const chunk of chunks) { chunk.fill(0); } }
}
const replyFailure = (response: ServerResponse) => {
  if (response.destroyed) { return; }
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
  response.end('{"error":"ordinary_provider_unavailable"}');
};
async function closeWithin(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(refused()), 5000); })]); }
  finally { clearTimeout(timer); }
}
function authenticate(request: IncomingMessage, capability: Buffer): void {
  const authorization = request.headers.authorization;
  if (request.method !== 'POST' || request.url !== '/v1/responses' || typeof authorization !== 'string' || !authorization.startsWith('Bearer ') ||
      request.headers['chatgpt-account-id'] !== undefined || request.headers['content-encoding'] !== undefined) { throw refused(); }
  const candidate = Buffer.from(authorization.slice(7), 'ascii');
  try { if (candidate.length !== capability.length || !timingSafeEqual(candidate, capability)) { throw refused(); } }
  finally { candidate.fill(0); }
  const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
  if (new Set(names).size !== names.length) { throw refused(); }
}
function presentation(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of forwarded) {
    const value = request.headers[name];
    if (value !== undefined) { if (typeof value !== 'string' || value.length > 4096) { throw refused(); } headers[name] = value; }
  }
  if (headers['content-type'] !== 'application/json' || headers.version !== '0.153.4') { throw refused(); }
  return headers;
}
function admitRequestBody(body: Buffer, guard: OrdinaryPaSecretGuard): void {
  const payload = parseAuthFrame(body);
  if (payload.model !== 'gpt-5.3-codex-spark' || payload.stream !== true ||
      !guard.artifact(body) || !guard.check(JSON.stringify(payload))) { throw refused(); }
}
function responseSafe(bytes: Buffer, guard: OrdinaryPaSecretGuard, semantic: {text: string}): boolean {
  if (!guard.artifact(bytes)) { return false; }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const line of source.split('\n')) {
    if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') { continue; }
    const value: unknown = JSON.parse(line.slice(5));
    if (!guard.check(JSON.stringify(value))) { return false; }
    if (value !== null && typeof value === 'object' && 'delta' in value && typeof value.delta === 'string') {
      semantic.text += value.delta;
      if (!guard.check(semantic.text)) { return false; }
    }
  }
  return true;
}

/** Private loopback listener; one sequential request at a time, durable replay fence before upstream. */
export async function createOrdinaryPaBroker(input: OrdinaryPaBrokerOptions) {
  let closed = false, failed = false, totalResponseBytes = 0;
  const semantic = {text: ""};
  let active: Promise<void> | undefined;
  const sockets = new Set<Socket>(), lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, input.selection.operationAbortSignal]);
  const check = () => { if (closed || failed || signal.aborted || performance.now() >= input.selection.deadline) { throw refused(); } };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let body: Buffer | undefined, output: Buffer | undefined, sequence: number | undefined;
    let upstream: Awaited<ReturnType<OrdinaryPaUpstream['request']>> | undefined;
    let rendered: Awaited<ReturnType<CredentialRenderingOwner['rendering']['render']>> | undefined;
    const local = new AbortController();
    const aborted = () => local.abort();
    request.on('aborted', aborted); response.on('close', aborted);
    try {
      check(); authenticate(request, input.capability); const headers = presentation(request);
      body = await boundedBytes(request, 1_048_576); check();
      admitRequestBody(body, input.secretGuard);
      const bodyDigest = 'sha256:' + createHash('sha256').update(body).digest('hex');
      sequence = await input.store.beginRequest(input.binding, bodyDigest, body.length); check();
      const unsigned = { ...input.selection.binding, authorizationRequestId: `${input.binding.operationId}:ordinary-http:${sequence}`,
        purpose: 'contained-turn.credential-materialization-authorization/v1' as const, schemaVersion: 1 as const };
      const authorized = await input.renderer.authorization.authorize({ ...unsigned, requestDigest: 'sha256:' + createHash('sha256').update(authorizationRequestPayload(unsigned)).digest('hex') });
      if (authorized.kind !== 'authorized') { throw refused(); }
      // The exact authority object is passed once. No spread, clone, cast or structural reconstruction.
      rendered = await input.renderer.rendering.render(authorized.receipt);
      if (rendered.kind !== 'rendered') { throw refused(); }
      for (const field of rendered.credentials.fields) {
        if (field.name !== 'Authorization' && field.name !== 'ChatGPT-Account-ID') { throw refused(); }
        headers[field.name.toLowerCase()] = new TextDecoder('utf-8', { fatal: true }).decode(field.valueBytes);
      }
      check();
      upstream = await input.upstream.request(body, headers, AbortSignal.any([signal, local.signal]));
      if (upstream.status < 200 || upstream.status >= 300) { throw refused(); }
      output = await boundedBytes(upstream.body, 2_097_152);
      totalResponseBytes += output.length;
      if (totalResponseBytes > 8_388_608 || !responseSafe(output, input.secretGuard, semantic)) { throw refused(); }
      check(); await input.store.endRequest(input.binding, sequence, true); sequence = undefined;
      response.writeHead(upstream.status, { 'content-type': 'text/event-stream', connection: 'close' }); response.end(output);
      // end() may retain bytes until its callback; wait for finish/close before zeroization.
      await new Promise<void>((resolve, reject) => {
        if (response.writableFinished) { resolve(); return; }
        const finish = () => { response.off('close', close); resolve(); };
        const close = () => { response.off('finish', finish); reject(refused()); };
        response.once('finish', finish); response.once('close', close);
      });
    } catch {
      failed = true;
      if (sequence !== undefined) { try { await input.store.endRequest(input.binding, sequence, false); } catch { /* pending request remains reconciliation evidence */ } }
      replyFailure(response);
    } finally {
      local.abort(); upstream?.close();
      if (rendered?.kind === 'rendered') { rendered.credentials.release(); }
      body?.fill(0); output?.fill(0);
      request.off('aborted', aborted); response.off('close', aborted);
    }
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 5000 }, (request, response) => {
    if (active || closed || failed) { replyFailure(response); return; }
    active = handle(request, response).catch(() => { failed = true; response.destroy(); }).finally(() => { active = undefined; });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { failed = true; socket.destroy(); });
  const cutoff = () => { failed = true; lifetime.abort(); for (const socket of sockets) { socket.destroy(); } };
  signal.addEventListener('abort', cutoff, { once: true });
  const timer = setTimeout(cutoff, Math.max(1, input.selection.deadline - performance.now())); timer.unref();
  try {
    check(); await new Promise<void>((resolve, reject) => {
      const error = () => { server.off('listening', listen); reject(refused()); };
      const listen = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', listen); server.listen(0, '127.0.0.1');
    });
    const address = server.address(); if (!address || typeof address === 'string') { throw refused(); }
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) { return closing; } closed = true;
      const work = (async () => {
        cutoff(); clearTimeout(timer); signal.removeEventListener('abort', cutoff);
        await new Promise<void>((resolve, reject) => { server.close(error => { if (error) { reject(refused()); } else { resolve(); } }); server.closeAllConnections(); });
        await active;
        if (sockets.size !== 0 || server.listening) { throw refused(); }
      })();
      closing = closeWithin(work); return closing;
    };
    return Object.freeze({ endpoint: `http://127.0.0.1:${address.port}/v1`, close });
  } catch {
    cutoff(); clearTimeout(timer); signal.removeEventListener('abort', cutoff); server.close(); server.closeAllConnections(); throw refused();
  }
}
