import { isIPv4, Server, type Socket } from "node:net";
import type { HttpEgressClock } from "./http-egress-ports.js";
import { retainHttpEgressClock } from "./http-egress-runtime-security-v2.js";

export type NodeHostHttpListenerConfig = Readonly<{
  host: string;
  deadline: number;
  closureDeadline: number;
  highWaterMark?: number;
}>;
export type NodeHostHttpAccept = (socket: Socket, signal: AbortSignal) => Promise<void>;
type Address = Readonly<{ address: string; family: "IPv4"; port: number }>;
type Closure = Readonly<{ state: "closed" | "unknown" }>;
export type NodeHostHttpListener = Readonly<{ address: Address; close(): Promise<Closure> }>;

const failure = (): Error => new Error("host HTTP listener unavailable");
const privateAddress = (host: string): boolean => {
  if (!isIPv4(host)) {return false;}
  const [a, b] = host.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
};
const closedErrorSink = (): void => {};

/**
 * Private, inert recipe. open() is a one-use, explicit post-claim Host effect.
 * One numeric private IPv4 address, one ephemeral port, no DNS/wildcard/reuse,
 * and no queued exchange. Accepted sockets remain paused and binary for the
 * existing NodeHostHttpConnection adapter. The retained consumer MUST perform
 * ingress authentication and broker authorization using this same cutoff.
 * This owner grants no route/credential authority and is not a V4 proof issuer.
 */
export const createNodeHostHttpListener = (input: NodeHostHttpListenerConfig, clock: HttpEgressClock) => {
  const config = Object.freeze({ host: input.host, deadline: input.deadline,
    closureDeadline: input.closureDeadline, highWaterMark: input.highWaterMark ?? 65_536 });
  if (!privateAddress(config.host) || !Number.isSafeInteger(config.deadline) || config.deadline < 0
    || !Number.isSafeInteger(config.closureDeadline) || config.closureDeadline < config.deadline
    || !Number.isSafeInteger(config.highWaterMark) || config.highWaterMark < 1 || config.highWaterMark > 65_536) {
    throw failure();
  }
  let opened = false;
  return Object.freeze({
    open(accept: NodeHostHttpAccept, cutoff: AbortController): Promise<NodeHostHttpListener> {
      if (opened || typeof accept !== "function" || !(cutoff instanceof AbortController)) {return Promise.reject(failure());}
      opened = true;
      return new ListenerCustody(config, retainHttpEgressClock(clock), accept, cutoff).open();
    },
  });
};
type Config = Readonly<Required<NodeHostHttpListenerConfig>>;

class ListenerCustody {
  readonly #config: Config;
  readonly #clock: HttpEgressClock;
  readonly #accept: NodeHostHttpAccept;
  readonly #cutoff: AbortController;
  readonly #ready = Promise.withResolvers<void>();
  readonly #serverClosed = Promise.withResolvers<void>();
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #work: Promise<void> | undefined;
  #busy = false;
  #sealed = false;
  #actualClose = false;
  #uncertain = false;
  #closePromise: Promise<Closure> | undefined;
  #operationWatch: AbortController | undefined;

  public constructor(config: Config, clock: HttpEgressClock, accept: NodeHostHttpAccept, cutoff: AbortController) {
    this.#config = config; this.#clock = clock; this.#accept = accept; this.#cutoff = cutoff;
  }

