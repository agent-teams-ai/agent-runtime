import type {
  HttpEgressExpectedRequest,
  HttpEgressLimits,
} from "./http-egress-contracts.js";
import type { HttpEgressClock } from "./http-egress-ports.js";

const decoder = new TextDecoder("ascii", { fatal: true });
const encoder = new TextEncoder();
const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CRITICAL_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "expect",
  "host",
  "proxy-authorization",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type StrictHttpRequest = Readonly<{
  method: string;
  path: string;
  headers: readonly Readonly<{ name: string; value: string }>[];
  body: Uint8Array;
  wireBytes: number;
}>;

export class StrictHttpRequestError extends Error {
  public constructor(
    public readonly kind: "cancelled" | "deadline" | "headers_oversized" | "body_oversized" | "malformed" | "smuggling" | "route_mismatch",
    public readonly observedBytes = 0,
  ) {
    super(kind);
    this.name = "StrictHttpRequestError";
  }
}

const addObservedBytes = (current: number, count: number): number => {
  const total = current + count;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
};

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
};

const indexOf = (source: Uint8Array, needle: Uint8Array): number => {
  outer: for (let index = 0; index <= source.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (source[index + offset] !== needle[offset]) {continue outer;}
    }
    return index;
  }
  return -1;
};

type ParsedRequestHead = Readonly<{
  method: string;
  path: string;
  headers: readonly Readonly<{ name: string; value: string }>[];
  contentLength: number;
}>;

const parseRequestLine = (
  requestLine: string | undefined,
  expected: HttpEgressExpectedRequest,
): Readonly<{ method: string; path: string }> => {
  if (requestLine === undefined || requestLine.includes("\t")) {throw new StrictHttpRequestError("malformed");}
  const requestParts = requestLine.split(" ");
  if (requestParts.length !== 3 || requestParts.some(part => part.length === 0)) {
    throw new StrictHttpRequestError("malformed");
  }
  const [method, path, version] = requestParts as [string, string, string];
  if (!TOKEN.test(method) || version !== "HTTP/1.1") {throw new StrictHttpRequestError("malformed");}
  const unsafeTarget = method === "CONNECT" || !path.startsWith("/") || path.startsWith("//")
    || path.includes("?") || path.includes("#");
  if (unsafeTarget) {throw new StrictHttpRequestError("smuggling");}
  if (method !== expected.method || path !== expected.path) {throw new StrictHttpRequestError("route_mismatch");}
  return Object.freeze({ method, path });
};

const parseHeaderLines = (
  lines: readonly string[],
): Readonly<{ headers: readonly Readonly<{ name: string; value: string }>[]; counts: ReadonlyMap<string, number> }> => {
  const headers: Array<Readonly<{ name: string; value: string }>> = [];
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.length === 0) {continue;}
    const colon = line.indexOf(":");
    if (colon <= 0) {throw new StrictHttpRequestError("malformed");}
    const originalName = line.slice(0, colon);
    if (!TOKEN.test(originalName)) {throw new StrictHttpRequestError("malformed");}
    const name = originalName.toLowerCase();
    const rawValue = line.slice(colon + 1);
    if (/[^\t\x20-\x7e]/.test(rawValue)) {throw new StrictHttpRequestError("malformed");}
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count > 1 && CRITICAL_HEADERS.has(name)) {throw new StrictHttpRequestError("smuggling");}
    headers.push(Object.freeze({ name, value: rawValue.trim() }));
  }
  return Object.freeze({ headers: Object.freeze(headers), counts });
};

const parseContentLength = (
  headers: readonly Readonly<{ name: string; value: string }>[],
  counts: ReadonlyMap<string, number>,
  expected: HttpEgressExpectedRequest,
): number => {
  if (counts.get("content-length") !== 1 || counts.get("host") !== 1) {
    throw new StrictHttpRequestError("smuggling");
  }
  const forbiddenFraming = ["transfer-encoding", "trailer", "expect", "upgrade"]
    .some(name => counts.has(name));
  if (forbiddenFraming) {throw new StrictHttpRequestError("smuggling");}
  const host = headers.find(header => header.name === "host")?.value;
  if (host !== expected.host) {throw new StrictHttpRequestError("route_mismatch");}
  const text = headers.find(header => header.name === "content-length")?.value ?? "";
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {throw new StrictHttpRequestError("smuggling");}
  const contentLength = Number(text);
  if (!Number.isSafeInteger(contentLength)) {throw new StrictHttpRequestError("body_oversized");}
  return contentLength;
};

