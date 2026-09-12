import { isRuntimeProxy } from "../provider-access-data.js";
import { exactCredentialData } from "./credential-rendering-bytes.js";
import type { CredentialRecipe, PrivateCredentialField } from "./credential-rendering-contracts.js";

const nativeBytes = Uint8Array;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const byteTag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")!.get!;
const transfer = ArrayBuffer.prototype.transferToFixedLength;
const fill = Uint8Array.prototype.fill;
const set = Uint8Array.prototype.set;
const invalid = (): never => {throw new TypeError("invalid operation credential material");};

interface MaterialBuffer {
  readonly name: PrivateCredentialField["name"];
  readonly buffer: ArrayBuffer;
}

/** Intrinsics avoid producer getters, iterators, species and shadowed byte methods. */
const inspectField = (value: unknown, name: PrivateCredentialField["name"]): MaterialBuffer => {
  const data = exactCredentialData(value, ["name", "valueBytes"]);
  const bytes: unknown = data.valueBytes?.value;
  if (data.name?.value !== name || isRuntimeProxy(bytes) || Reflect.apply(byteTag, bytes, []) !== "Uint8Array") {return invalid();}
  const length = Reflect.apply(byteLength, bytes, []) as number;
  const buffer = Reflect.apply(byteBuffer, bytes, []) as ArrayBuffer;
  // ArrayBuffer's intrinsic rejects shared storage. Equal lengths imply zero offset.
  if (length < 1 || length > (name === "accountId" ? 256 : 8192) ||
    Reflect.apply(bufferLength, buffer, []) !== length || Reflect.apply(resizable, buffer, [])) {return invalid();}
  for (let index = 0; index < length; index += 1) {
    const byte = (bytes as Uint8Array)[index] as number;
    if (byte < 0x21 || byte > 0x7e) {return invalid();}
  }
  return {name, buffer};
};

/** Same ordered recipes, lengths and visible ASCII rules as credential rendering. */
export const inspectOperationMaterial = (value: unknown, recipe: CredentialRecipe): readonly MaterialBuffer[] => {
  const names: readonly PrivateCredentialField["name"][] = recipe === "codex-chatgpt" ? ["token", "accountId"] :
    recipe === "claude-api" ? ["apiKey"] : ["token"];
  if (isRuntimeProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertyDescriptor(value, "length")?.value !== names.length || Reflect.ownKeys(value).length !== names.length + 1) {
    return invalid();
  }
  const fields = names.map((name, index) => {
    const slot = Object.getOwnPropertyDescriptor(value, String(index));
    if (!slot || !("value" in slot)) {return invalid();}
    return inspectField(slot.value, name);
  });
  if (fields.length === 2 && fields[0]?.buffer === fields[1]?.buffer) {return invalid();}
  return fields;
};

const eraseBuffer = (buffer: ArrayBuffer): void => {
  // The native constructor stays available even if constructing a returned view fails.
  Reflect.apply(fill, new nativeBytes(buffer), [0]);
};
export const eraseOperationMaterial = (fields: readonly PrivateCredentialField[]): void => {
  for (const field of fields) {Reflect.apply(fill, field.valueBytes, [0]);}
};

/** No producer record is cloned. Each successful transfer immediately belongs to PA. */
export const transferOperationMaterial = (fields: readonly MaterialBuffer[]): readonly PrivateCredentialField[] => {
  const owned: ArrayBuffer[] = [];
  try {
    const result = fields.map(field => {
      const buffer = Reflect.apply(transfer, field.buffer, []) as ArrayBuffer;
      owned.push(buffer);
      return Object.freeze({name: field.name, valueBytes: new Uint8Array(buffer)});
    });
    return Object.freeze(result);
  } catch {
    for (const buffer of owned) {eraseBuffer(buffer);}
    return invalid();
  }
};

/** Fresh dedicated buffers; neither seed views nor output views are retained together. */
export const copyOperationMaterial = (seed: readonly PrivateCredentialField[]): readonly PrivateCredentialField[] => {
  const result: PrivateCredentialField[] = [];
  try {
    for (const field of seed) {
      const bytes = new Uint8Array(field.valueBytes.length);
      result.push({name: field.name, valueBytes: bytes});
      Reflect.apply(set, bytes, [field.valueBytes]);
    }
    return Object.freeze(result.map(field => Object.freeze(field)));
  } catch {eraseOperationMaterial(result); return invalid();}
};
