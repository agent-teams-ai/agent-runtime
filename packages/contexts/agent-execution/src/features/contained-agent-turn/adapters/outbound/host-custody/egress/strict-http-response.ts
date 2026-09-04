import type { HttpEgressConnection, HttpEgressLimits } from "./http-egress-contracts.js";
import type { HttpEgressClock } from "./http-egress-ports.js";
import { zeroHttpBytes } from "./http-byte-intrinsics.js";

const decoder = new TextDecoder("ascii", { fatal: true });
const encoder = new TextEncoder();
const CRLF = new Uint8Array([13, 10]);
const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const addObservedBytes = (current: number, count: number): number => {
  const total = current + count;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
};

export type StrictHttpResponseResult = Readonly<{
  status: number;
  upstreamBytes: number;
  outboundBytes: number;
}>;

export class StrictHttpResponseError extends Error {
  public constructor(
    public readonly kind: "cancelled" | "stalled" | "malformed" | "truncated" | "oversized" | "backpressure" | "redirect",
    public readonly upstreamBytes: number,
    public readonly outboundBytes: number,
    public readonly outboundWriteUncertain = false,
  ) {
    super(kind);
    this.name = "StrictHttpResponseError";
  }
}

class DeadlineByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered = new Uint8Array();
  private ended = false;
  public bytesRead = 0;

  public constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly clock: HttpEgressClock,
    private readonly limits: HttpEgressLimits,
    private readonly signal?: AbortSignal,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async pull(): Promise<void> {
    if (this.signal?.aborted) {throw new StrictHttpResponseError("cancelled", this.bytesRead, 0);}
    if (this.clock.now() >= this.limits.deadline) {throw new StrictHttpResponseError("stalled", this.bytesRead, 0);}
    let next: IteratorResult<Uint8Array>;
    try {
      next = await this.clock.within(this.limits.deadline, () => this.iterator.next(), this.signal);
    } catch {
      throw new StrictHttpResponseError(this.signal?.aborted ? "cancelled" : "stalled", this.bytesRead, 0);
    }
    if (next.done) {
      this.ended = true;
      return;
    }
    if (!(next.value instanceof Uint8Array)) {throw new StrictHttpResponseError("malformed", this.bytesRead, 0);}
    if (next.value.byteLength === 0) {return;}
    this.bytesRead = addObservedBytes(this.bytesRead, next.value.byteLength);
    if (next.value.byteLength > this.limits.maxBufferedBytes
      || this.bytesRead > this.limits.maxUpstreamWireBytes) {
      throw new StrictHttpResponseError("oversized", this.bytesRead, 0);
    }
    const joined = new Uint8Array(this.buffered.byteLength + next.value.byteLength);
    joined.set(this.buffered);
    joined.set(next.value, this.buffered.byteLength);
    zeroHttpBytes(this.buffered);
    this.buffered = joined;
  }

  public async through(separator: Uint8Array, maximum: number): Promise<Uint8Array> {
    while (true) {
      const index = find(this.buffered, separator);
      if (index >= 0) {
        if (index + separator.byteLength > maximum) {
          throw new StrictHttpResponseError("oversized", this.bytesRead, 0);
        }
        const previous = this.buffered;
        const value = previous.slice(0, index);
        this.buffered = previous.slice(index + separator.byteLength);
        zeroHttpBytes(previous);
        return value;
      }
      if (this.buffered.byteLength > maximum) {throw new StrictHttpResponseError("oversized", this.bytesRead, 0);}
      if (this.ended) {throw new StrictHttpResponseError("truncated", this.bytesRead, 0);}
      await this.pull();
    }
  }

  public async take(maximum: number): Promise<Uint8Array | undefined> {
    while (this.buffered.byteLength === 0 && !this.ended) {await this.pull();}
    if (this.buffered.byteLength === 0) {return undefined;}
    const count = Math.min(maximum, this.buffered.byteLength);
    const previous = this.buffered;
    const value = previous.slice(0, count);
    this.buffered = previous.slice(count);
    zeroHttpBytes(previous);
    return value;
  }

  public async requireEnd(): Promise<void> {
    while (!this.ended) {await this.pull();}
    if (this.buffered.byteLength !== 0) {throw new StrictHttpResponseError("malformed", this.bytesRead, 0);}
  }

  public dispose(): void {zeroHttpBytes(this.buffered); this.buffered = new Uint8Array();}
}

const find = (source: Uint8Array, needle: Uint8Array): number => {
  outer: for (let index = 0; index <= source.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (source[index + offset] !== needle[offset]) {continue outer;}
    }
    return index;
  }
  return -1;
};

type ParsedHead = Readonly<{
  status: number;
  contentLength: number | undefined;
  chunked: boolean;
  contentType: string | undefined;
}>;

const malformedHead = (bytes: Uint8Array): StrictHttpResponseError => new StrictHttpResponseError(
  "malformed",
  bytes.byteLength,
  0,
);

