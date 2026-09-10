import { createHash, createHmac } from "node:crypto";

import type { ConfigurationDigest } from "../../application/ports/outbound/configuration-digest.js";

/** The Node implementation of the feature's digest port. It keeps the exact
 * algorithm, encoding and preimage handling the use cases relied on before the
 * port existed, so every previously issued identifier stays reproducible. */
export const createNodeConfigurationDigest = (): ConfigurationDigest => Object.freeze({
  hmacSha256Hex: (key: Uint8Array, preimage: string): string =>
    createHmac("sha256", key).update(preimage).digest("hex"),
  sha256Hex: (preimage: string): string => createHash("sha256").update(preimage).digest("hex"),
});
