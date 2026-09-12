/** Feature-owned digest port: the application layer computes a stable
 * candidate identity but must not name `node:crypto` directly. */
export interface SourceIdentityDigest {
  readonly sha256Hex: (preimage: string) => string;
}
