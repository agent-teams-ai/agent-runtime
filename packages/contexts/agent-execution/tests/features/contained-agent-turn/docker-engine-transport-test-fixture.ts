import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";

export const multiplex = (stream: 1 | 2, bytes: Uint8Array): Buffer => {
  const frame = Buffer.alloc(8 + bytes.byteLength);
  frame[0] = stream;
  frame.writeUInt32BE(bytes.byteLength, 4);
  Buffer.from(bytes).copy(frame, 8);
  return frame;
};

export const jsonResponse = (statusCode: number, value?: unknown) => ({
  body: value === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(value)),
  contentType: value === undefined ? "" : "application/json",
  statusCode,
});

export const drain = async (source: AsyncIterable<unknown>): Promise<void> => {
  for await (const value of source) {void value;}
};

export const incoming = (
  body: Uint8Array,
  rawHeaders: readonly string[] = [
    "content-type", "application/json", "content-length", String(body.byteLength),
  ],
): IncomingMessage => Object.assign(Readable.from([body]), {
  complete: true,
  headers: { "content-type": "application/json" },
  rawHeaders: [...rawHeaders],
  statusCode: 200,
}) as unknown as IncomingMessage;

export const responseFactory = (response: IncomingMessage): ((options: RequestOptions) => ClientRequest) => () => {
  const events = new EventEmitter();
  return Object.assign(events, {
    destroy() {events.emit("error", new Error("synthetic close"));},
    end() {queueMicrotask(() => {events.emit("response", response);});},
  }) as unknown as ClientRequest;
};

export const syntheticPeerConnector = async () => {
  const socket = new Socket();
  return { release: async () => {socket.destroy();}, socket };
};
