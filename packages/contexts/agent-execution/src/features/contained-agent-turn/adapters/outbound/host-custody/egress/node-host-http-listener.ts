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

/**
 * Adapter-private, point-in-time facts from this recipe's retained custody.
 * `closed` describes only the Server, independently of sockets and consumers.
 * `not-attempted` means no native listen was attempted; it is not a close ack.
 * Pending bind stays unresolved after failure until a bound handle is observed.
 * Socket counts cover every delivered connection, including refused ones. A
 * native `drop` supplies no Socket and hence no observable socket close event.
 * Uncertainty lists missing local evidence; even an empty list is no PID,
 * process, route, Engine or V4 closure proof, nor a kernel-wide socket census.
 * Observe again for late events; snapshots never revise a prior close receipt.
 */
export type NodeHostHttpListenerObservation = Readonly<{
  scope: "retained-node-server-and-delivered-sockets";
  openState: "not-attempted" | "pending" | "published" | "failed";
  listenerState: "not-attempted" | "pending" | "open" | "unknown" | "closed";
  admissionSealed: boolean;
  nativeBindPending: boolean;
  closeRequested: boolean;
  serverCloseAcknowledged: boolean;
  sockets: Readonly<{ observed: number; closeEvents: number; awaitingClose: number; droppedWithoutSocket: number }>;
  /** Set before invoking the consumer; cleared only after its await settles. */
  consumerPending: boolean;
  /** Includes the consumer AND its socket's close event, as in close(). */
  consumerWorkPending: boolean;
  uncertainty: readonly ("native-bind-unresolved" | "server-close-unacknowledged"
    | "socket-close-unobserved" | "consumer-unsettled" | "consumer-work-unsettled" | "native-drop-unobserved")[];
}>;
export type NodeHostHttpListener = Readonly<{
  address: Address; sealAdmission(): void; close(): Promise<Closure>;
  observe(): NodeHostHttpListenerObservation;
}>;

// Only recipe/custody state enters this private formatter. No snapshot ingestion,
// token issuance, clock sampling, consumer call or native effect occurs on reads.
const observation = (state: Omit<NodeHostHttpListenerObservation, "scope" | "uncertainty">): NodeHostHttpListenerObservation => {
  const uncertainty: Array<NodeHostHttpListenerObservation["uncertainty"][number]> = [];
  if (state.nativeBindPending) {uncertainty.push("native-bind-unresolved");}
  if (state.listenerState === "unknown") {uncertainty.push("server-close-unacknowledged");}
  if (state.sockets.awaitingClose > 0) {uncertainty.push("socket-close-unobserved");}
  if (state.consumerPending) {uncertainty.push("consumer-unsettled");}
  else if (state.consumerWorkPending) {uncertainty.push("consumer-work-unsettled");}
  if (state.sockets.droppedWithoutSocket > 0) {uncertainty.push("native-drop-unobserved");}
  return Object.freeze({ ...state, scope: "retained-node-server-and-delivered-sockets",
    sockets: Object.freeze({ ...state.sockets }), uncertainty: Object.freeze(uncertainty) });
};

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
 * sealAdmission() retains the endpoint; only the trusted V4 coordinator calls
 * close() after its removal/socket authority checks. Neither operation issues
 * V4 proof. The recipe retains cleanup even when open() never publishes.
 */
