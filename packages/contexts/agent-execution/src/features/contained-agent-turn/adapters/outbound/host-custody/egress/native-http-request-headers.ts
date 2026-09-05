import { types as utilTypes } from "node:util";
import { nativeHeaderValueAllowed, NATIVE_HTTP_HEADER_LIMITS,
  type NativeHttpRequestProfile, type NativeHttpRequestProfileId } from "./native-http-request-profile.js";

type PresentationField = Readonly<{name: string; valueBytes: Uint8Array}>;
/** Explicit profile carrier through the existing broker preparation seam; no ambient registry. */
export type NativeHttpPresentationFields = Readonly<{requestProfile: NativeHttpRequestProfileId;
  fields: readonly PresentationField[]}>;

const encoder = new TextEncoder();
const invalid = (): never => {throw new TypeError("invalid HTTP presentation fields");};
const data = (value: unknown, names: readonly string[]): Record<string, PropertyDescriptor> => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return invalid();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length
    || names.some(name => descriptors[name] === undefined || !("value" in descriptors[name]!))) {return invalid();}
  return descriptors;
};

const headerEntries = (value: unknown, maximum: number): readonly unknown[] => {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) {return invalid();}
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {return invalid();}
    result.push(descriptor.value);
  }
  return result;
};

const nativeIgnoredHeader = (profile: NativeHttpRequestProfile, name: string, value: string): boolean => {
  if (name === "connection") {return value === "close" || value === "keep-alive";}
  return ["authorization", "host", "content-length", "accept-encoding"].includes(name)
    || profile.credentialMode === "chatgpt-account" && name === "chatgpt-account-id";
};

const readHeader = (entry: unknown): Readonly<{name: string; value: string}> => {
  const field = data(entry, ["name", "value"]);
  const name: unknown = field.name?.value; const value: unknown = field.value?.value;
  if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(name)
    || typeof value !== "string" || !/^[\t\x20-\x7e]*$/.test(value) || value.length > 16_384) {return invalid();}
  return {name, value};
};

const validateNativeHeaderBounds = (name: string, value: string, names: ReadonlySet<string>, total: number): void => {
  if (names.has(name) || value.length > NATIVE_HTTP_HEADER_LIMITS.maximumValueBytes
    || total > NATIVE_HTTP_HEADER_LIMITS.maximumTotalValueBytes || !/^[\x20-\x7e]+$/.test(value)) {invalid();}
};

export const selectHttpPresentationFields = (request: unknown, allowed: readonly string[],
  profile?: NativeHttpRequestProfile): readonly PresentationField[] | NativeHttpPresentationFields => {
  const descriptors = data(request, ["method", "path", "headers", "body", "wireBytes"]);
  if (profile !== undefined && (descriptors.method?.value !== profile.upstreamMethod
    || descriptors.path?.value !== profile.upstreamPath)) {return invalid();}
  const entries = headerEntries(descriptors.headers?.value,
    profile === undefined ? 1_024 : NATIVE_HTTP_HEADER_LIMITS.maximumInboundFields);
  const names = new Set<string>(); const selected: PresentationField[] = []; let totalValueBytes = 0;
  for (const entry of entries) {
    const {name, value} = readHeader(entry);
    if (profile !== undefined) {
      totalValueBytes += value.length;
      validateNativeHeaderBounds(name, value, names, totalValueBytes);
    }
    if (allowed.includes(name)) {
      if (names.has(name) || profile !== undefined && !nativeHeaderValueAllowed(profile, name, value)) {return invalid();}
      selected.push(Object.freeze({name, valueBytes: encoder.encode(value)}));
    } else if (profile !== undefined && !nativeIgnoredHeader(profile, name, value)) {return invalid();}
    names.add(name);
  }
  if (profile?.requiredHeaderNames.some(name => !names.has(name))) {return invalid();}
  const fields = Object.freeze(selected.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return profile === undefined ? fields : Object.freeze({requestProfile: profile.id, fields});
};
