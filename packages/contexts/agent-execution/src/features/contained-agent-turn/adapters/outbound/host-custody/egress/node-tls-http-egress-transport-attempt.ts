import type { X509Certificate } from "node:crypto";
import type { LookupFunction } from "node:net";
import type { ConnectionOptions, PeerCertificate } from "node:tls";

import type {
  HttpEgressDispatch,
  HttpEgressTransportAttempt,
  HttpEgressTransportBinding,
  HttpEgressTransportSession,
} from "./http-egress-ports.js";
import { intrinsicUint8ArrayLength, zeroHttpBytes } from "./http-byte-intrinsics.js";
import {
  closureReceiptDigest,
  createBinding,
  NodeTlsHttpEgressError,
  parentIdentityCheck,
  type CanonicalLiteralAddress,
  type FixedNodeTlsLimits,
  type FixedNodeTlsTrust,
} from "./node-tls-http-egress-transport-support.js";

type SocketEvent = "close" | "end" | "error" | "readable" | "secureConnect" | "timeout";
type SocketListener = (...arguments_: readonly unknown[]) => void;

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
  once(event: SocketEvent, listener: SocketListener): this;
  on(event: SocketEvent, listener: SocketListener): this;
  off(event: SocketEvent, listener: SocketListener): this;
  setTimeout(milliseconds: number): this;
  destroy(error?: Error): this;
  write(buffer: Uint8Array, callback: (error?: Error | null) => void): boolean;
  disableRenegotiation(): void;
  getProtocol(): string | null;
  getPeerX509Certificate(): X509Certificate | undefined;
  isSessionReused(): boolean;
  iterator(options?: Readonly<{ destroyOnReturn?: boolean }>): AsyncIterableIterator<unknown>;
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

const boundedResponse = (
  socket: OwnedNodeTlsSocket,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> => Object.freeze({
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    const abort = (): void => {socket.destroy(canonicalConnectFailure());};
    try {
      const iterator = socket.iterator({ destroyOnReturn: false });
      while (true) {
        let next: IteratorResult<unknown>;
        try {
          if (signal?.aborted) {abort();}
          else {signal?.addEventListener("abort", abort, { once: true });}
          next = await iterator.next();
        } finally {
          // A framed response may leave this generator suspended at yield.
          signal?.removeEventListener("abort", abort);
        }
        if (next.done) {return;}
        const value = next.value;
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
  #dispatched = false;

  public constructor(
    socket: OwnedNodeTlsSocket,
    binding: HttpEgressTransportBinding,
    isUsable: () => boolean,
  ) {
    this.#socket = socket;
    this.#binding = binding;
    this.#isUsable = isUsable;
    Object.freeze(this);
  }

  public get binding(): HttpEgressTransportBinding {return this.#binding;}

  public async dispatch(
    consumeAuthorizedRequest: () => Uint8Array | undefined,
    signal?: AbortSignal,
  ): Promise<HttpEgressDispatch> {
    if (this.#dispatched || !this.#isUsable() || signal?.aborted) {return failedBeforeConsumption();}
    this.#dispatched = true;

    return await new Promise<HttpEgressDispatch>(resolve => {
      let settled = false;
      let consumed = false;
      let ownedBytes: Uint8Array | undefined;
      let acceptedLength = 0;
      let writeCompleted = false;
      let writeReturned = false;
      let writeCallbackSucceeded = false;
      let responseReadable = false;
      let failedDisposition = false;
      const zeroOwnedBytes = (): void => {
        zeroHttpBytes(ownedBytes);
        ownedBytes = undefined;
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
        if (settled) {return;}
        settled = true;
        cleanup();
        resolve(result);
      };
      const failed = (): void => {
        if (settled || failedDisposition) {return;}
        failedDisposition = true;
        this.#socket.destroy();
        settle(consumed ? failedAfterConsumption() : failedBeforeConsumption());
      };
      const aborted = (): void => {failed();};
      const readable = (): void => {
        if (!consumed || acceptedLength === 0 || this.#socket.readableLength === 0) {return;}
        responseReadable = true;
        if (!writeCompleted || settled) {return;}
        if (failedDisposition || signal?.aborted || !this.#isUsable()) {failed(); return;}
        settle(Object.freeze({
          status: "response",
          acceptedRequestBytes: acceptedLength,
          acknowledgement: "acknowledged",
          response: boundedResponse(this.#socket, signal),
        }));
      };

      this.#socket.once("readable", readable);
      this.#socket.once("end", failed);
      this.#socket.once("close", failed);
      this.#socket.once("error", failed);
      this.#socket.once("timeout", failed);
      signal?.addEventListener("abort", aborted, { once: true });

      if (!this.#isUsable() || signal?.aborted) {failed(); return;}
      try {
        const bytes = consumeAuthorizedRequest();
        const byteLength = intrinsicUint8ArrayLength(bytes);
        if (byteLength === undefined || byteLength === 0) {
          zeroHttpBytes(bytes);
          settle(failedBeforeConsumption());
          return;
        }
        const authorizedBytes = bytes as Uint8Array;
        consumed = true;
        ownedBytes = authorizedBytes;
        acceptedLength = byteLength;
        this.#socket.once("close", zeroOwnedBytes);
        // Deliberately no await or promise boundary between authority consumption and this write.
        this.#socket.write(authorizedBytes, error => {
          this.#socket.off("close", zeroOwnedBytes);
          zeroOwnedBytes();
          if (error !== undefined && error !== null) {failed();}
          else {
            writeCallbackSucceeded = true;
            if (writeReturned) {
              writeCompleted = true;
              if (responseReadable || this.#socket.readableLength > 0) {readable();}
            }
          }
        });
        writeReturned = true;
        if (writeCallbackSucceeded) {writeCompleted = true;}
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
  #socket: OwnedNodeTlsSocket | undefined;
  #session: NodeTlsHttpEgressSession | undefined;
  #state: "connecting" | "ready" | "closing" | "closed" | "failed" = "connecting";
  #closePromise: Promise<CloseReceipt> | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;

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