export const createNodeHostHttpListener = (input: NodeHostHttpListenerConfig, clock: HttpEgressClock) => {
  const config = Object.freeze({ host: input.host, deadline: input.deadline,
    closureDeadline: input.closureDeadline, highWaterMark: input.highWaterMark ?? 65_536 });
  if (!privateAddress(config.host) || !Number.isSafeInteger(config.deadline) || config.deadline < 0
    || !Number.isSafeInteger(config.closureDeadline) || config.closureDeadline < config.deadline
    || !Number.isSafeInteger(config.highWaterMark) || config.highWaterMark < 1 || config.highWaterMark > 65_536) {
    throw failure();
  }
  let opened = false; let sealed = false;
  let custody: ListenerCustody | undefined;
  let emptyClose: Promise<Closure> | undefined;
  return Object.freeze({
    open(accept: NodeHostHttpAccept, cutoff: AbortController): Promise<NodeHostHttpListener> {
      if (opened || sealed || typeof accept !== "function" || !(cutoff instanceof AbortController)) {return Promise.reject(failure());}
      opened = true;
      custody = new ListenerCustody(config, retainHttpEgressClock(clock), accept, cutoff);
      return custody.open();
    },
    sealAdmission(): void {sealed = true; custody?.sealAdmission();},
    /** Normal completion only: prevent new consumers while retaining active IO
     * and the endpoint. Cancellation and the original operation deadline still
     * hard-cut immediately. This is settlement, not physical release proof. */
    settleAccepted(): Promise<Readonly<{state: "settled" | "unknown"}>> {
      sealed = true;
      return custody?.settleAccepted() ?? Promise.resolve(Object.freeze({state: "settled"}));
    },
    observe(): NodeHostHttpListenerObservation {
      return custody?.observe() ?? observation({ openState: "not-attempted", listenerState: "not-attempted",
        admissionSealed: sealed, nativeBindPending: false, closeRequested: emptyClose !== undefined,
        serverCloseAcknowledged: false, sockets: { observed: 0, closeEvents: 0, awaitingClose: 0, droppedWithoutSocket: 0 },
        consumerPending: false, consumerWorkPending: false });
    },
    close(): Promise<Closure> {
      sealed = true;
      return custody?.close() ?? (emptyClose ??= Promise.resolve(Object.freeze({ state: "closed" })));
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
  readonly #sockets = new Map<Socket, Promise<void>>();
  #server: Server | undefined;
  #work: Promise<void> | undefined;
  #openState: NodeHostHttpListenerObservation["openState"] = "pending";
  #socketCloseEvents = 0;
  #droppedWithoutSocket = 0;
  #consumerPending = false;
  #busy = false;
  #sealed = false;
  #draining = false;
  #settlement: Promise<Readonly<{state: "settled" | "unknown"}>> | undefined;
  #actualClose = false;
  #published = false;
  #bindPending = false;
  #closeIssued = false;
  #closePromise: Promise<Closure> | undefined;
  #operationWatch: AbortController | undefined;

  public constructor(config: Config, clock: HttpEgressClock, accept: NodeHostHttpAccept, cutoff: AbortController) {
    this.#config = config; this.#clock = clock; this.#accept = accept; this.#cutoff = cutoff;
    void this.#ready.promise.catch(() => {});
  }

  public async open(): Promise<NodeHostHttpListener> {
    if (this.#sealed || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)) {
      this.#openState = "failed";
      this.sealAdmission(); throw failure();
    }
    try {
      const server = new Server({ allowHalfOpen: true, pauseOnConnect: true, highWaterMark: this.#config.highWaterMark });
      this.#server = server;
      server.maxConnections = 1;
      server.on("connection", this.#connection).on("drop", this.#dropped).on("error", this.#failed)
        .on("listening", this.#listening).on("close", this.#onClose);
      this.#cutoff.signal.addEventListener("abort", this.#aborted, { once: true });
      // Admission abort must never trigger net.Server's automatic endpoint release.
      this.#bindPending = true;
      server.listen({ host: this.#config.host, port: 0, backlog: 1, exclusive: true });
      await this.#clock.within(this.#config.deadline, () => this.#ready.promise, this.#cutoff.signal);
      const address = server.address();
      if (this.#sealed || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)
        || !server.listening || address === null || typeof address === "string"
        || address.family !== "IPv4" || address.address !== this.#config.host
        || !Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65_535) {throw failure();}
      this.#operationWatch = new AbortController();
      void this.#clock.within(this.#config.deadline, () => this.#serverClosed.promise, this.#operationWatch.signal)
        .catch(() => {if (!this.#operationWatch!.signal.aborted) {this.#failed();}});
      if (this.#sealed || this.#cutoff.signal.aborted) {throw failure();}
      this.#published = true;
      this.#openState = "published";
      return Object.freeze({ address: Object.freeze({ ...address, family: "IPv4" as const }),
        sealAdmission: () => this.sealAdmission(), close: () => this.close(), observe: () => this.observe() });
    } catch {
      this.#openState = "failed";
      this.#failed();
      throw failure();
    }
  }

  public observe(): NodeHostHttpListenerObservation {
    let listenerState: NodeHostHttpListenerObservation["listenerState"];
    if (this.#server === undefined) {listenerState = "not-attempted";}
    else if (this.#bindPending) {listenerState = this.#openState === "failed" ? "unknown" : "pending";}
    else if (this.#server.listening) {listenerState = "open";}
    else {listenerState = this.#actualClose ? "closed" : "unknown";}
    return observation({ openState: this.#openState, listenerState, admissionSealed: this.#sealed || this.#draining,
      nativeBindPending: this.#bindPending, closeRequested: this.#closePromise !== undefined,
      serverCloseAcknowledged: listenerState === "closed",
      sockets: { observed: this.#socketCloseEvents + this.#sockets.size, closeEvents: this.#socketCloseEvents,
        awaitingClose: this.#sockets.size, droppedWithoutSocket: this.#droppedWithoutSocket },
      consumerPending: this.#consumerPending, consumerWorkPending: this.#busy });
  }

  #live(deadline: number): boolean {
    try {const now = this.#clock.now(); return Number.isSafeInteger(now) && now < deadline;} catch {return false;}
  }

  readonly #listening = (): void => {
    if (this.#bindPending) {
      // An earlier close of an unbound server cannot acknowledge this late bind.
      this.#bindPending = false; this.#actualClose = false; this.#closeIssued = false;
    }
    if (this.#closePromise !== undefined) {this.#releaseEndpoint();}
    if (this.#sealed || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)) {
      this.sealAdmission(); return;
    }
    this.#ready.resolve();
  };
  readonly #failed = (): void => {this.sealAdmission();};
  readonly #dropped = (): void => {
    this.#droppedWithoutSocket += 1;
    if (!this.#draining) {this.#failed();}
  };
  readonly #aborted = (): void => {this.sealAdmission();};
  readonly #onClose = (): void => {
    if (!this.#bindPending && this.#server?.listening === false) {
      this.#actualClose = true; this.#serverClosed.resolve();
    }
    this.sealAdmission();
  };

  readonly #connection = (socket: Socket): void => {
    const closed = Promise.withResolvers<void>();
    this.#sockets.set(socket, closed.promise);
    socket.once("close", () => {this.#socketCloseEvents += 1; this.#sockets.delete(socket); closed.resolve();})
      .on("error", closedErrorSink);
    if (this.#draining && !this.#sealed) {socket.destroy(); return;}
    if (!this.#published || this.#sealed || this.#busy || this.#cutoff.signal.aborted || !this.#live(this.#config.deadline)) {
      socket.destroy(); this.#failed(); return;
    }
    this.#busy = true;
    // Publish pending work before invoking the retained consumer, which may
    // synchronously abort/reenter. No listener admission is restored until both
    // the consumer and the actual native socket have finished.
    const work = Promise.withResolvers<void>();
    this.#work = work.promise;
    this.#consumerPending = true;
    void this.#consume(socket, closed.promise).then(() => {this.#busy = false; return work.resolve();});
  };

  async #consume(socket: Socket, closed: Promise<void>): Promise<void> {
    try {await this.#accept(socket, this.#cutoff.signal);} catch {this.#failed();}
    finally {this.#consumerPending = false;}
    if (!socket.destroyed) {socket.destroy(); this.#failed();}
    await closed;
  }

  public settleAccepted(): Promise<Readonly<{state: "settled" | "unknown"}>> {
    if (this.#settlement !== undefined) {return this.#settlement;}
    this.#draining = true;
    this.#settlement = this.#settleAccepted();
    return this.#settlement;
  }

  async #settleAccepted(): Promise<Readonly<{state: "settled" | "unknown"}>> {
    try {
      if (!this.#published || this.#sealed || this.#cutoff.signal.aborted) {throw failure();}
      await this.#clock.within(this.#config.deadline, async () => {await this.#work;}, this.#cutoff.signal);
      if (this.#sealed || this.#cutoff.signal.aborted || this.#busy || !this.#live(this.#config.deadline)) {throw failure();}
      return Object.freeze({state: "settled"});
    } catch {
      this.sealAdmission();
      return Object.freeze({state: "unknown"});
    }
  }

  public sealAdmission(): void {
    if (this.#sealed) {return;}
    this.#sealed = true;
    this.#ready.reject(failure());
    this.#operationWatch?.abort();
    this.#cutoff.signal.removeEventListener("abort", this.#aborted);
    if (!this.#cutoff.signal.aborted) {this.#cutoff.abort(failure());}
    for (const socket of this.#sockets.keys()) {socket.destroy();}
  }

  public close(): Promise<Closure> {
    if (this.#closePromise !== undefined) {return this.#closePromise;}
    const completion = Promise.withResolvers<Closure>();
    this.#closePromise = completion.promise;
    this.sealAdmission();
    this.#releaseEndpoint();
    void this.#observeClosure().then(completion.resolve, () => completion.resolve(Object.freeze({ state: "unknown" })));
    return this.#closePromise;
  }

  #releaseEndpoint(): void {
    if (this.#server === undefined || this.#closeIssued || this.#actualClose) {return;}
    // A bound handle is observable even before the listening callback runs.
    if (this.#server.listening) {this.#bindPending = false;}
    this.#closeIssued = true;
    try {this.#server.close();} catch { /* No close acknowledgement: retain unknown custody. */ }
  }

  async #observeClosure(): Promise<Closure> {
    if (this.#server === undefined) {return Object.freeze({ state: "closed" });}
    const watch = new AbortController();
    try {
      await this.#clock.within(this.#config.closureDeadline, async () => {
        await this.#serverClosed.promise;
        await Promise.all([this.#work, ...this.#sockets.values()]);
      }, watch.signal);
      if (!this.#live(this.#config.closureDeadline)) {throw failure();}
    } catch {return Object.freeze({ state: "unknown" });}
    finally {watch.abort();}
    const closed = this.#actualClose && !this.#bindPending && this.#server.listening === false
      && this.#sockets.size === 0 && !this.#busy;
    // Keep late-bind/close observers even after an unknown receipt. Final release
    // remains armed, but a late acknowledgement never rewrites that receipt.
    return Object.freeze({ state: closed ? "closed" : "unknown" });
  }
}