const parseStatus = (line: string, bytes: Uint8Array): number => {
  const match = /^HTTP\/1\.1 ([1-5][0-9]{2}) [\x20-\x7e]+$/.exec(line);
  if (match === null) {throw malformedHead(bytes);}
  const status = Number(match[1]);
  if (status < 200) {throw malformedHead(bytes);}
  return status;
};

const parseResponseHeaders = (lines: readonly string[], bytes: Uint8Array): ReadonlyMap<string, readonly string[]> => {
  const headers = new Map<string, readonly string[]>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) {throw malformedHead(bytes);}
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!TOKEN.test(name) || /[^\t\x20-\x7e]/.test(value)) {throw malformedHead(bytes);}
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return headers;
};

const parseContentLength = (values: readonly string[], bytes: Uint8Array): number | undefined => {
  const text = values[0];
  if (text === undefined) {return undefined;}
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {throw malformedHead(bytes);}
  const contentLength = Number(text);
  if (!Number.isSafeInteger(contentLength)) {
    throw new StrictHttpResponseError("oversized", bytes.byteLength, 0);
  }
  return contentLength;
};

const framingFitsStatus = (status: number, contentLength: number | undefined, chunked: boolean): boolean => {
  const bodyForbidden = status === 204 || status === 304;
  if (bodyForbidden) {return !chunked && (contentLength ?? 0) === 0;}
  return contentLength !== undefined || chunked;
};

const parseResponseFraming = (
  status: number,
  headers: ReadonlyMap<string, readonly string[]>,
  bytes: Uint8Array,
): Readonly<{ contentLength: number | undefined; chunked: boolean }> => {
  const lengths = headers.get("content-length") ?? [];
  const encodings = headers.get("transfer-encoding") ?? [];
  const ambiguous = lengths.length > 1 || encodings.length > 1 || (lengths.length > 0 && encodings.length > 0);
  if (ambiguous) {throw malformedHead(bytes);}
  const contentLength = parseContentLength(lengths, bytes);
  const chunked = encodings.length === 1;
  if (chunked && encodings[0]?.toLowerCase() !== "chunked") {throw malformedHead(bytes);}
  if (!framingFitsStatus(status, contentLength, chunked)) {throw malformedHead(bytes);}
  return Object.freeze({ contentLength, chunked });
};

const parseHead = (bytes: Uint8Array): ParsedHead => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new StrictHttpResponseError("malformed", bytes.byteLength, 0);
  }
  if (text.includes("\u0000") || /\r\n[ \t]/.test(text)) {throw new StrictHttpResponseError("malformed", bytes.byteLength, 0);}
  const lines = text.split("\r\n");
  const status = parseStatus(lines.shift() ?? "", bytes);
  const headers = parseResponseHeaders(lines, bytes);
  const framing = parseResponseFraming(status, headers, bytes);
  const contentTypes = headers.get("content-type") ?? [];
  if (contentTypes.length > 1) {throw malformedHead(bytes);}
  // This bounded adapter neither decompresses nor rewrites encoded payloads.
  const contentEncodings = headers.get("content-encoding") ?? [];
  if (contentEncodings.length > 1
    || (contentEncodings.length === 1 && contentEncodings[0]?.toLowerCase() !== "identity")) {
    throw malformedHead(bytes);
  }
  return Object.freeze({ status, ...framing, contentType: contentTypes[0] });
};

