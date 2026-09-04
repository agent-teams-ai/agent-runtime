import type { HttpEgressRoute } from "./http-egress-ports.js";
import type { StrictHttpRequest } from "./strict-http-request.js";

const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Provider-specific and unknown headers need an explicit typed mapping before
// they may cross the Host credential-custody boundary.
const FORWARDABLE_PRESENTATION_HEADERS = new Set(["accept", "content-type"]);

export class HttpOutboundRequestError extends Error {
  public constructor() {
    super("invalid outbound route or authorization rendering");
    this.name = "HttpOutboundRequestError";
  }
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

export const assertHttpEgressRoute = (route: HttpEgressRoute): void => {
  if (route.alpn !== "http/1.1") {throw new HttpOutboundRequestError();}
  if (!TOKEN.test(route.upstreamMethod) || route.upstreamMethod === "CONNECT") {throw new HttpOutboundRequestError();}
  if (!route.upstreamPath.startsWith("/") || route.upstreamPath.startsWith("//")
    || /[^\x21-\x7e]|[?#]/.test(route.upstreamPath)) {
    throw new HttpOutboundRequestError();
  }
  if (!/^[A-Za-z0-9.-]+$/.test(route.originHost) || !/^[A-Za-z0-9.-]+$/.test(route.sni)) {throw new HttpOutboundRequestError();}
  if (!Number.isInteger(route.originPort) || route.originPort < 1 || route.originPort > 65_535) {throw new HttpOutboundRequestError();}
  if (!Array.isArray(route.forwardedRequestHeaderNames) || route.forwardedRequestHeaderNames.length > 32
    || new Set(route.forwardedRequestHeaderNames).size !== route.forwardedRequestHeaderNames.length
    || route.forwardedRequestHeaderNames.some(name => typeof name !== "string"
      || name.length > 128 || name !== name.toLowerCase() || !TOKEN.test(name)
      || !FORWARDABLE_PRESENTATION_HEADERS.has(name))) {
    throw new HttpOutboundRequestError();
  }
};

export const selectForwardedRequestHeaders = (
  request: StrictHttpRequest,
  route: HttpEgressRoute,
): StrictHttpRequest["headers"] => {
  const permitted = new Set(route.forwardedRequestHeaderNames);
  const headers = request.headers.filter(header => permitted.has(header.name));
  // Repeated presentation/control fields have no provider-neutral interpretation.
  if (new Set(headers.map(header => header.name)).size !== headers.length) {throw new HttpOutboundRequestError();}
  return Object.freeze(headers.toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
};

const authorizationIsSafe = (authorization: Uint8Array): boolean => {
  if (authorization.byteLength === 0 || authorization.byteLength > 16_384) {return false;}
  return authorization.every(byte => byte === 9 || (byte >= 32 && byte <= 126))
    && !authorization.includes(10)
    && !authorization.includes(13);
};

export const createOutboundHttpRequest = (
  request: StrictHttpRequest,
  route: HttpEgressRoute,
  authorization: Uint8Array,
): Uint8Array => {
  assertHttpEgressRoute(route);
  if (!authorizationIsSafe(authorization)) {throw new HttpOutboundRequestError();}
  const forwarded = selectForwardedRequestHeaders(request, route)
    .map(header => `${header.name}: ${header.value}\r\n`)
    .join("");
  const defaultPort = route.originPort === 443;
  const host = defaultPort ? route.originHost : `${route.originHost}:${route.originPort}`;
  const prefix = encoder.encode(
    `${route.upstreamMethod} ${route.upstreamPath} HTTP/1.1\r\n${forwarded}Host: ${host}\r\nAuthorization: `,
  );
  const suffix = encoder.encode(
    `\r\nContent-Length: ${request.body.byteLength}\r\nConnection: close\r\n\r\n`,
  );
  try {
    return concat([prefix, authorization, suffix, request.body]);
  } finally {
    prefix.fill(0);
    suffix.fill(0);
  }
};
