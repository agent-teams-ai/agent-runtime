import { EventEmitter, once } from "node:events";
import { X509Certificate } from "node:crypto";
import { createSecureContext, createServer, type ConnectionOptions, type Server, type TLSSocket } from "node:tls";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";

import type {
  NodeTlsHttpEgressConnector,
  OwnedNodeTlsSocket,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-tls-http-egress-transport-attempt.js";
import {
  SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE,
  SYNTHETIC_LOOPBACK_SERVER_KEY,
} from "../../fixtures/http-egress-tls/synthetic-loopback-certificates.ts";

export type LoopbackTlsServer = Readonly<{
  port: number;
  connections: () => number;
  observedSni: () => readonly string[];
  received: () => Uint8Array;
  backpressured: () => boolean;
  close(): Promise<void>;
}>;

export type LoopbackTlsOptions = Readonly<{
  key?: string;
  cert?: string;
  alpn?: readonly string[];
  minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
  maxVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
  response?: readonly Uint8Array[];
  resetOnData?: boolean;
  stallOnData?: boolean;
  renegotiateOnData?: boolean;
  floodBytes?: number;
}>;

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const collect = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {chunks.push(chunk); size += chunk.byteLength;}
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {result.set(chunk, offset); offset += chunk.byteLength;}
  return result;
};

