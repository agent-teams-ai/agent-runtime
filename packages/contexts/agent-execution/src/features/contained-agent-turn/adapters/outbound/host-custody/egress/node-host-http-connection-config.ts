import type { HttpEgressExpectedRequest, HttpEgressLimits } from "./http-egress-contracts.js";

export type NodeHostHttpConnectionConfig = Readonly<{
  expectedRequest: HttpEgressExpectedRequest;
  limits: HttpEgressLimits;
  maxHeaderFields?: number;
  readHighWaterMark?: number;
  writeHighWaterMark?: number;
  headerTimeoutMs?: number;
  closeTimeoutMs?: number;
}>;

export type FixedNodeHostHttpConnectionConfig = Readonly<{
  expectedRequest: HttpEgressExpectedRequest;
  limits: HttpEgressLimits;
  maxHeaderFields: number;
  readHighWaterMark: number;
  writeHighWaterMark: number;
  headerTimeoutMs: number;
  closeTimeoutMs: number;
}>;

export class NodeHostHttpConnectionError extends Error {
  public constructor(public readonly kind: "invalid_configuration" | "invalid_socket" | "write_failed"
    | "closed" | "deadline" | "cancelled") {
    super(kind);
    this.name = "NodeHostHttpConnectionError";
  }
}

const bounded = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const supportedBodyPolicy = (expected: HttpEgressExpectedRequest, limits: HttpEgressLimits): boolean => {
  if (expected.bodyMode === undefined) {return expected.method === "POST";}
  return expected.bodyMode === "forbidden" && (expected.method === "GET" || expected.method === "HEAD")
    && limits.maxInboundBodyBytes === 0;
};

export const fixNodeHostHttpConnectionConfig = (input: NodeHostHttpConnectionConfig): FixedNodeHostHttpConnectionConfig => {
  const config = Object.freeze({
    expectedRequest: Object.freeze({ ...input.expectedRequest }),
    limits: Object.freeze({ ...input.limits }),
    maxHeaderFields: input.maxHeaderFields ?? 64,
    readHighWaterMark: input.readHighWaterMark ?? 65_536,
    writeHighWaterMark: input.writeHighWaterMark ?? 65_536,
    headerTimeoutMs: input.headerTimeoutMs ?? 5_000,
    closeTimeoutMs: input.closeTimeoutMs ?? 2_000,
  });
  if (!supportedBodyPolicy(config.expectedRequest, config.limits)
    || !bounded(config.limits.maxInboundHeaderBytes, 1, 16_384)
    || !bounded(config.limits.maxInboundBodyBytes, 0, 1_048_576)
    || !bounded(config.maxHeaderFields, 1, 64)
    || !bounded(config.readHighWaterMark, 1, 65_536)
    || !bounded(config.writeHighWaterMark, 1, 65_536)
    || !bounded(config.headerTimeoutMs, 1, 5_000)
    || !bounded(config.closeTimeoutMs, 1, 2_000)
    || !bounded(config.limits.deadline, 0, Number.MAX_SAFE_INTEGER)
    || !bounded(config.limits.closureDeadline, 0, Number.MAX_SAFE_INTEGER)) {
    throw new NodeHostHttpConnectionError("invalid_configuration");
  }
  return config;
};

type SocketEvent = "readable" | "end" | "finish" | "drain" | "close" | "error" | "timeout";
type SocketListener = (...arguments_: readonly unknown[]) => void;

/** Narrow private deterministic fault seam; production binding requires net.Socket. */
export interface OwnedNodeHostHttpSocket {
  readonly readableLength: number;
  readonly writableLength: number;
  readonly readableHighWaterMark: number;
  readonly writableHighWaterMark: number;
  readonly readableEncoding: string | null;
  readonly readableFlowing: boolean | null;
  readonly readableEnded: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly allowHalfOpen: boolean;
  readonly connecting: boolean;
  readonly closed: boolean;
  readonly destroyed: boolean;
  on(event: SocketEvent, listener: SocketListener): this;
  off(event: SocketEvent, listener: SocketListener): this;
  listenerCount(event: SocketEvent | "data"): number;
  read(size: number): unknown;
  write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end(): this;
  destroy(): this;
}
