import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { OrdinaryPaUnavailable } from '../../contracts/ordinary-provider-access.js';

export interface OrdinaryPaUpstreamReply { readonly status: number; readonly body: AsyncIterable<Uint8Array>; close(): void; }
export interface OrdinaryPaUpstream {
  request(body: Buffer, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<OrdinaryPaUpstreamReply>;
}
/** Fixed ordinary endpoint, one TLS request, no redirects, retry, websocket or connection reuse. */
export function createOrdinaryPaUpstream(): OrdinaryPaUpstream {
  return Object.freeze<OrdinaryPaUpstream>({ request(body, headers, signal) {
    return new Promise<OrdinaryPaUpstreamReply>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      const outgoing = request({ protocol: 'https:', hostname: 'chatgpt.com', port: 443,
        path: '/backend-api/codex/responses', method: 'POST', agent: false, signal,
        headers: { ...headers, 'content-length': String(body.length), connection: 'close' } }, incoming => {
        response = incoming;
        resolve({ status: incoming.statusCode ?? 0, body: incoming, close: () => { incoming.destroy(); outgoing.destroy(); } });
      });
      outgoing.on('error', () => { response?.destroy(); reject(new OrdinaryPaUnavailable()); });
      outgoing.end(body);
    });
  } });
}