export const startLoopbackTlsServer = async (options: LoopbackTlsOptions = {}): Promise<LoopbackTlsServer> => {
  const sockets = new Set<TLSSocket>();
  const rawSockets = new Set<Socket>();
  const sni: string[] = [];
  const receivedChunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let connections = 0;
  let backpressured = false;
  const key = options.key ?? SYNTHETIC_LOOPBACK_SERVER_KEY;
  const cert = options.cert ?? SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE;
  const context = createSecureContext({ key, cert });
  const server = createServer({
    key,
    cert,
    ALPNProtocols: options.alpn ?? ["http/1.1"],
    minVersion: options.minVersion ?? "TLSv1.2",
    maxVersion: options.maxVersion ?? "TLSv1.3",
    SNICallback(servername, callback) {
      sni.push(servername);
      callback(null, context);
    },
  }, socket => {
    sockets.add(socket);
    socket.on("close", () => {sockets.delete(socket);});
    socket.on("error", () => {});
    let responded = false;
    socket.on("data", chunk => {
      receivedChunks.push(Uint8Array.from(chunk));
      receivedBytes += chunk.byteLength;
      if (responded) {return;}
      responded = true;
      if (options.resetOnData) {socket.destroy(); return;}
      if (options.stallOnData) {return;}
      if (options.renegotiateOnData) {
        socket.renegotiate({}, () => {});
        return;
      }
      if (options.floodBytes !== undefined) {
        const block = Buffer.alloc(16_384, 120);
        for (let sent = 0; sent < options.floodBytes; sent += block.byteLength) {
          if (!socket.write(block.subarray(0, Math.min(block.byteLength, options.floodBytes - sent)))) {
            backpressured = true;
          }
        }
        socket.end();
        return;
      }
      for (const part of options.response ?? [utf8("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")]) {
        socket.write(part);
      }
      socket.end();
    });
  });
  server.on("tlsClientError", () => {});
  server.on("connection", socket => {
    connections += 1;
    rawSockets.add(socket);
    socket.on("close", () => {rawSockets.delete(socket);});
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {throw new Error("synthetic listener missing address");}
  return Object.freeze({
    port: address.port,
    connections: () => connections,
    observedSni: () => Object.freeze([...sni]),
    received: () => {
      const result = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of receivedChunks) {result.set(chunk, offset); offset += chunk.byteLength;}
      return result;
    },
    backpressured: () => backpressured,
    close: async () => {
      for (const socket of sockets) {socket.destroy();}
      for (const socket of rawSockets) {socket.destroy();}
      await new Promise<void>(resolve => {server.close(() => {resolve();});});
    },
  });
};

export type StalledTcpServer = Readonly<{ port: number; accepted: () => number; close(): Promise<void> }>;

export const startStalledTcpServer = async (): Promise<StalledTcpServer> => {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server: NetServer = createNetServer(socket => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => {sockets.delete(socket);});
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {throw new Error("synthetic listener missing address");}
  return Object.freeze({
    port: address.port,
    accepted: () => accepted,
    close: async () => {
      for (const socket of sockets) {socket.destroy();}
      await new Promise<void>(resolve => {server.close(() => {resolve();});});
    },
  });
};

type FakeSocketOptions = Readonly<{
  remoteAddress?: string;
  remotePort?: number;
  closeOnDestroy?: boolean;
  write?: "throw" | "callback-error" | "callback-then-throw" | "wait";
  completeWriteOnDestroy?: boolean;
}>;

export class SyntheticOwnedTlsSocket extends EventEmitter implements OwnedNodeTlsSocket {
  public authorized = true;
  public alpnProtocol: string | false | null = "http/1.1";
  public servername: string | false | null = "provider.test";
  public remoteAddress: string | undefined;
  public remotePort: number | undefined;
  public readableLength = 0;
  public closed = false;
  public destroyed = false;
  public renegotiationDisabled = false;
  public readonly writes: Uint8Array[] = [];
  readonly #options: FakeSocketOptions;
  #pendingWriteCallback: ((error?: Error | null) => void) | undefined;

  public constructor(options: FakeSocketOptions = {}) {
    super();
    this.#options = options;
    this.remoteAddress = options.remoteAddress ?? "127.0.0.1";
    this.remotePort = options.remotePort ?? 443;
  }

  public setTimeout(_milliseconds: number): this {return this;}
  public destroy(_error?: Error): this {
    this.destroyed = true;
    if (this.#options.completeWriteOnDestroy === true && this.#pendingWriteCallback !== undefined) {
      this.completePendingWrite();
    }
    if (this.#options.closeOnDestroy !== false && !this.closed) {
      queueMicrotask(() => {this.closed = true; this.emit("close");});
    }
    return this;
  }
  public write(buffer: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push(Uint8Array.from(buffer));
    if (this.#options.write === "throw") {throw new Error("synthetic write throw");}
    if (this.#options.write === "callback-then-throw") {
      callback();
      throw new Error("synthetic throw after successful callback");
    }
    if (this.#options.write === "callback-error") {
      queueMicrotask(() => {callback(new Error("synthetic callback error")); this.emit("error", new Error("synthetic"));});
    } else if (this.#options.write !== "wait") {
      queueMicrotask(() => {callback(); this.readableLength = 1; this.emit("readable");});
    } else {
      this.#pendingWriteCallback = callback;
    }
    return false;
  }
  public exposeReadable(): void {
    this.readableLength = 1;
    this.emit("readable");
  }
  public completePendingWrite(error?: Error): void {
    const callback = this.#pendingWriteCallback;
    this.#pendingWriteCallback = undefined;
    if (callback === undefined) {throw new Error("no pending synthetic write callback");}
    callback(error);
  }
  public disableRenegotiation(): void {this.renegotiationDisabled = true;}
  public getProtocol(): string | null {return "TLSv1.3";}
  public getPeerX509Certificate() {
    return new X509Certificate(SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE);
  }
  public isSessionReused(): boolean {return false;}
  public async *iterator(): AsyncIterableIterator<unknown> {yield utf8("x");}
}

export const syntheticConnector = (
  socket: SyntheticOwnedTlsSocket,
  mutate?: (options: ConnectionOptions, socket: SyntheticOwnedTlsSocket) => void,
): NodeTlsHttpEgressConnector => options => {
  mutate?.(options, socket);
  const legacy = new X509Certificate(SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE).toLegacyObject();
  const error = options.checkServerIdentity?.(options.servername ?? "", legacy);
  if (error !== undefined) {queueMicrotask(() => {socket.emit("error", error);});}
  else {queueMicrotask(() => {socket.emit("secureConnect");});}
  return socket;
};

export const closeTlsServer = async (server: Server): Promise<void> => {
  server.close();
  if (server.listening) {await once(server, "close");}
};
