import { createHash } from "node:crypto";

import type { SourceIdentityDigest } from "../../application/ports/outbound/source-identity-digest.js";

export const createNodeSourceIdentityDigest = (): SourceIdentityDigest =>
  Object.freeze({
    sha256Hex: (preimage: string) => createHash("sha256").update(preimage).digest("hex"),
  });
