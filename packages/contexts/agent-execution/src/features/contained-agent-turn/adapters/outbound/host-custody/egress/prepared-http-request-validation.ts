import { types as utilTypes } from "node:util";
import { snapshotHttpBytes, zeroHttpBytes } from "./http-byte-intrinsics.js";

export const PREPARED_HTTP_REQUEST_V1_LIMITS = Object.freeze({
  maximumMethodBytes: 32,
  maximumTargetBytes: 8_192,
  maximumHostBytes: 261,
  maximumFieldNameBytes: 128,
  maximumFieldValueBytes: 16_384,
  maximumPresentationFields: 2,
  maximumCredentialFields: 32,
  maximumBodyBytes: 1_048_576,
  maximumWireBytes: 1_600_000,
  maximumProjectionBytes: 600_000,
});

export class PreparedHttpRequestV1Error extends Error {
  public constructor() {
    super("invalid prepared HTTP request input");
    this.name = "PreparedHttpRequestV1Error";
  }
}

export type PreparedHttpFieldInputV1 = Readonly<{
  name: string;
  valueBytes: Uint8Array;
}>;

export type PreparedHttpRequestInputV1 = Readonly<{
  methodBytes: Uint8Array;
  targetBytes: Uint8Array;
  hostBytes: Uint8Array;
  presentationFields: readonly PreparedHttpFieldInputV1[];
  credentialFields: readonly PreparedHttpFieldInputV1[];
  bodyBytes: Uint8Array;
}>;

export type ValidatedPreparedHttpFieldV1 = Readonly<{
  normalizedName: string;
  nameBytes: Uint8Array;
  valueBytes: Uint8Array;
}>;

export type ValidatedPreparedHttpRequestV1 = Readonly<{
  methodBytes: Uint8Array;
  targetBytes: Uint8Array;
  hostBytes: Uint8Array;
  presentationFields: readonly ValidatedPreparedHttpFieldV1[];
  credentialFields: readonly ValidatedPreparedHttpFieldV1[];
  bodyBytes: Uint8Array;
  temporaryCopies: readonly Uint8Array[];
}>;

const INPUT_FIELDS = ["methodBytes", "targetBytes", "hostBytes", "presentationFields",
  "credentialFields", "bodyBytes"] as const;
const FIELD_INPUT_FIELDS = ["name", "valueBytes"] as const;
const BYTE_SPAN_FIELDS = ["offset", "length"] as const;
const CREDENTIAL_BYTE_SPAN_FIELDS = ["name", "offset", "length"] as const;
const PRESENTATION_NAMES = new Set(["accept", "content-type"]);
const CREDENTIAL_COLLISIONS = new Set([
  "accept", "connection", "content-length", "content-type", "expect", "host", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade",
]);
const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isPlainRecordWithDataFields = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {return false;}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return false;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === fields.length
    && keys.every(key => typeof key === "string" && fields.includes(key))
    && fields.every(field => descriptors[field] !== undefined && "value" in (descriptors[field] as PropertyDescriptor));
};

export const detachPreparedHttpByteSpanV1 = (
  value: unknown,
  maximum: number,
): Readonly<{offset: number; length: number}> | undefined => {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const spanFields: readonly string[] | undefined = keys.length === BYTE_SPAN_FIELDS.length
      && keys.every(key => typeof key === "string" && BYTE_SPAN_FIELDS.some(field => field === key))
      ? BYTE_SPAN_FIELDS
      : keys.length === CREDENTIAL_BYTE_SPAN_FIELDS.length
        && keys.every(key => typeof key === "string" && CREDENTIAL_BYTE_SPAN_FIELDS.some(field => field === key))
        ? CREDENTIAL_BYTE_SPAN_FIELDS
        : undefined;
    if (spanFields === undefined
      || !spanFields.every(field => descriptors[field] !== undefined
        && "value" in (descriptors[field] as PropertyDescriptor))
      || !Object.isFrozen(value)) {
      return undefined;
    }
    const offset = descriptors.offset?.value as unknown;
    const length = descriptors.length?.value as unknown;
    if (typeof offset !== "number" || typeof length !== "number"
      || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0) {
      return undefined;
    }
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > maximum) {return undefined;}
    return {offset, length};
  } catch {
    return undefined;
  }
};

const snapshot = (value: unknown, maximum: number, acquired: Uint8Array[]): Uint8Array => {
  const result = snapshotHttpBytes(value, maximum);
  if (result === undefined) {throw new PreparedHttpRequestV1Error();}
  acquired.push(result);
  return result;
};

const isTokenByte = (byte: number): boolean =>
  (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
  || byte === 33 || byte === 35 || byte === 36 || byte === 37 || byte === 38 || byte === 39
  || byte === 42 || byte === 43 || byte === 45 || byte === 46 || byte === 94 || byte === 95
  || byte === 96 || byte === 124 || byte === 126;

const bytesMatchAscii = (bytes: Uint8Array, text: string): boolean => {
  if (bytes.byteLength !== text.length) {return false;}
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== text.charCodeAt(index)) {return false;}
  }
  return true;
};

const isHexByte = (byte: number | undefined): boolean => byte !== undefined
  && ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102));

const validateMethod = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0 || bytesMatchAscii(bytes, "CONNECT")) {throw new PreparedHttpRequestV1Error();}
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (!isTokenByte(bytes[index] as number)) {throw new PreparedHttpRequestV1Error();}
  }
};

