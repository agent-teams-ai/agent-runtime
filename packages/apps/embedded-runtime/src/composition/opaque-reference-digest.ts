import { createHmac } from "node:crypto";

import type { OpaqueReferenceDigest } from "../application/ports/outbound/opaque-reference-digest.js";

export const createNodeOpaqueReferenceDigest = (): OpaqueReferenceDigest =>
  Object.freeze<OpaqueReferenceDigest>({
    hex: (key, material) => createHmac("sha256", key).update(material).digest("hex"),
  });
