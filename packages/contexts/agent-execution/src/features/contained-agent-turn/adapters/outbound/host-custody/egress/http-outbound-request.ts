import type { HttpEgressRoute } from "./http-egress-ports.js";
import type { StrictHttpRequest } from "./strict-http-request.js";

const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const STRIPPED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-provider-api-key",
  "x-provider-authorization",
]);

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

const assertRoute = (route: HttpEgressRoute): void => {
  if (!TOKEN.test(route.upstreamMethod) || route.upstreamMethod === "CONNECT") {throw new HttpOutboundRequestError();}
  if (!route.upstreamPath.startsWith("/") || route.upstreamPath.startsWith("//") || route.upstreamPath.includes("?") || route.upstreamPath.includes("#")) {
    throw new HttpOutboundRequestError();
  }
  if (!/^[A-Za-z0-9.-]+$/.test(route.originHost) || !/^[A-Za-z0-9.-]+$/.test(route.sni)) {throw new HttpOutboundRequestError();}
  if (!Number.isInteger(route.originPort) || route.originPort < 1 || route.originPort > 65_535) {throw new HttpOutboundRequestError();}
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
  assertRoute(route);
  if (!authorizationIsSafe(authorization)) {throw new HttpOutboundRequestError();}
  const forwarded = request.headers
    .filter(header => !STRIPPED_HEADERS.has(header.name))
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
  return concat([prefix, authorization, suffix, request.body]);
};
