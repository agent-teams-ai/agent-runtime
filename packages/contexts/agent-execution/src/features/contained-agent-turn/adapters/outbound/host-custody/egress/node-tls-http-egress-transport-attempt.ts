import { httpSignalAborted } from "./http-ingress-validation.js";
import type { X509Certificate } from "node:crypto";
import type { LookupFunction } from "node:net";
import type { ConnectionOptions, PeerCertificate } from "node:tls";

import type {
  HttpEgressDispatch,
  HttpEgressTransportAttempt,
  HttpEgressTransportBinding,
  HttpEgressTransportSession,
} from "./http-egress-ports.js";
import { intrinsicUint8ArrayLength } from "./http-byte-intrinsics.js";
import {
  closureReceiptDigest,
  createBinding,
  NodeTlsHttpEgressError,
  parentIdentityCheck,
  type CanonicalLiteralAddress,
  type FixedNodeTlsLimits,
  type FixedNodeTlsTrust,
} from "./node-tls-http-egress-transport-support.js";

export type NodeTlsSocketEvent = "close" | "end" | "error" | "readable" | "secureConnect" | "timeout";
export type NodeTlsSocketListener = (...arguments_: readonly unknown[]) => void;

/** Structural seam used only by deterministic socket-race tests. Production supplies a real TLSSocket. */
export interface OwnedNodeTlsSocket {
  readonly authorized: boolean;
  readonly alpnProtocol: string | false | null;
  readonly servername: string | false | null;
  readonly remoteAddress: string | undefined;
  readonly remotePort: number | undefined;
  readonly readableLength: number;
  readonly closed: boolean;
  readonly destroyed: boolean;
  once(event: NodeTlsSocketEvent, listener: NodeTlsSocketListener): this;
  on(event: NodeTlsSocketEvent, listener: NodeTlsSocketListener): this;
  off(event: NodeTlsSocketEvent, listener: NodeTlsSocketListener): this;
  setTimeout(milliseconds: number): this;
  destroy(error?: Error): this;
  write(buffer: Uint8Array, callback: (error?: Error | null) => void): boolean;
  disableRenegotiation(): void;
  getProtocol(): string | null;
  getPeerX509Certificate(): X509Certificate | undefined;
  isSessionReused(): boolean;
  iterator(options?: Readonly<{ destroyOnReturn?: boolean }>): AsyncIterableIterator<unknown>;
  read?(): unknown;
}

export type NodeTlsHttpEgressConnector = (options: ConnectionOptions) => OwnedNodeTlsSocket;

type CloseReceipt = Readonly<{ state: "closed" | "unknown"; receiptDigest: string }>;

const failedBeforeConsumption = (): HttpEgressDispatch => Object.freeze({
  status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged",
});

const failedAfterConsumption = (): HttpEgressDispatch => Object.freeze({
  status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost",
});

const canonicalConnectFailure = (): NodeTlsHttpEgressError => new NodeTlsHttpEgressError("connect_failed");

const nextResponseChunk = (socket: OwnedNodeTlsSocket, iterator: AsyncIterator<unknown>, closedByHost: boolean)
  : Promise<IteratorResult<unknown>> => {
  if (closedByHost && socket.closed) {
    if (socket.readableLength === 0) {return Promise.resolve({done: true, value: undefined});}
    // Node's async iterator throws premature-close even with queued data after
    // destroy(). Read that retained queue so surplus remains byte evidence.
    if (socket.read !== undefined) {return Promise.resolve({done: false, value: socket.read()});}
  }
  return iterator.next();
};

const boundedResponse = (
  socket: OwnedNodeTlsSocket,
  signal: AbortSignal | undefined,
  closedByHost: () => boolean,
): AsyncIterable<Uint8Array> => Object.freeze({
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    const abort = (): void => {socket.destroy(canonicalConnectFailure());};
    try {
      const iterator = socket.iterator({ destroyOnReturn: false });
      for (;;) {
        let next: IteratorResult<unknown>;
        try {
          if (httpSignalAborted(signal)) {abort();}
          else {signal?.addEventListener("abort", abort, { once: true });}
          next = await nextResponseChunk(socket, iterator, closedByHost());
        } finally {
          // A framed response may leave this generator suspended at yield.
          signal?.removeEventListener("abort", abort);
        }
        const done = Boolean(next.done);
        if (done) {return;}
        const value: unknown = next.value;
        if (!(value instanceof Uint8Array)) {throw canonicalConnectFailure();}
        yield value;
      }
    } catch {
      throw canonicalConnectFailure();
    }
  },
});

class NodeTlsHttpEgressSession implements HttpEgressTransportSession {
  readonly #socket: OwnedNodeTlsSocket;
  readonly #binding: HttpEgressTransportBinding;
  readonly #isUsable: () => boolean;
  readonly #closedByHost: () => boolean;
  #dispatched = false;