const validateTarget = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0 || bytes[0] !== 47 || bytes[1] === 47) {throw new PreparedHttpRequestV1Error();}
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index] as number;
    const alphaNumeric = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122);
    const pcharPunctuation = byte === 33 || byte === 36 || byte === 38 || byte === 39
      || byte === 40 || byte === 41 || byte === 42 || byte === 43 || byte === 44
      || byte === 45 || byte === 46 || byte === 58 || byte === 59 || byte === 61
      || byte === 64 || byte === 95 || byte === 126;
    if (alphaNumeric || pcharPunctuation || byte === 47) {continue;}
    if (byte === 37 && isHexByte(bytes[index + 1]) && isHexByte(bytes[index + 2])) {index += 2; continue;}
    throw new PreparedHttpRequestV1Error();
  }
};

const validateHost = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0) {throw new PreparedHttpRequestV1Error();}
  let colon = -1;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index] as number;
    const hostCharacter = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122) || byte === 45 || byte === 46;
    if (hostCharacter) {continue;}
    if (byte === 58 && colon < 0 && index > 0 && index < bytes.byteLength - 1) {colon = index; continue;}
    throw new PreparedHttpRequestV1Error();
  }
  if (bytes[0] === 46 || bytes[bytes.byteLength - 1] === 46) {throw new PreparedHttpRequestV1Error();}
  if (colon >= 0) {
    let port = 0;
    for (let index = colon + 1; index < bytes.byteLength; index += 1) {
      const byte = bytes[index] as number;
      if (byte < 48 || byte > 57) {throw new PreparedHttpRequestV1Error();}
      port = (port * 10) + byte - 48;
    }
    if (port < 1 || port > 65_535) {throw new PreparedHttpRequestV1Error();}
  }
};

const validateValue = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0) {throw new PreparedHttpRequestV1Error();}
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index] as number;
    if (byte !== 9 && (byte < 32 || byte > 126)) {throw new PreparedHttpRequestV1Error();}
  }
};

const exactArrayValues = (value: unknown, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maximum) {
    throw new PreparedHttpRequestV1Error();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== value.length + 1 || lengthDescriptor?.value !== value.length) {
    throw new PreparedHttpRequestV1Error();
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {throw new PreparedHttpRequestV1Error();}
    result.push(descriptor.value);
  }
  return result;
};

const insertSorted = (fields: ValidatedPreparedHttpFieldV1[], field: ValidatedPreparedHttpFieldV1): void => {
  let index = 0;
  while (index < fields.length && (fields[index] as ValidatedPreparedHttpFieldV1).normalizedName < field.normalizedName) {
    index += 1;
  }
  fields.splice(index, 0, field);
};

const validateFields = (
  value: unknown,
  maximum: number,
  kind: "presentation" | "credential",
  acquired: Uint8Array[],
): readonly ValidatedPreparedHttpFieldV1[] => {
  const fields: ValidatedPreparedHttpFieldV1[] = [];
  const names = new Set<string>();
  for (const candidate of exactArrayValues(value, maximum)) {
    if (!isPlainRecordWithDataFields(candidate, FIELD_INPUT_FIELDS)) {throw new PreparedHttpRequestV1Error();}
    const name = candidate.name;
    if (typeof name !== "string" || name.length === 0
      || name.length > PREPARED_HTTP_REQUEST_V1_LIMITS.maximumFieldNameBytes || !TOKEN.test(name)) {
      throw new PreparedHttpRequestV1Error();
    }
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)
      || (kind === "presentation" ? !PRESENTATION_NAMES.has(normalizedName) || name !== normalizedName
        : CREDENTIAL_COLLISIONS.has(normalizedName))) {
      throw new PreparedHttpRequestV1Error();
    }
    names.add(normalizedName);
    const valueBytes = snapshot(candidate.valueBytes, PREPARED_HTTP_REQUEST_V1_LIMITS.maximumFieldValueBytes, acquired);
    validateValue(valueBytes);
    const nameBytes = encoder.encode(normalizedName);
    acquired.push(nameBytes);
    insertSorted(fields, Object.freeze({normalizedName, nameBytes, valueBytes}));
  }
  return Object.freeze(fields);
};

export const validatePreparedHttpRequestV1 = (input: unknown): ValidatedPreparedHttpRequestV1 => {
  const acquired: Uint8Array[] = [];
  try {
    if (!isPlainRecordWithDataFields(input, INPUT_FIELDS)) {throw new PreparedHttpRequestV1Error();}
    const methodBytes = snapshot(input.methodBytes, PREPARED_HTTP_REQUEST_V1_LIMITS.maximumMethodBytes, acquired);
    const targetBytes = snapshot(input.targetBytes, PREPARED_HTTP_REQUEST_V1_LIMITS.maximumTargetBytes, acquired);
    const hostBytes = snapshot(input.hostBytes, PREPARED_HTTP_REQUEST_V1_LIMITS.maximumHostBytes, acquired);
    const bodyBytes = snapshot(input.bodyBytes, PREPARED_HTTP_REQUEST_V1_LIMITS.maximumBodyBytes, acquired);
    validateMethod(methodBytes);
    validateTarget(targetBytes);
    validateHost(hostBytes);
    const presentationFields = validateFields(input.presentationFields,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumPresentationFields, "presentation", acquired);
    const credentialFields = validateFields(input.credentialFields,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumCredentialFields, "credential", acquired);
    return Object.freeze({methodBytes, targetBytes, hostBytes, presentationFields,
      credentialFields, bodyBytes, temporaryCopies: Object.freeze(acquired)});
  } catch (error) {
    for (const value of acquired) {zeroHttpBytes(value);}
    if (error instanceof PreparedHttpRequestV1Error) {throw error;}
    throw new PreparedHttpRequestV1Error();
  }
};
