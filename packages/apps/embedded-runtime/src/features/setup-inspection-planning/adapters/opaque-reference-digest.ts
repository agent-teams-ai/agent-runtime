import { createHmac } from "node:crypto";
import type { OpaqueReferenceDigest } from "../contracts/opaque-reference-digest.js";

export type { OpaqueReferenceDigest } from "../contracts/opaque-reference-digest.js";

export const createNodeOpaqueReferenceDigest = (): OpaqueReferenceDigest =>
  Object.freeze<OpaqueReferenceDigest>({
    hex: (key, material) => createHmac("sha256", key).update(material).digest("hex"),
  });
