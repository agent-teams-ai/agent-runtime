import { createHash } from "node:crypto";
import type { HttpEgressConnection } from "./http-egress-contracts.js";
import type { HttpEgressClock } from "./http-egress-ports.js";
import { retainHttpEgressClock } from "./http-egress-runtime-security-v2.js";
import { NodeHostHttpConnectionError, type FixedNodeHostHttpConnectionConfig,
  type OwnedNodeHostHttpSocket } from "./node-host-http-connection-config.js";
import { NodeHostHttpRequestFrame } from "./node-host-http-request-frame.js";
import { NodeHostHttpSocketWrite } from "./node-host-http-socket-write.js";
import { StrictHttpRequestError } from "./strict-http-request.js";
import { intrinsicUint8ArrayLength, zeroHttpBytes } from "./http-byte-intrinsics.js";

type CloseReceipt = Awaited<ReturnType<HttpEgressConnection["close"]>>;
type Next = IteratorResult<Uint8Array>;
const done = (): Next => ({ done: true, value: undefined });
// After actual close, a stateless sink replaces the resource-owning error handler.
// Late synthetic/socket errors must not become unhandled or retain payload custody.
const closedErrorSink = (): void => {};
const receipt = (state: "closed" | "unknown"): CloseReceipt => Object.freeze({ state,
  receiptDigest: createHash("sha256").update(`agent-runtime.node-host-http-closure/v1\n${state}\n`).digest("hex") });

/**
 * Private accepted-socket custody, not operation disposition. Binding allocates.
 * At default caps retained transport bytes <= 16 KiB head + 1040 KiB frame +
 * 64 KiB read queue + 64 KiB bounded read result + 64 KiB write copy. Node's write
 * queue borrows that copy. No per-chunk queue or second request is retained.
 * The semantic parser's frame/body copies are separate (up to 2080 KiB); prepared
 * wire/body and upstream queues still require the future binder's operation-wide
 * 8 MiB reservation. This transport cannot confer that missing budget authority.
 */
export class NodeHostHttpConnectionCustody {
  readonly #config: FixedNodeHostHttpConnectionConfig;
  readonly #clock: HttpEgressClock;
  readonly #cutoff: AbortController;
  #socket: OwnedNodeHostHttpSocket | undefined;
  #frame: NodeHostHttpRequestFrame | undefined;
  #closed!: ReturnType<typeof Promise.withResolvers<void>>;
  #headerWatch: AbortController | undefined;
  #operationWatch: AbortController | undefined;
  #closeWatch: AbortController | undefined;
  #pending: ReturnType<typeof Promise.withResolvers<Next>> | undefined;
  #write: NodeHostHttpSocketWrite | undefined;
  #failure: Error | undefined;
  #closePromise: Promise<CloseReceipt> | undefined;
  #closeMode: "complete" | "abort" | undefined;
  #iteratorTaken = false;
  #yielded = false;
  #eof = false;
  #pumping = false;
  #peerEnded = false;
  #finished = false;
  #actuallyClosed = false;
  #forced = false;
  #tainted = false;
  #endCalled = false;
  #headerDeadline = 0;
  #closeDeadline = 0;

  public constructor(config: FixedNodeHostHttpConnectionConfig, clock: HttpEgressClock, cutoff: AbortController) {
    this.#config = config;
    this.#clock = retainHttpEgressClock(clock);
    this.#cutoff = cutoff;
  }

