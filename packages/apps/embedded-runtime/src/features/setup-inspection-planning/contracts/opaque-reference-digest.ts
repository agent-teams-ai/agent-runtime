export interface OpaqueReferenceDigest {
  hex(key: Uint8Array, material: string): string;
}
