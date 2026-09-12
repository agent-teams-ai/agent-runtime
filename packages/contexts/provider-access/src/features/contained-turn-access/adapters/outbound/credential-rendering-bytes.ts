import { isRuntimeProxy } from "../provider-access-data.js";
import type {
  CredentialGenerationRequest, CredentialRecipe, RenderedCredentialField, RenderedCredentialFields,
} from "./credential-rendering-contracts.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bytesLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const bytesBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const bytesTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const fill = Uint8Array.prototype.fill;
const set = Uint8Array.prototype.set;
const invalid = (): never => {throw new TypeError("invalid credential material");};

/** Shallow, non-trapping data inspection; never invokes value getters or toJSON. */
export const credentialData = (value: unknown): Record<string, PropertyDescriptor> => {
  if (value === null || typeof value !== "object" || isRuntimeProxy(value)) {return invalid();}
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {return invalid();}
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16 || keys.some(key => typeof key !== "string")) {return invalid();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(descriptor => !("value" in descriptor))) {return invalid();}
  return descriptors;
};
export const exactCredentialData = (value: unknown, keys: readonly string[]): Record<string, PropertyDescriptor> => {
  const data = credentialData(value);
  if (Object.keys(data).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {return invalid();}
  return data;
};

const lengthOf = (value: unknown): number => {
  if (isRuntimeProxy(value) || !bytesTag || Reflect.apply(bytesTag, value, []) !== "Uint8Array" ||
    !bytesLength || !bytesBuffer || !bufferLength || !bufferResizable) {
    return invalid();
  }
  const length = Reflect.apply(bytesLength, value, []) as number;
  const buffer = Reflect.apply(bytesBuffer, value, []) as unknown;
  // ArrayBuffer intrinsic rejects SharedArrayBuffer. Require dedicated, fixed storage.
  if (Reflect.apply(bufferLength, buffer, []) !== length || Reflect.apply(bufferResizable, buffer, [])) {return invalid();}
  return length;
};
const erase = (value: unknown): void => {
  try {
    if (!isRuntimeProxy(value) && bytesTag && Reflect.apply(bytesTag, value, []) === "Uint8Array") {Reflect.apply(fill, value, [0]);}
  } catch { /* Detached or inaccessible buffers cannot be read or rendered. */ }
};

/** Wipe reachable data slots even if validation fails; no proxy/accessor traversal. */
export const eraseGeneration = (value: unknown): void => {
  if (value === null || typeof value !== "object" || isRuntimeProxy(value)) {return;}
  const fields = Object.getOwnPropertyDescriptor(value, "fields");
  if (!fields || !("value" in fields) || isRuntimeProxy(fields.value) || !Array.isArray(fields.value)) {return;}
  const length = Object.getOwnPropertyDescriptor(fields.value, "length")?.value as unknown;
  if (typeof length !== "number") {return;}
  // Contract transfers at most two slots. Bound salvage of malformed producers to 16.
  for (let index = 0; index < Math.min(length, 16); index += 1) {
    const slot = Object.getOwnPropertyDescriptor(fields.value, String(index));
    if (!slot || !("value" in slot) || slot.value === null || typeof slot.value !== "object" || isRuntimeProxy(slot.value)) {continue;}
    const bytes = Object.getOwnPropertyDescriptor(slot.value, "valueBytes");
    if (bytes && "value" in bytes) {erase(bytes.value);}
  }
};

const fieldSlots = (value: unknown, count: number): unknown[] => {
  if (isRuntimeProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {return invalid();}
  if (Object.getOwnPropertyDescriptor(value, "length")?.value !== count) {return invalid();}
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  if (descriptors.length?.value !== count || Reflect.ownKeys(descriptors).length !== count + 1) {return invalid();}
  return Array.from({length: count}, (_, index) => {
    const slot = descriptors[String(index)];
    if (!slot || !("value" in slot)) {return invalid();}
    return slot.value as unknown;
  });
};
const recipeFields = (recipe: CredentialRecipe): readonly string[] =>
  recipe === "codex-chatgpt" ? ["token", "accountId"] : recipe === "claude-api" ? ["apiKey"] : ["token"];
const renderField = (value: unknown, expected: string): RenderedCredentialField => {
  const data = exactCredentialData(value, ["name", "valueBytes"]);
  if (data.name?.value !== expected) {return invalid();}
  const raw: unknown = data.valueBytes?.value;
  const length = lengthOf(raw);
  const maximum = expected === "accountId" ? 256 : 8192;
  if (length === 0 || length > maximum) {return invalid();}
  const prefix = expected === "token" ? [66, 101, 97, 114, 101, 114, 32] : [];
  const bytes = new Uint8Array(length + prefix.length);
  try {
    Reflect.apply(set, bytes, [raw, prefix.length]);
    for (let index = prefix.length; index < bytes.length; index += 1) {
      const byte = bytes[index] as number;
      if (byte < 0x21 || byte > 0x7e) {return invalid();}
    }
    Reflect.apply(set, bytes, [prefix]);
    return Object.freeze({
      name: expected === "token" ? "Authorization" : expected === "accountId" ? "ChatGPT-Account-ID" : "x-api-key",
      valueBytes: bytes,
    });
  } catch {erase(bytes); return invalid();}
};

export const renderGeneration = (value: unknown, request: CredentialGenerationRequest): RenderedCredentialFields | undefined => {
  const rendered: RenderedCredentialField[] = [];
  try {
    const head = credentialData(value);
    if (head.kind?.value === "unsupported") {
      exactCredentialData(value, ["kind"]);
      return undefined;
    }
    const data = exactCredentialData(value, ["kind", "request", "fields"]);
    if (data.kind?.value !== "acquired" || data.request?.value !== request) {return invalid();}
    const expected = recipeFields(request.recipe);
    const slots = fieldSlots(data.fields?.value, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      rendered.push(renderField(slots[index], expected[index] as string));
    }
    const fields = Object.freeze(rendered);
    return Object.freeze({fields, release() {for (const field of fields) {erase(field.valueBytes);}}});
  } catch {for (const field of rendered) {erase(field.valueBytes);} return invalid();}
  finally {eraseGeneration(value);}
};
