import { types as utilTypes } from "node:util";

export const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);
if (typedArrayPrototype === null) {throw new TypeError("missing typed-array prototype");}

/** Capture a builtin once and always supply its receiver explicitly. */
export const captureHttpByteIntrinsic = (prototype: object, name: PropertyKey,
  slot: "value" | "get" = "value"): ((receiver: unknown, args?: readonly unknown[]) => unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  const callable: unknown = slot === "value" ? Reflect.get(prototype, name)
    : descriptor === undefined ? undefined : Reflect.get(descriptor, slot);
  if (typeof callable !== "function") {throw new TypeError("missing byte intrinsic");}
  return (receiver, args = []): unknown => Reflect.apply(callable, receiver, args);
};

const typedArrayByteLength = captureHttpByteIntrinsic(typedArrayPrototype, "byteLength", "get");
const typedArrayBuffer = captureHttpByteIntrinsic(typedArrayPrototype, "buffer", "get");
const typedArrayTag = captureHttpByteIntrinsic(typedArrayPrototype, Symbol.toStringTag, "get");
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable") === undefined
  ? undefined : captureHttpByteIntrinsic(ArrayBuffer.prototype, "resizable", "get");
const uint8ArrayFill = captureHttpByteIntrinsic(Uint8Array.prototype, "fill");
const uint8ArraySet = captureHttpByteIntrinsic(Uint8Array.prototype, "set");
const emptyBytes = new Uint8Array();

export const intrinsicUint8ArrayLength = (value: unknown): number | undefined => {
  try {
    if (typedArrayTag(value) !== "Uint8Array") {return undefined;}
    const byteLength = typedArrayByteLength(value);
    return typeof byteLength === "number" ? byteLength : undefined;
  } catch {
    return undefined;
  }
};

const hasFixedArrayBufferBacking = (value: unknown): boolean => {
  try {
    const buffer = typedArrayBuffer(value);
    return utilTypes.isArrayBuffer(buffer) && arrayBufferResizable !== undefined
      && arrayBufferResizable(buffer) === false;
  } catch {
    return false;
  }
};

/** Snapshots only a live, fixed ArrayBuffer-backed Uint8Array/Buffer. */
export const snapshotHttpBytes = (value: unknown, maximumByteLength: number): Uint8Array | undefined => {
  if (!hasFixedArrayBufferBacking(value)) {return undefined;}
  const byteLength = intrinsicUint8ArrayLength(value);
  if (byteLength === undefined || byteLength > maximumByteLength) {return undefined;}
  const snapshot = new Uint8Array(byteLength);
  try {
    uint8ArraySet(snapshot, [value]);
    return snapshot;
  } catch {
    return undefined;
  }
};

/** Clears a live Uint8Array/Buffer without consulting an overridable fill method. */
export const zeroHttpBytes = (value: unknown): void => {
  if (intrinsicUint8ArrayLength(value) === undefined) {return;}
  try {
    // Unlike the byte-length getter, set validates that an empty view is live.
    uint8ArraySet(value, [emptyBytes]);
  } catch {
    // Detached/invalid views have no accessible bytes to clear.
    return;
  }
  // A failure for a validated live view is a real cleanup failure, not a
  // detached-view condition. Do not convert it into successful cleanup.
  uint8ArrayFill(value, [0]);
};

export const zeroLateHttpBytes = (pending: Promise<Uint8Array> | undefined): void =>
  void pending?.then((value): undefined => {zeroHttpBytes(value); return undefined;}, () => {});
