import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { EgressSecurityPrimitives } from "../../domain/validation.js";

const exactObject = <Name extends string>(value: unknown, names: readonly Name[]) => {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {return;}
  try {const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) {return;}
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key as Name))) {return;}
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<Name, unknown>;
    for (const name of names) {const descriptor = descriptors[name]; if (descriptor === undefined || !("value" in descriptor)) {return;}
      result[name] = descriptor.value;} return result as Readonly<Record<Name, unknown>>;} catch {return;}
};
const intrinsicUint8Array = Uint8Array;
const intrinsicDataView = DataView;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as
  (this: Uint8Array) => ArrayBufferLike;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as
  (this: Uint8Array) => number;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as
  (this: Uint8Array) => number;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get as
  (this: Uint8Array) => number;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as
  (this: ArrayBuffer) => number;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
  ((this: ArrayBuffer) => boolean) | undefined;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === "undefined" ? undefined :
  Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get as
    ((this: SharedArrayBuffer) => number) | undefined;

const snapshotUint8Array = (value: unknown, maximumByteLength: number): Uint8Array | undefined => {
  try {
    if (!nodeTypes.isUint8Array(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {return;}
    const source = value as Uint8Array;
    const byteLength = Reflect.apply(typedArrayByteLength, source, []);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumByteLength) {return;}
    const backing = Reflect.apply(typedArrayBuffer, source, []);
    if (sharedArrayBufferByteLength !== undefined) {
      try {Reflect.apply(sharedArrayBufferByteLength, backing, []); return;} catch {/* Ordinary ArrayBuffer. */}
    }
    const backingByteLength = Reflect.apply(arrayBufferByteLength, backing, []);
    if (arrayBufferResizable !== undefined && Reflect.apply(arrayBufferResizable, backing, [])) {return;}
    // DataView construction rejects detached ArrayBuffers, including detached zero-length buffers.
    const detachedProof = new intrinsicDataView(backing as ArrayBuffer, 0, 0);
    if (detachedProof.byteLength !== 0) {return;}
    const byteOffset = Reflect.apply(typedArrayByteOffset, source, []);
    const length = Reflect.apply(typedArrayLength, source, []);
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + byteLength > backingByteLength ||
        length !== byteLength) {return;}
    const output = new intrinsicUint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {output[index] = source[index]!;}
    return output;
  } catch {return;}
};

/** The only feature that still calls this composition-root-adjacent adapter is egress;
 * the sibling Runtime Security features already own their node:crypto access behind
 * their own adapters (node-sha256-dispatch-digest.ts, node-egress-cryptography.ts,
 * node-source-identity-digest.ts). This factory closes the same gap for egress. */
export const createNodeEgressSecurityPrimitives = (): EgressSecurityPrimitives => Object.freeze({
  sha256: (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  exactObject,
  callable: (value: unknown): value is (...args: never[]) => unknown => typeof value === "function" && !nodeTypes.isProxy(value),
  copyBytes: snapshotUint8Array,
  array: (value: unknown): value is unknown[] => Array.isArray(value) && !nodeTypes.isProxy(value),
  canonicalEd25519Signature: (value: unknown): value is string => {if (typeof value !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(value)) {return false;} const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 64 && decoded.toString("base64") === value;},
});