  public bind(socket: OwnedNodeHostHttpSocket): Readonly<{ connection: HttpEgressConnection; signal: AbortSignal }> {
    if (this.#socket !== undefined || !this.#pristine(socket)) {throw new NodeHostHttpConnectionError("invalid_socket");}
    this.#socket = socket;
    this.#closed = Promise.withResolvers<void>();
    this.#frame = new NodeHostHttpRequestFrame(this.#config);
    const connection: HttpEgressConnection = Object.freeze({
      request: Object.freeze({ [Symbol.asyncIterator]: () => this.#iterator() }),
      write: (chunk: Uint8Array) => this.#writeChunk(chunk),
      close: (mode: "complete" | "abort") => this.#close(mode),
    });
    socket.on("error", this.#error).on("close", this.#onClose).on("end", this.#onEnd)
      .on("finish", this.#onFinish).on("drain", this.#onDrain).on("timeout", this.#timeout)
      .on("readable", this.#readable);
    this.#cutoff.signal.addEventListener("abort", this.#aborted, { once: true });
    if (this.#cutoff.signal.aborted) {this.#aborted();}
    else {
      let now: number;
      try {now = this.#clock.now();} catch {now = Number.NaN;}
      this.#headerDeadline = Math.min(this.#config.limits.deadline, now + this.#config.headerTimeoutMs);
      this.#headerWatch = this.#watch(this.#headerDeadline);
      this.#operationWatch = this.#watch(this.#config.limits.deadline);
      this.#readable();
    }
    return Object.freeze({ connection, signal: this.#cutoff.signal });
  }

  #pristine(socket: OwnedNodeHostHttpSocket): boolean {
    return !socket.destroyed && !socket.closed && !socket.connecting && socket.allowHalfOpen
      && !socket.readableEnded && !socket.writableEnded && !socket.writableFinished
      && socket.readableEncoding === null && socket.readableFlowing !== true
      && socket.writableLength === 0 && socket.listenerCount("data") === 0
      && socket.listenerCount("readable") === 0
      && socket.readableHighWaterMark > 0 && socket.readableHighWaterMark <= this.#config.readHighWaterMark
      && socket.writableHighWaterMark > 0 && socket.writableHighWaterMark <= this.#config.writeHighWaterMark;
  }

  #watch(deadline: number): AbortController {
    const watch = new AbortController();
    if (!this.#live(deadline)) {return watch;}
    try {
      void this.#clock.within(deadline, () => this.#closed.promise, watch.signal).catch(() => {
        if (!watch.signal.aborted) {this.#fail(this.#frame!.error("deadline"));}
      });
    } catch {this.#fail(this.#frame!.error("deadline"));}
    return watch;
  }

  #live(deadline = this.#config.limits.deadline): boolean {
    if (this.#failure !== undefined || this.#actuallyClosed) {return false;}
    let now: number;
    try {now = this.#clock.now();} catch {now = Number.NaN;}
    if (!Number.isSafeInteger(now) || now >= deadline || !Number.isSafeInteger(deadline)) {
      this.#fail(this.#frame!.error("deadline")); return false;
    }
    return true;
  }

  #iterator(): AsyncIterableIterator<Uint8Array> {
    if (this.#iteratorTaken) {throw new NodeHostHttpConnectionError("closed");}
    this.#iteratorTaken = true;
    const iterator: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => this.#next(),
      return: async () => {
        if (!this.#eof) {this.#fail(this.#frame!.error("cancelled"));}
        this.#frame!.release();
        return done();
      },
    };
    return iterator;
  }

  #next(): Promise<Next> {
    if (this.#pending !== undefined) {
      this.#fail(this.#frame!.error("malformed"));
      return Promise.reject(this.#failure);
    }
    // A yielded frame is borrowed until next()/return(); strictHttpRequest copies it.
    if (this.#yielded) {this.#frame!.release();}
    this.#readable();
    if (!this.#endCalled) {this.#live();}
    if (this.#failure !== undefined) {return Promise.reject(this.#failure);}
    if (this.#yielded) {this.#eof = true; return Promise.resolve(done());}
    this.#pending = Promise.withResolvers<Next>();
    const promise = this.#pending.promise;
    this.#publish();
    return promise;
  }

  #publish(): void {
    if (!this.#frame!.complete || this.#pending === undefined || this.#failure !== undefined) {return;}
    if (!this.#live()) {return;}
    this.#yielded = true;
    this.#pending.resolve({ done: false, value: this.#frame!.bytes! });
    this.#pending = undefined;
  }

  readonly #readable = (): void => {
    if (this.#pumping || this.#failure !== undefined || this.#actuallyClosed) {return;}
    this.#pumping = true;
    try {
      this.#pump();
      if (this.#frame!.headComplete) {this.#headerWatch?.abort();}
      this.#publish();
    } catch (error) {
      this.#fail(error instanceof StrictHttpRequestError ? this.#frame!.error(error.kind) : this.#frame!.error("malformed"));
    } finally {this.#pumping = false;}
  };

  #pump(): void {
    const socket = this.#socket!;
    do {
      while (socket.readableLength > 0 && this.#failure === undefined) {this.#readBounded();}
      if (this.#failure !== undefined) {return;}
      // Node readable-mode EOF needs a read even when the buffer is empty. read(0)
      // cannot allocate a payload result; it also keeps later-byte surveillance live.
      if (socket.read(0) !== null) {throw this.#frame!.error("malformed");}
    } while (socket.readableLength > 0 && this.#failure === undefined);
  }

  #readBounded(): void {
    const socket = this.#socket!;
    const deadline = this.#frame!.headComplete ? this.#config.limits.deadline : this.#headerDeadline;
    if (!this.#endCalled && !this.#live(deadline)) {return;}
    // Inspect pending surplus BEFORE allocating a read result or publishing EOF.
    if (this.#frame!.complete || socket.readableLength > this.#config.readHighWaterMark) {
      this.#frame!.observePending(socket.readableLength);
      throw this.#frame!.error(this.#frame!.complete ? "smuggling" : "body_oversized");
    }
    const bytes = socket.read(Math.min(socket.readableLength, this.#config.readHighWaterMark));
    try {
      if (!intrinsicUint8ArrayLength(bytes)) {throw this.#frame!.error("malformed");}
      this.#frame!.push(bytes);
      this.#live(deadline);
    } finally {zeroHttpBytes(bytes);}
  }

  readonly #onEnd = (): void => {
    this.#peerEnded = true;
    this.#readable();
    if (!this.#frame!.complete) {this.#fail(this.#frame!.error("malformed"));}
  };
  readonly #onFinish = (): void => {
    this.#finished = true;
    if (!this.#endCalled) {this.#fail(new NodeHostHttpConnectionError("closed"));}
  };
  readonly #onDrain = (): void => {this.#write?.drain();};
  readonly #error = (): void => {this.#fail(new NodeHostHttpConnectionError("closed"));};
  readonly #timeout = (): void => {this.#fail(this.#frame!.error("deadline"));};
  readonly #aborted = (): void => {
    if (this.#failure === undefined) {
      this.#fail(this.#frame!.error("cancelled"));
    }
  };

  #fail(error: Error): void {
    if (this.#failure !== undefined) {return;}
    this.#failure = error;
    this.#tainted = true;
    this.#headerWatch?.abort();
    this.#operationWatch?.abort();
    this.#pending?.reject(error);
    this.#pending = undefined;
    this.#frame!.release();
    if (this.#write !== undefined && !this.#write.succeeded) {this.#write.fail();}
    if (!this.#cutoff.signal.aborted) {this.#cutoff.abort(error);}
    this.#destroy();
  }

  #destroy(): void {
    if (this.#actuallyClosed || this.#forced) {return;}
    this.#forced = true;
    try {this.#socket!.destroy();} catch {this.#tainted = true;}
  }

  readonly #onClose = (...args: readonly unknown[]): void => {
    if (this.#actuallyClosed) {return;}
    this.#actuallyClosed = true;
    // Actual event delivery must still be inside the retained close interval.
    // The retained clock rejects regression; neither timer order nor a later
    // physical close can restore lost deadline/clock authority.
    try {
      const now = this.#clock.now();
      if (!Number.isSafeInteger(now) || now >= this.#closeDeadline) {
        throw new NodeHostHttpConnectionError("deadline");
      }
    } catch {this.#fail(new NodeHostHttpConnectionError("deadline"));}
    if (args[0] === true || this.#socket!.readableLength !== 0) {
      this.#fail(new NodeHostHttpConnectionError("closed"));
    }
    if (!this.#endCalled && !this.#forced) {this.#fail(new NodeHostHttpConnectionError("closed"));}
    this.#write?.closed();
    this.#pending?.reject(this.#failure ?? new NodeHostHttpConnectionError("closed"));
    this.#pending = undefined;
    this.#frame!.release();
    this.#headerWatch?.abort();
    this.#operationWatch?.abort();
    // Resolve the close watch normally; aborting it here would hide an already
    // rejected watchdog behind an indistinguishable retirement rejection.
    this.#cutoff.signal.removeEventListener("abort", this.#aborted);
    this.#socket!.off("readable", this.#readable).off("end", this.#onEnd).off("finish", this.#onFinish)
      .off("drain", this.#onDrain).off("timeout", this.#timeout).off("close", this.#onClose)
      .off("error", this.#error).on("error", closedErrorSink);
    this.#closed.resolve();
  };

  async #writeChunk(chunk: Uint8Array): Promise<void> {
    this.#readable();
    if (this.#closeMode !== undefined || !this.#eof || !this.#live()) {
      throw new NodeHostHttpConnectionError("closed");
    }
    if (this.#write !== undefined && !this.#write.succeeded) {
      this.#fail(new NodeHostHttpConnectionError("write_failed"));
      throw new NodeHostHttpConnectionError("write_failed");
    }
    this.#write = new NodeHostHttpSocketWrite(this.#socket!, this.#cutoff);
    this.#write.start(chunk, this.#config.writeHighWaterMark);
    await this.#write.completion;
    if (!this.#live()) {throw new NodeHostHttpConnectionError("write_failed");}
  }

  #close(mode: "complete" | "abort"): Promise<CloseReceipt> {
    // Publish identity before cutoff/clock/socket hooks can reenter close().
    const completion = this.#closePromise === undefined ? Promise.withResolvers<CloseReceipt>() : undefined;
    if (completion !== undefined) {this.#closePromise = completion.promise;}
    if (mode === "abort" && this.#closeMode !== "abort" && !this.#actuallyClosed) {
      this.#closeMode = "abort";
      this.#fail(this.#frame!.error("cancelled"));
    }
    this.#closeMode ??= mode;
    if (completion !== undefined) {
      void this.#closeOwned().then(completion.resolve, () => completion.resolve(receipt("unknown")));
    }
    return this.#closePromise!;
  }

  async #closeOwned(): Promise<CloseReceipt> {
    this.#closeWatch = new AbortController();
    try {
      const now = this.#clock.now();
      const deadline = Math.min(this.#config.limits.closureDeadline, now + this.#config.closeTimeoutMs);
      this.#closeDeadline = deadline;
      if (!Number.isSafeInteger(now) || now >= deadline) {throw new NodeHostHttpConnectionError("deadline");}
      // Start the close watchdog BEFORE waiting for a write callback or FIN.
      const observing = this.#clock.within(deadline, () => this.#closed.promise, this.#closeWatch.signal);
      void observing.catch(() => {});
      void this.#finishWrites().catch(() => this.#fail(new NodeHostHttpConnectionError("write_failed")));
      await observing;
    } catch {
      this.#fail(new NodeHostHttpConnectionError("deadline"));
    }
    this.#headerWatch?.abort();
    this.#operationWatch?.abort();
    this.#closeWatch.abort();
    const clean = this.#actuallyClosed && !this.#tainted && !this.#forced
      && this.#endCalled && this.#finished && this.#peerEnded && this.#eof;
    return receipt(clean ? "closed" : "unknown");
  }

  async #finishWrites(): Promise<void> {
    if (this.#closeMode !== "complete" || this.#failure !== undefined || this.#actuallyClosed) {return;}
    if (!this.#eof) {this.#fail(this.#frame!.error("malformed")); return;}
    await this.#write?.completion;
    this.#readable();
    if (this.#closeMode !== "complete" || !this.#live()) {return;}
    this.#endCalled = true;
    this.#operationWatch?.abort();
    try {this.#socket!.end();} catch {this.#fail(new NodeHostHttpConnectionError("closed"));}
  }
}