  public async open(): Promise<NodeHostHttpListener> {
    if (this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)) {throw failure();}
    const server = new Server({ allowHalfOpen: true, pauseOnConnect: true, highWaterMark: this.#config.highWaterMark });
    this.#server = server;
    server.maxConnections = 1;
    server.on("connection", this.#connection).on("drop", this.#failed).on("error", this.#failed)
      .once("listening", this.#listening).once("close", this.#onClose);
    this.#cutoff.signal.addEventListener("abort", this.#aborted, { once: true });
    // Observe rejection even if listen() throws synchronously.
    void this.#ready.promise.catch(() => {});
    try {
      server.listen({ host: this.#config.host, port: 0, backlog: 1, exclusive: true, signal: this.#cutoff.signal });
      await this.#clock.within(this.#config.deadline, () => this.#ready.promise, this.#cutoff.signal);
      const address = server.address();
      if (this.#sealed || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)
        || !server.listening || address === null || typeof address === "string"
        || address.family !== "IPv4" || address.address !== this.#config.host
        || !Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65_535) {throw failure();}
      this.#operationWatch = new AbortController();
      void this.#clock.within(this.#config.deadline, () => this.#serverClosed.promise, this.#operationWatch.signal)
        .catch(() => {if (!this.#operationWatch!.signal.aborted) {this.#failed();}});
      return Object.freeze({ address: Object.freeze({ ...address, family: "IPv4" as const }), close: () => this.close() });
    } catch {
      this.#failed();
      await this.close();
      throw failure();
    }
  }

  #live(deadline: number): boolean {
    try {const now = this.#clock.now(); return Number.isSafeInteger(now) && now < deadline;} catch {return false;}
  }

  readonly #listening = (): void => {
    if (this.#sealed || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)) {
      // A late bind may never republish a retired endpoint.
      this.#server!.close(); this.#ready.reject(failure()); return;
    }
    this.#ready.resolve();
  };
  readonly #failed = (): void => {this.#uncertain = true; this.#aborted();};
  readonly #aborted = (): void => {void this.close();};
  readonly #onClose = (): void => {
    this.#actualClose = true;
    this.#serverClosed.resolve();
    if (!this.#sealed) {this.#failed();}
  };

  readonly #connection = (socket: Socket): void => {
    this.#sockets.add(socket);
    const closed = Promise.withResolvers<void>();
    socket.once("close", () => {this.#sockets.delete(socket); closed.resolve();})
      .on("error", closedErrorSink);
    if (this.#sealed || this.#busy || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)) {
      socket.destroy(); this.#failed(); return;
    }
    this.#busy = true;
    // Publish pending work before invoking the retained consumer, which may
    // synchronously abort/reenter. No listener admission is restored until both
    // the consumer and the actual native socket have finished.
    const work = Promise.withResolvers<void>();
    this.#work = work.promise;
    void this.#consume(socket, closed.promise).then(() => {this.#busy = false; return work.resolve();});
  };

  async #consume(socket: Socket, closed: Promise<void>): Promise<void> {
    try {await this.#accept(socket, this.#cutoff.signal);} catch {this.#failed();}
    if (!socket.destroyed) {socket.destroy(); this.#failed();}
    await closed;
  }

  public close(): Promise<Closure> {
    if (this.#closePromise !== undefined) {return this.#closePromise;}
    const completion = Promise.withResolvers<Closure>();
    this.#closePromise = completion.promise;
    this.#sealed = true;
    this.#ready.reject(failure());
    this.#operationWatch?.abort();
    this.#cutoff.signal.removeEventListener("abort", this.#aborted);
    if (!this.#cutoff.signal.aborted) {this.#cutoff.abort(failure());}
    try {this.#server?.close();} catch {this.#uncertain = true;}
    for (const socket of this.#sockets) {socket.destroy();}
    void this.#observeClosure().then(completion.resolve, () => completion.resolve(Object.freeze({ state: "unknown" })));
    return this.#closePromise;
  }

  async #observeClosure(): Promise<Closure> {
    const watch = new AbortController();
    try {
      await this.#clock.within(this.#config.closureDeadline,
        async () => {await this.#serverClosed.promise; await this.#work;}, watch.signal);
      if (!this.#live(this.#config.closureDeadline)) {this.#uncertain = true;}
    } catch {this.#uncertain = true;}
    finally {watch.abort();}
    const closed = this.#actualClose && this.#server?.listening === false
      && this.#sockets.size === 0 && !this.#busy && !this.#uncertain;
    if (this.#actualClose) {
      this.#server!.off("connection", this.#connection).off("drop", this.#failed)
        .off("error", this.#failed).off("listening", this.#listening).on("error", closedErrorSink);
    }
    return Object.freeze({ state: closed ? "closed" : "unknown" });
  }
}
