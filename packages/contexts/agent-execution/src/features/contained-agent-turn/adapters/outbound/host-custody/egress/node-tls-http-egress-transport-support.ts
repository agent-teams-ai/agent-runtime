import { createHash, type X509Certificate } from "node:crypto";
import { isIP, SocketAddress } from "node:net";
import { createSecureContext, type PeerCertificate, type SecureContext } from "node:tls";

import type { HttpEgressTransportBinding } from "./http-egress-ports.js";

export type NodeTlsHttpEgressErrorCode =
  | "invalid_configuration"
  | "invalid_target"
  | "connect_failed"
  | "connect_timeout"
  | "tls_validation_failed"
  | "peer_mismatch"
  | "protocol_mismatch"
  | "alpn_mismatch"
  | "session_reuse_detected"
  | "attempt_closed";

/** Canonical transport diagnostics deliberately omit addresses, paths, certificates and socket errors. */
export class NodeTlsHttpEgressError extends Error {
  public readonly code: NodeTlsHttpEgressErrorCode;

  public constructor(code: NodeTlsHttpEgressErrorCode) {
    super(`node TLS HTTP egress: ${code}`);
    this.name = "NodeTlsHttpEgressError";
    this.code = code;
  }
}

export type NodeTlsTrustInput = string | Uint8Array;

export type FixedNodeTlsTrust = Readonly<{
  secureContext: SecureContext;
}>;

const validBoundedInteger = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export const fixTrust = (authorities: readonly NodeTlsTrustInput[]): FixedNodeTlsTrust => {
  if (!Array.isArray(authorities) || authorities.length === 0 || authorities.length > 32) {
    throw new NodeTlsHttpEgressError("invalid_configuration");
  }
  const copied = authorities.map(authority => {
    if (typeof authority === "string") {
      if (authority.length === 0 || authority.length > 1_048_576) {
        throw new NodeTlsHttpEgressError("invalid_configuration");
      }
      return authority;
    }
    if (!(authority instanceof Uint8Array) || authority.byteLength === 0 || authority.byteLength > 1_048_576) {
      throw new NodeTlsHttpEgressError("invalid_configuration");
    }
    return Buffer.from(authority);
  });
  try {
    return Object.freeze({
      secureContext: createSecureContext({
        ca: copied,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
      }),
    });
  } catch {
    throw new NodeTlsHttpEgressError("invalid_configuration");
  }
};

export type FixedNodeTlsLimits = Readonly<{
  connectTimeoutMs: number;
  responseIdleTimeoutMs: number;
  closeTimeoutMs: number;
}>;

export const fixLimits = (input: FixedNodeTlsLimits): FixedNodeTlsLimits => {
  if (!validBoundedInteger(input.connectTimeoutMs, 1, 120_000)
    || !validBoundedInteger(input.responseIdleTimeoutMs, 1, 120_000)
    || !validBoundedInteger(input.closeTimeoutMs, 1, 30_000)) {
    throw new NodeTlsHttpEgressError("invalid_configuration");
  }
  return Object.freeze({ ...input });
};

export type CanonicalLiteralAddress = Readonly<{ address: string; family: 4 | 6 }>;

export const canonicalLiteralAddress = (address: string): CanonicalLiteralAddress | undefined => {
  if (typeof address !== "string" || address.length === 0 || address.length > 64 || address.includes("%")) {return undefined;}
  const family = isIP(address);
  if (family !== 4 && family !== 6) {return undefined;}
  try {
    const socketAddress = new SocketAddress({
      address,
      family: family === 4 ? "ipv4" : "ipv6",
      port: 0,
    });
    return Object.freeze({ address: socketAddress.address, family });
  } catch {
    return undefined;
  }
};

export const canonicalSni = (sni: string): string | undefined => {
  if (typeof sni !== "string" || sni.length === 0 || sni.length > 253 || sni.endsWith(".") || isIP(sni) !== 0) {
    return undefined;
  }
  const lowered = sni.toLowerCase();
  if (sni !== lowered) {return undefined;}
  const labels = lowered.split(".");
  if (labels.some(label => label.length === 0 || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    return undefined;
  }
  return sni;
};

export const validatePort = (port: number): boolean => validBoundedInteger(port, 1, 65_535);

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

export const createBinding = (input: Readonly<{
  selectedAddress: CanonicalLiteralAddress;
  expectedPort: number;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  protocol: string | null;
  alpn: string | false | null;
  servername: string | false | null;
  expectedSni: string;
  certificate: X509Certificate | undefined;
  authorized: boolean;
  identityChecked: boolean;
  sessionReused: boolean;
}>): HttpEgressTransportBinding => {
  if (!input.authorized || !input.identityChecked || input.certificate === undefined || input.servername !== input.expectedSni) {
    throw new NodeTlsHttpEgressError("tls_validation_failed");
  }
  const actual = input.remoteAddress === undefined ? undefined : canonicalLiteralAddress(input.remoteAddress);
  if (actual === undefined || actual.family !== input.selectedAddress.family
    || actual.address !== input.selectedAddress.address || input.remotePort !== input.expectedPort) {
    throw new NodeTlsHttpEgressError("peer_mismatch");
  }
  if (input.protocol !== "TLSv1.2" && input.protocol !== "TLSv1.3") {
    throw new NodeTlsHttpEgressError("protocol_mismatch");
  }
  if (input.alpn !== "http/1.1") {throw new NodeTlsHttpEgressError("alpn_mismatch");}
  if (input.sessionReused) {throw new NodeTlsHttpEgressError("session_reuse_detected");}
  const publicKey = input.certificate.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    peerAddress: actual.address,
    peerPort: input.remotePort,
    tlsProtocol: input.protocol,
    requestedSni: input.expectedSni,
    observedSni: input.servername,
    chainValidated: true,
    dnsIdentity: input.expectedSni,
    certificateDigest: `sha256:${sha256(input.certificate.raw)}` as const,
    tlsPolicyDigest: "sha256:node-tls-http-egress-policy-v1",
    spkiDigest: `sha256:${sha256(publicKey)}` as const,
    alpn: "http/1.1",
  });
};

export const parentIdentityCheck = (
  checkServerIdentity: (hostname: string, certificate: PeerCertificate) => Error | undefined,
  expectedSni: string,
  markChecked: () => void,
) => (hostname: string, certificate: PeerCertificate): Error | undefined => {
  if (hostname !== expectedSni) {return new NodeTlsHttpEgressError("tls_validation_failed");}
  markChecked();
  return checkServerIdentity(hostname, certificate);
};

export const closureReceiptDigest = (state: "closed" | "unknown"): string => sha256(
  `agent-runtime.node-tls-http-egress-closure/v1\n${state}\n`,
);