const safeContentType = (value: string | undefined): string | undefined => value !== undefined
  && /^[A-Za-z0-9!#$&^_.+*/;= -]{1,256}$/.test(value)
  ? value
  : undefined;

const write = async (
  context: Readonly<{
    connection: HttpEgressConnection;
    clock: HttpEgressClock;
    limits: HttpEgressLimits;
    signal: AbortSignal | undefined;
  }>,
  bytes: Uint8Array,
  upstreamBytes: number,
  outboundBytes: number,
): Promise<number> => {
  try {
    await context.clock.within(context.limits.deadline, () => context.connection.write(bytes), context.signal);
    return outboundBytes + bytes.byteLength;
  } catch {
    throw new StrictHttpResponseError(context.signal?.aborted ? "cancelled" : "backpressure", upstreamBytes, outboundBytes, true);
  }
};

const forwardSizedBody = async (
  reader: DeadlineByteReader,
  size: number,
  maximumChunk: number,
  emit: (chunk: Uint8Array) => Promise<void>,
): Promise<void> => {
  let remaining = size;
  while (remaining > 0) {
    const chunk = await reader.take(Math.min(remaining, maximumChunk));
    if (chunk === undefined) {throw new StrictHttpResponseError("truncated", reader.bytesRead, 0);}
    remaining -= chunk.byteLength;
    await emit(chunk);
  }
};

const forwardFramedBody = async (
  reader: DeadlineByteReader,
  head: ParsedHead,
  limits: HttpEgressLimits,
  emit: (chunk: Uint8Array) => Promise<void>,
): Promise<void> => {
  if (head.contentLength !== undefined) {
    await forwardSizedBody(reader, head.contentLength, limits.maxBufferedBytes, emit);
    await reader.requireEnd();
    return;
  }
  if (!head.chunked) {
    await reader.requireEnd();
    return;
  }
  let bodyBytes = 0;
  while (true) {
    const lineBytes = await reader.through(CRLF, 34);
    let line: string;
    try {
      line = decoder.decode(lineBytes);
    } finally {
      zeroHttpBytes(lineBytes);
    }
    if (!/^[0-9A-Fa-f]+$/.test(line)) {throw new StrictHttpResponseError("malformed", reader.bytesRead, 0);}
    const size = Number.parseInt(line, 16);
    if (!Number.isSafeInteger(size) || size > limits.maxOutputBytes - bodyBytes) {
      throw new StrictHttpResponseError("oversized", reader.bytesRead, 0);
    }
    if (size === 0) {
      const trailers = await reader.through(CRLF, limits.maxUpstreamHeaderBytes);
      try {
        if (trailers.byteLength !== 0) {throw new StrictHttpResponseError("malformed", reader.bytesRead, 0);}
      } finally {
        zeroHttpBytes(trailers);
      }
      await reader.requireEnd();
      return;
    }
    await forwardSizedBody(reader, size, limits.maxBufferedBytes, emit);
    bodyBytes += size;
    const ending = await reader.through(CRLF, 2);
    try {
      if (ending.byteLength !== 0) {throw new StrictHttpResponseError("malformed", reader.bytesRead, 0);}
    } finally {
      zeroHttpBytes(ending);
    }
  }
};

export const forwardStrictHttpResponse = async (
  source: AsyncIterable<Uint8Array>,
  connection: HttpEgressConnection,
  limits: HttpEgressLimits,
  clock: HttpEgressClock,
  signal?: AbortSignal,
  onHeadAccepted?: (status: number) => boolean,
): Promise<StrictHttpResponseResult> => {
  const writeContext = Object.freeze({ connection, clock, limits, signal });
  const reader = new DeadlineByteReader(source, clock, limits, signal);
  try {
    const headBytes = await reader.through(CRLFCRLF, limits.maxUpstreamHeaderBytes);
    let head: ParsedHead;
    try {
      head = parseHead(headBytes);
    } catch (error) {
      if (error instanceof StrictHttpResponseError) {
        throw new StrictHttpResponseError(error.kind, reader.bytesRead, error.outboundBytes,
          error.outboundWriteUncertain);
      }
      throw new StrictHttpResponseError("malformed", reader.bytesRead, 0);
    } finally {
      zeroHttpBytes(headBytes);
    }
    if (head.status >= 300 && head.status <= 399) {throw new StrictHttpResponseError("redirect", reader.bytesRead, 0);}
    // This hook is deliberately synchronous. Retry-triggering status authority
    // closes before any response byte can become observable by the provider.
    if (onHeadAccepted !== undefined && !onHeadAccepted(head.status)) {
      throw new StrictHttpResponseError("redirect", reader.bytesRead, 0);
    }
    if ((head.contentLength ?? 0) > limits.maxOutputBytes) {
      throw new StrictHttpResponseError("oversized", reader.bytesRead, 0);
    }
    const contentType = safeContentType(head.contentType);
    const downstreamHead = encoder.encode(
      `HTTP/1.1 ${head.status} Upstream\r\n${contentType === undefined ? "" : `Content-Type: ${contentType}\r\n`}Connection: close\r\n\r\n`,
    );
    let outboundBytes: number;
    try {
      outboundBytes = await write(writeContext, downstreamHead, reader.bytesRead, 0);
    } finally {
      zeroHttpBytes(downstreamHead);
    }
    let bodyBytes = 0;
    const emit = async (chunk: Uint8Array): Promise<void> => {
      try {
        bodyBytes += chunk.byteLength;
        if (bodyBytes > limits.maxOutputBytes) {
          throw new StrictHttpResponseError("oversized", reader.bytesRead, outboundBytes);
        }
        outboundBytes = await write(writeContext, chunk, reader.bytesRead, outboundBytes);
      } finally {
        zeroHttpBytes(chunk);
      }
    };
    try {
      await forwardFramedBody(reader, head, limits, emit);
    } catch (error) {
      if (!(error instanceof StrictHttpResponseError)) {
        throw new StrictHttpResponseError("malformed", reader.bytesRead, outboundBytes);
      }
      throw new StrictHttpResponseError(error.kind, reader.bytesRead, Math.max(outboundBytes, error.outboundBytes),
        error.outboundWriteUncertain);
    }
    return Object.freeze({ status: head.status, upstreamBytes: reader.bytesRead, outboundBytes });
  } finally {
    reader.dispose();
  }
};
