import { createHash } from "node:crypto";

import type { ReferenceDigest } from "../../application/ports/outbound/reference-digest.js";

export const createNodeReferenceDigest = (): ReferenceDigest =>
  Object.freeze({
    sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
  });
