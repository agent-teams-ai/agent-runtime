import { createHmac } from "node:crypto";

export interface OpaqueReferenceDigest {
  hex(key: Uint8Array, material: string): string;
}

export const createNodeOpaqueReferenceDigest = (): OpaqueReferenceDigest =>
  Object.freeze<OpaqueReferenceDigest>({
    hex: (key, material) => createHmac("sha256", key).update(material).digest("hex"),
  });