const parseHeaders = (
  bytes: Uint8Array,
  expected: HttpEgressExpectedRequest,
): ParsedRequestHead => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new StrictHttpRequestError("malformed");
  }
  if (text.includes("\u0000") || /\r\n[ \t]/.test(text)) {throw new StrictHttpRequestError("smuggling");}
  const lines = text.split("\r\n");
  const request = parseRequestLine(lines.shift(), expected);
  const parsedHeaders = parseHeaderLines(lines);
  const contentLength = parseContentLength(parsedHeaders.headers, parsedHeaders.counts, expected);
  return Object.freeze({ ...request, headers: parsedHeaders.headers, contentLength });
};

const nextWithDeadline = async (
  iterator: AsyncIterator<Uint8Array>,
  clock: HttpEgressClock,
  limits: HttpEgressLimits,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> => {
  if (signal?.aborted) {throw new StrictHttpRequestError("cancelled");}
  if (clock.now() >= limits.deadline) {throw new StrictHttpRequestError("deadline");}
  try {
    return await clock.within(limits.deadline, () => iterator.next(), signal);
  } catch {
    if (signal?.aborted) {throw new StrictHttpRequestError("cancelled");}
    throw new StrictHttpRequestError("deadline");
  }
};

const parseBoundedRequestHead = (
  buffered: Uint8Array,
  headerEnd: number,
  expected: HttpEgressExpectedRequest,
  limits: HttpEgressLimits,
): ParsedRequestHead => {
  if (headerEnd + CRLFCRLF.byteLength > limits.maxInboundHeaderBytes) {
    throw new StrictHttpRequestError("headers_oversized");
  }
  const head = buffered.slice(0, headerEnd);
  let parsed: ParsedRequestHead;
  try {
    parsed = parseHeaders(head, expected);
  } finally {
    head.fill(0);
  }
  if (parsed.contentLength > limits.maxInboundBodyBytes) {throw new StrictHttpRequestError("body_oversized");}
  return parsed;
};

export const readStrictHttpRequest = async (
  chunks: AsyncIterable<Uint8Array>,
  expected: HttpEgressExpectedRequest,
  limits: HttpEgressLimits,
  clock: HttpEgressClock,
  signal?: AbortSignal,
): Promise<StrictHttpRequest> => {
  const iterator = chunks[Symbol.asyncIterator]();
  let buffered: Uint8Array = new Uint8Array();
  let observedBytes = 0;
  let headerEnd = -1;
  let parsed: ReturnType<typeof parseHeaders> | undefined;
  try {
    while (true) {
      const next = await nextWithDeadline(iterator, clock, limits, signal);
      if (next.done) {break;}
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {continue;}
      observedBytes = addObservedBytes(observedBytes, next.value.byteLength);
      if (next.value.byteLength > limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes
        || buffered.byteLength + next.value.byteLength > limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes) {
        throw new StrictHttpRequestError(headerEnd < 0 ? "headers_oversized" : "body_oversized");
      }
      const previous = buffered;
      buffered = concat(previous, next.value);
      previous.fill(0);
      if (headerEnd < 0) {
        headerEnd = indexOf(buffered, CRLFCRLF);
        if (headerEnd < 0 && buffered.byteLength > limits.maxInboundHeaderBytes) {
          throw new StrictHttpRequestError("headers_oversized");
        }
        if (headerEnd >= 0) {
          parsed = parseBoundedRequestHead(buffered, headerEnd, expected, limits);
        }
      }
      if (parsed !== undefined) {
        const expectedTotal = headerEnd + CRLFCRLF.byteLength + parsed.contentLength;
        if (buffered.byteLength > expectedTotal) {throw new StrictHttpRequestError("smuggling");}
      }
      if (buffered.byteLength > limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes) {
        throw new StrictHttpRequestError("body_oversized");
      }
    }
    if (parsed === undefined || headerEnd < 0) {throw new StrictHttpRequestError("malformed");}
    const bodyStart = headerEnd + CRLFCRLF.byteLength;
    if (buffered.byteLength !== bodyStart + parsed.contentLength) {throw new StrictHttpRequestError("malformed");}
    return Object.freeze({
      method: parsed.method,
      path: parsed.path,
      headers: parsed.headers,
      body: buffered.slice(bodyStart),
      wireBytes: buffered.byteLength,
    });
  } catch (error) {
    if (error instanceof StrictHttpRequestError) {
      throw new StrictHttpRequestError(error.kind, observedBytes);
    }
    throw error;
  } finally {
    buffered.fill(0);
  }
};

export const canonicalRequestDigestParts = (
  requestId: string,
  request: StrictHttpRequest,
  forwardedHeaders: StrictHttpRequest["headers"],
): readonly Uint8Array[] => Object.freeze([
  encoder.encode("agent-runtime.host-http-request/v2\n"),
  encoder.encode(`${JSON.stringify(forwardedHeaders.map(header => [header.name, header.value]))}\n`),
  encoder.encode(`${requestId.length}:${requestId}\n${request.method.length}:${request.method}\n${request.path.length}:${request.path}\n${request.body.byteLength}:`),
  request.body,
]);
