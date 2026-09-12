/** Deterministic digests over exact preimage strings. The feature owns this port
 * so its use cases state which algorithm they depend on without reaching for a
 * platform module: identifier stability is part of the observable contract, so
 * the algorithm and the encoding are fixed here rather than chosen by a caller. */
export interface ConfigurationDigest {
  /** Lowercase hex SHA-256 over the UTF-8 bytes of `preimage`. */
  readonly sha256Hex: (preimage: string) => string;
  /** Lowercase hex HMAC-SHA-256 over the UTF-8 bytes of `preimage` under `key`. */
  readonly hmacSha256Hex: (key: Uint8Array, preimage: string) => string;
}
