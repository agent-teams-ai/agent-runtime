import { createHash, X509Certificate } from "node:crypto";
import { isIP, SocketAddress } from "node:net";
import { createSecureContext, type PeerCertificate, type SecureContext } from "node:tls";

import type { HttpEgressTransportBinding } from "./http-egress-ports.js";
import { intrinsicUint8ArrayLength } from "./http-byte-intrinsics.js";

const { Buffer } = process.getBuiltinModule("node:buffer");

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
  trustAnchorDigest: `sha256:${string}`;
}>;

const MAXIMUM_TRUST_BYTES = 1_048_576;
const uint8ArraySet = Uint8Array.prototype.set;

const invalidConfiguration = (): NodeTlsHttpEgressError => new NodeTlsHttpEgressError("invalid_configuration");

const validBoundedInteger = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const copyTrustInputs = (authorities: readonly NodeTlsTrustInput[]): Array<string | Buffer> => {
  if (!Array.isArray(authorities)) {throw invalidConfiguration();}
  const count: unknown = Object.getOwnPropertyDescriptor(authorities, "length")?.value;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 32) {
    throw invalidConfiguration();
  }
  const copied: Array<string | Buffer> = [];
  let aggregateByteLength = 0;
  for (let index = 0; index < (count as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(authorities, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {throw invalidConfiguration();}
    const authority: unknown = descriptor.value;
    if (typeof authority === "string") {
      const remainingByteLength = MAXIMUM_TRUST_BYTES - aggregateByteLength;
      if (authority.length === 0 || authority.length > remainingByteLength) {throw invalidConfiguration();}
      const byteLength = Buffer.byteLength(authority, "utf8");
      if (byteLength > remainingByteLength) {throw invalidConfiguration();}
      aggregateByteLength += byteLength;
      copied[index] = authority;
      continue;
    }
    const byteLength = intrinsicUint8ArrayLength(authority);
    if (byteLength === undefined || byteLength === 0 || byteLength > MAXIMUM_TRUST_BYTES - aggregateByteLength) {
      throw invalidConfiguration();
    }
    const snapshot = Buffer.allocUnsafe(byteLength);
    Reflect.apply(uint8ArraySet, snapshot, [authority]);
    aggregateByteLength += byteLength;
    copied[index] = snapshot;
  }
  return copied;
};

const canonicalTrustAnchors = (authorities: readonly (string | Buffer)[]): Readonly<{
  anchors: ReadonlyMap<string, string>;
  fingerprints: readonly string[];
}> => {
  // OpenSSL silently ignores some malformed CA entries, so parse each PEM
  // block here and fingerprint canonical DER with set semantics.
  const anchors = new Map<string, string>();
  for (const authority of authorities) {
    const pem = typeof authority === "string" ? authority : authority.toString("utf8");
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
    if (blocks === null || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim() !== "") {
      throw invalidConfiguration();
    }
    for (const block of blocks) {
      const certificate = new X509Certificate(block);
      const encoded = block.replace("-----BEGIN CERTIFICATE-----", "")
        .replace("-----END CERTIFICATE-----", "").replace(/\s/gu, "");
      if (encoded !== certificate.raw.toString("base64")) {throw invalidConfiguration();}
      anchors.set(sha256(certificate.raw), certificate.toString());
    }
  }
  return Object.freeze({ anchors, fingerprints: [...anchors.keys()].toSorted() });
};

export const fixTrust = (authorities: readonly NodeTlsTrustInput[]): FixedNodeTlsTrust => {
  try {
    const { anchors, fingerprints } = canonicalTrustAnchors(copyTrustInputs(authorities));
    return Object.freeze({
      trustAnchorDigest: `sha256:${sha256(`agent-runtime.node-tls-trust-anchors/v1\n${fingerprints.join("\n")}\n`)}` as const,
      secureContext: createSecureContext({
        ca: fingerprints.map(fingerprint => anchors.get(fingerprint)!),
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
      }),
    });
  } catch {
    throw invalidConfiguration();
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

const TLS_POLICY_MANIFEST = "agent-runtime.node-tls-http-egress-policy/v1\n"
  + "tls=TLSv1.2,TLSv1.3\n"
  + "alpn=http/1.1\n"
  + "peer=exact-canonical-selected-address-family-and-port\n"
  + "sni=exact-lower-case-expected-dns-name\n"
  + "dns-identity=node-checkServerIdentity-for-expected-sni\n"
  + "chain=authorized\n"
  + "evidence=sha256-certificate-der,sha256-spki-der\n"
  + "tls-session-reuse=rejected\n"
  + "trust=constructor-owned-fixed-local-context\n";

export const createBinding = (input: Readonly<{
  trust: FixedNodeTlsTrust;
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
    tlsPolicyDigest: `sha256:${sha256(`${TLS_POLICY_MANIFEST}trust-anchors=${input.trust.trustAnchorDigest}\n`)}` as const,
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