  public constructor(
    socket: OwnedNodeTlsSocket,
    binding: HttpEgressTransportBinding,
    isUsable: () => boolean,
    closedByHost: () => boolean,
  ) {
    this.#socket = socket;
    this.#binding = binding;
    this.#isUsable = isUsable;
    this.#closedByHost = closedByHost;
    Object.freeze(this);
  }

  public get binding(): HttpEgressTransportBinding {return this.#binding;}

  public async dispatch(
    consumeAuthorizedRequest: () => Uint8Array | undefined,
    signal?: AbortSignal,
  ): Promise<HttpEgressDispatch> {
    if (this.#dispatched || !this.#isUsable() || httpSignalAborted(signal)) {return failedBeforeConsumption();}
    this.#dispatched = true;

    return await new Promise<HttpEgressDispatch>(resolve => {
      const progress = {
        settled: false,
        consumed: false,
        acceptedLength: 0,
        writeCompleted: false,
        writeReturned: false,
        writeCallbackSucceeded: false,
        responseReadable: false,
        failedDisposition: false,
      };

      const cleanup = (): void => {
        this.#socket.off("readable", readable);
        this.#socket.off("end", failed);
        this.#socket.off("close", failed);
        this.#socket.off("error", failed);
        this.#socket.off("timeout", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const settle = (result: HttpEgressDispatch): void => {
        if (progress.settled) {return;}
        progress.settled = true;
        cleanup();
        resolve(result);
      };
      const failed = (): void => {
        if (progress.settled || progress.failedDisposition) {return;}
        progress.failedDisposition = true;
        this.#socket.destroy();
        settle(progress.consumed ? failedAfterConsumption() : failedBeforeConsumption());
      };
      const aborted = (): void => {failed();};
      const readable = (): void => {
        if (!progress.consumed || progress.acceptedLength === 0 || this.#socket.readableLength === 0) {return;}
        progress.responseReadable = true;
        if (!progress.writeCompleted || progress.settled) {return;}
        if (progress.failedDisposition || httpSignalAborted(signal) || !this.#isUsable()) {failed(); return;}
        settle(Object.freeze({
          status: "response",
          acceptedRequestBytes: progress.acceptedLength,
          acknowledgement: "acknowledged",
          response: boundedResponse(this.#socket, signal, this.#closedByHost),
        }));
      };

      this.#socket.once("readable", readable);
      this.#socket.once("end", failed);
      this.#socket.once("close", failed);
      this.#socket.once("error", failed);
      this.#socket.once("timeout", failed);
      signal?.addEventListener("abort", aborted, { once: true });

      if (!this.#isUsable() || httpSignalAborted(signal)) {failed(); return;}
      try {
        const bytes = consumeAuthorizedRequest();
        const byteLength = intrinsicUint8ArrayLength(bytes);
        if (bytes === undefined || byteLength === undefined || byteLength === 0) {
          settle(failedBeforeConsumption());
          return;
        }
        // Borrowed from the Host dispatch boundary; its prepared custody owns zeroization.
        const authorizedBytes = bytes;
        progress.consumed = true;
        progress.acceptedLength = byteLength;
        // Consumption may synchronously revoke custody or close this attempt.
        // Recheck before borrowing bytes for the socket, without an async gap.
        if (progress.settled || progress.failedDisposition) {return;}
        if (!this.#isUsable() || httpSignalAborted(signal)) {failed(); return;}
        // Deliberately no await or promise boundary between authority consumption and this write.
        this.#socket.write(authorizedBytes, error => {
          if (error !== undefined && error !== null) {failed();}
          else {
            progress.writeCallbackSucceeded = true;
            if (progress.writeReturned) {
              progress.writeCompleted = true;
              if (progress.responseReadable || this.#socket.readableLength > 0) {readable();}
            }
          }
        });
        progress.writeReturned = true;
        if (progress.writeCallbackSucceeded) {progress.writeCompleted = true;}
        if (this.#socket.readableLength > 0) {readable();}
      } catch {
        failed();
      }
    });
  }
}

export type NodeTlsAttemptInput = Readonly<{
  selectedAddress: CanonicalLiteralAddress;
  originPort: number;
  sni: string;
  trust: FixedNodeTlsTrust;
  limits: FixedNodeTlsLimits;
  connector: NodeTlsHttpEgressConnector;
  checkServerIdentity: (hostname: string, certificate: PeerCertificate) => Error | undefined;
}>;

export class NodeTlsHttpEgressAttempt implements HttpEgressTransportAttempt {
  readonly #input: NodeTlsAttemptInput;
  readonly #readyPromise: Promise<HttpEgressTransportSession>;
  readonly #closedPromise: Promise<void>;
  readonly #socket: OwnedNodeTlsSocket | undefined;
  #session: NodeTlsHttpEgressSession | undefined;
  #state: "connecting" | "ready" | "closing" | "closed" | "failed" = "connecting";
  #closePromise: Promise<CloseReceipt> | undefined;
  readonly #connectTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(input: NodeTlsAttemptInput) {
    this.#input = input;
    const ready = Promise.withResolvers<HttpEgressTransportSession>();
    const closed = Promise.withResolvers<void>();
    this.#readyPromise = ready.promise;
    this.#closedPromise = closed.promise;
    // An attempt owns rejection observation even when its caller closes without awaiting readiness.
    void this.#readyPromise.catch(() => {});
    let identityChecked = false;

    const lookup: LookupFunction = (_hostname, _options, callback): void => {
      callback(canonicalConnectFailure(), "", 0);
    };
    let socket: OwnedNodeTlsSocket;
    try {
      socket = input.connector({
        host: input.selectedAddress.address,
        port: input.originPort,
        servername: input.sni,
        ALPNProtocols: ["http/1.1"],
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
        secureContext: input.trust.secureContext,
        session: undefined,
        lookup,
        checkServerIdentity: parentIdentityCheck(input.checkServerIdentity, input.sni, () => {identityChecked = true;}),
      });
    } catch {
      this.#state = "failed";
      ready.reject(canonicalConnectFailure());
      closed.resolve();
      return;
    }
    this.#socket = socket;
    socket.setTimeout(input.limits.responseIdleTimeoutMs);

    const onClosed = (): void => {
      if (this.#connectTimer !== undefined) {clearTimeout(this.#connectTimer);}
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("secureConnect", onSecure);
      this.#state = "closed";
      closed.resolve();
      if (this.#session === undefined) {ready.reject(new NodeTlsHttpEgressError("attempt_closed"));}
    };
    const onError = (): void => {
      if (this.#session === undefined) {
        this.#state = "failed";
        ready.reject(canonicalConnectFailure());
      } else {
        this.#state = "failed";
      }
      socket.destroy();
    };
    const onTimeout = (): void => {
      if (this.#session === undefined) {ready.reject(new NodeTlsHttpEgressError("connect_timeout"));}
      this.#state = "failed";
      socket.destroy();
    };
    const onSecure = (): void => {
      if (this.#state !== "connecting") {socket.destroy(); return;}
      try {
        socket.disableRenegotiation();
        const binding = createBinding({
          trust: input.trust,
          selectedAddress: input.selectedAddress,
          expectedPort: input.originPort,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          protocol: socket.getProtocol(),
          alpn: socket.alpnProtocol,
          servername: socket.servername,
          expectedSni: input.sni,
          certificate: socket.getPeerX509Certificate(),
          authorized: socket.authorized,
          identityChecked,
          sessionReused: socket.isSessionReused(),
        });
        if (this.#connectTimer !== undefined) {clearTimeout(this.#connectTimer);}
        this.#state = "ready";
        this.#session = new NodeTlsHttpEgressSession(
          socket,
          binding,
          () => this.#state === "ready" && !socket.destroyed && !socket.closed,
          () => this.#closePromise !== undefined,
        );
        ready.resolve(this.#session);
      } catch (error) {
        this.#state = "failed";
        ready.reject(error instanceof NodeTlsHttpEgressError ? error : new NodeTlsHttpEgressError("tls_validation_failed"));
        socket.destroy();
      }
    };

    socket.once("secureConnect", onSecure);
    socket.once("close", onClosed);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
    this.#connectTimer = setTimeout(() => {onTimeout();}, input.limits.connectTimeoutMs);
  }

  public ready(): Promise<HttpEgressTransportSession> {return this.#readyPromise;}

  public close(): Promise<CloseReceipt> {
    if (this.#closePromise !== undefined) {return this.#closePromise;}
    this.#closePromise = this.#closeOwnedSocket();
    return this.#closePromise;
  }

  async #closeOwnedSocket(): Promise<CloseReceipt> {
    if (this.#state === "closed") {
      return Object.freeze({ state: "closed", receiptDigest: closureReceiptDigest("closed") });
    }
    this.#state = "closing";
    if (this.#connectTimer !== undefined) {clearTimeout(this.#connectTimer);}
    this.#socket?.destroy();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      this.#closedPromise.then(() => true),
      new Promise<false>(resolve => {
        closeTimer = setTimeout(() => {resolve(false);}, this.#input.limits.closeTimeoutMs);
      }),
    ]);
    if (closeTimer !== undefined) {clearTimeout(closeTimer);}
    const state = closed ? "closed" : "unknown";
    return Object.freeze({ state, receiptDigest: closureReceiptDigest(state) });
  }
}
