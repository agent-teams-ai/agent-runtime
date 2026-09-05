import { randomBytes, timingSafeEqual } from "node:crypto";
import { zeroHttpBytes } from "./http-byte-intrinsics.js";
import type { StrictHttpRequest } from "./strict-http-request.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class HostHttpIngressDeniedError extends Error {
  public constructor() {super("inbound_authentication_denied"); this.name = "HostHttpIngressDeniedError";}
}

/** Private post-claim allocation. This is a local bearer capability, never an
 * upstream provider credential. No token value is retained in a receipt or key.
 * The caller must close both this capability and its associated session guard.
 */
export const issueHostHttpIngressAuthorization = () => {
  const entropy = randomBytes(32);
  let token: Uint8Array;
  try {token = encoder.encode(entropy.toString("base64url"));}
  finally {zeroHttpBytes(entropy);}
  let closed = false;
  const close = (): void => {closed = true; zeroHttpBytes(token);};
  return Object.freeze({
    nativeBearerToken(): string {
      if (closed) {throw new HostHttpIngressDeniedError();}
      return decoder.decode(token);
    },
    // Only the broker's own strict-parser result reaches this private seam.
    authenticate(request: StrictHttpRequest): StrictHttpRequest {
      if (closed) {throw new HostHttpIngressDeniedError();}
      const authorization = request.headers.filter(header => header.name === "authorization");
      const value = authorization[0]?.value;
      if (authorization.length !== 1 || value === undefined || !value.startsWith("Bearer ")
        || value.length !== token.byteLength + 7
        || request.headers.some(header => header.name === "proxy-authorization" || header.name === "x-api-key")) {
        throw new HostHttpIngressDeniedError();
      }
      const presented = encoder.encode(value.slice(7));
      try {
        if (presented.byteLength !== token.byteLength || !timingSafeEqual(presented, token)) {
          throw new HostHttpIngressDeniedError();
        }
      } finally {zeroHttpBytes(presented);}
      // Keep the exact body and raw wire count. Only the local authorization
      // field is removed before IDs and all PA/RS calls. Presentation selection
      // has already validated the original header budget and excluded credentials.
      return Object.freeze({...request, headers: Object.freeze(request.headers.filter(
        header => header.name !== "authorization"))});
    },
    close,
  });
};
