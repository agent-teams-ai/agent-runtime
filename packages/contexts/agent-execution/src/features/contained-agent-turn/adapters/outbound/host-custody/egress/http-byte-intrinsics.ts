import { types as utilTypes } from "node:util";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;

const intrinsicGetter = (name: "buffer" | "byteLength" | typeof Symbol.toStringTag): ((this: unknown) => unknown) => {
  const getter = Object.getOwnPropertyDescriptor(typedArrayPrototype, name)?.get;
  if (getter === undefined) {throw new TypeError("missing typed-array intrinsic");}
  return getter;
};

const typedArrayByteLength = intrinsicGetter("byteLength");
const typedArrayBuffer = intrinsicGetter("buffer");
const typedArrayTag = intrinsicGetter(Symbol.toStringTag);
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const uint8ArrayFill = Uint8Array.prototype.fill;
const uint8ArraySet = Uint8Array.prototype.set;
const emptyBytes = new Uint8Array();

export const intrinsicUint8ArrayLength = (value: unknown): number | undefined => {
  try {
    if (Reflect.apply(typedArrayTag, value, []) !== "Uint8Array") {return undefined;}
    const byteLength = Reflect.apply(typedArrayByteLength, value, []);
    return typeof byteLength === "number" ? byteLength : undefined;
  } catch {
    return undefined;
  }
};

const hasFixedArrayBufferBacking = (value: unknown): boolean => {
  try {
    const buffer = Reflect.apply(typedArrayBuffer, value, []);
    return utilTypes.isArrayBuffer(buffer) && arrayBufferResizable !== undefined
      && Reflect.apply(arrayBufferResizable, buffer, []) === false;
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
    Reflect.apply(uint8ArraySet, snapshot, [value]);
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
    Reflect.apply(uint8ArraySet, value, [emptyBytes]);
  } catch {
    // Detached/invalid views have no accessible bytes to clear.
    return;
  }
  // A failure for a validated live view is a real cleanup failure, not a
  // detached-view condition. Do not convert it into successful cleanup.
  Reflect.apply(uint8ArrayFill, value, [0]);
};

export const zeroLateHttpBytes = (pending: Promise<Uint8Array> | undefined): void =>
  void pending?.then(value => zeroHttpBytes(value), () => {});
