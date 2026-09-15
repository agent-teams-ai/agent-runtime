const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteLength",
);
const nameDescriptor = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, Symbol.toStringTag,
);
const typedArrayByteLength: unknown = byteLengthDescriptor === undefined
  ? undefined : Reflect.get(byteLengthDescriptor, "get") as unknown;
const typedArrayName: unknown = nameDescriptor === undefined
  ? undefined : Reflect.get(nameDescriptor, "get") as unknown;
const uint8ArraySet: unknown = Reflect.get(Uint8Array.prototype, "set");

export const copyBoundedUint8Array = (
  value: unknown,
  maximumBytes: number,
): Uint8Array | "too-large" | undefined => {
  try {
    if (typeof typedArrayName !== "function" || typeof typedArrayByteLength !== "function" ||
        typeof uint8ArraySet !== "function") {return undefined;}
    const name: unknown = Reflect.apply(typedArrayName, value, []);
    const byteLength: unknown = Reflect.apply(typedArrayByteLength, value, []);
    if (name !== "Uint8Array" || typeof byteLength !== "number") {return undefined;}
    if (byteLength > maximumBytes) {return "too-large";}
    const bytes = new Uint8Array(byteLength);
    Reflect.apply(uint8ArraySet, bytes, [value]);
    return bytes;
  } catch {
    return undefined;
  }
};
