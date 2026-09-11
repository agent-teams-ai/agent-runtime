/**
 * Derives a stable, non-reversible hex digest for opaque public reference IDs.
 * Application code never touches a hashing primitive directly; the digest is a
 * Host-owned adapter concern, injected here for exact, testable parity.
 */
export interface OpaqueReferenceDigest {
  hex(key: Uint8Array, material: string): string;
}
