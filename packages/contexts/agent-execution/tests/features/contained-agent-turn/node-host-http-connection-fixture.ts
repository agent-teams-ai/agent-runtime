import { EventEmitter } from "node:events";
import type { HttpEgressClock } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { fixNodeHostHttpConnectionConfig, type NodeHostHttpConnectionConfig,
  type OwnedNodeHostHttpSocket } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection-config.js";
import { NodeHostHttpConnectionCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection-custody.js";
import { readStrictHttpRequest } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-request.js";

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const defaults: NodeHostHttpConnectionConfig = {
  expectedRequest: { requestId: "synthetic-request", method: "POST", path: "/invoke?mode=one", host: "broker.invalid" },
  limits: { maxInboundHeaderBytes: 16_384, maxInboundBodyBytes: 1_048_576,
    maxUpstreamHeaderBytes: 16_384, maxOutputBytes: 1_048_576, maxBufferedBytes: 65_536,
    maxUpstreamWireBytes: 2_097_152, deadline: 20_000, closureDeadline: 25_000 },
};
export const head = (length = 2, fields = ""): string =>
  `POST /invoke?mode=one HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: ${length}\r\n${fields}\r\n`;
export const wire = (body = "{}", fields = ""): Uint8Array => encode(head(encode(body).length, fields) + body);
export const flush = async (): Promise<void> => {for (let index = 0; index < 12; index += 1) {await Promise.resolve();}};

/** Pure deterministic deadlines: no timer, process or socket allocation. */
export class ManualClock implements HttpEgressClock {
  public time = 0;
  readonly #waiting = new Set<{ deadline: number; reject: () => void }>();
  public now(): number {return this.time;}
  public get pending(): number {return this.#waiting.size;}
  public within<T>(deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fail = (): void => {cleanup(); reject(new Error("synthetic clock"));};
      const entry = { deadline, reject: fail };
      const cleanup = (): void => {this.#waiting.delete(entry); signal?.removeEventListener("abort", fail);};
      if (signal?.aborted || !Number.isFinite(deadline) || this.time >= deadline) {fail(); return;}
      this.#waiting.add(entry);
      signal?.addEventListener("abort", fail, { once: true });
      try {
        void operation().then(value => {cleanup(); return resolve(value);}, () => {fail();});
      } catch {fail();}
    });
  }
  public async advance(time: number): Promise<void> {
    this.time = time;
    for (const entry of this.#waiting) {if (time >= entry.deadline) {entry.reject();}}
    await flush();
  }
}

/** No net.Socket, loopback, server, provider, native stream handle or external IO. */
export class SyntheticSocket extends EventEmitter implements OwnedNodeHostHttpSocket {
  public readableHighWaterMark = 65_536;
  public writableHighWaterMark = 65_536;
  public readableEncoding: string | null = null;
  public readableFlowing: boolean | null = null;
  public readableEnded = false;
  public writableEnded = false;
  public writableFinished = false;
  public allowHalfOpen = true;
  public connecting = false;
  public closed = false;
  public destroyed = false;
  public writableLength = 0;
  public autoAck = true;
  public autoFinish = true;
  public autoClose = true;
  public destroyCalls = 0;
  public endCalls = 0;
  public readonly reads: number[] = [];
  public readonly writes: Array<{ bytes: Uint8Array; callback: (error?: Error | null) => void }> = [];
  public onWrite: ((bytes: Uint8Array, callback: (error?: Error | null) => void) => boolean) | undefined;
  readonly #queue: Uint8Array[] = [];
  public get readableLength(): number {return this.#queue.reduce((sum, chunk) => sum + chunk.length, 0);}
  public feed(bytes: Uint8Array, announce = true): void {
    this.#queue.push(Uint8Array.from(bytes));
    if (announce) {this.emit("readable");}
  }
  public read(size: number): Uint8Array | null {
    this.reads.push(size);
    const first = this.#queue.shift();
    if (first === undefined) {return null;}
    if (first.length > size) {
      this.#queue.unshift(first.slice(size));
      return first.slice(0, size);
    }
    return first;
  }
  public write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push({ bytes, callback });
    this.writableLength = bytes.byteLength;
    if (this.onWrite !== undefined) {return this.onWrite(bytes, callback);}
    if (this.autoAck) {queueMicrotask(() => {this.ack();});}
    return true;
  }
  public ack(error?: Error): void {
    this.writableLength = 0;
    this.writes.at(-1)!.callback(error);
  }
  public end(): this {
    this.endCalls += 1;
    this.writableEnded = true;
    if (this.autoFinish) {queueMicrotask(() => this.finish());}
    return this;
  }
  public finish(): void {
    this.writableFinished = true;
    this.emit("finish");
    this.#naturalClose();
  }
  public peerEnd(): void {
    this.readableEnded = true;
    this.emit("end");
    this.#naturalClose();
  }
  #naturalClose(): void {
    if (this.autoClose && this.readableEnded && this.writableFinished) {queueMicrotask(() => this.actualClose());}
  }
  public destroy(): this {
    this.destroyCalls += 1;
    this.destroyed = true;
    if (this.autoClose) {queueMicrotask(() => this.actualClose());}
    return this;
  }
  public actualClose(hadError = false): void {
    if (this.closed) {return;}
    this.closed = true;
    this.emit("close", hadError);
  }
}

export const fixture = (input: NodeHostHttpConnectionConfig = defaults, socket = new SyntheticSocket()) => {
  const clock = new ManualClock();
  const cutoff = new AbortController();
  const config = fixNodeHostHttpConnectionConfig(input);
  const owner = new NodeHostHttpConnectionCustody(config, clock, cutoff);
  const binding = owner.bind(socket);
  return { ...binding, owner, socket, cutoff, clock, config,
    parse: () => readStrictHttpRequest(binding.connection.request, config.expectedRequest, config.limits, clock, binding.signal),
  };
};
export const ready = async (socket = new SyntheticSocket()) => {
  const f = fixture(defaults, socket);
  f.socket.feed(wire());
  await f.parse();
  return f;
};
