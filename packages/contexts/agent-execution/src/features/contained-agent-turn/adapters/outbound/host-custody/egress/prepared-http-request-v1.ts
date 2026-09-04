import { snapshotHttpBytes, zeroHttpBytes } from "./http-byte-intrinsics.js";
import {
  PREPARED_HTTP_REQUEST_V1_LIMITS,
  PreparedHttpRequestV1Error,
  detachPreparedHttpByteSpanV1,
  type PreparedHttpRequestInputV1,
  type ValidatedPreparedHttpFieldV1,
  validatePreparedHttpRequestV1,
} from "./prepared-http-request-validation.js";

export { PREPARED_HTTP_REQUEST_V1_LIMITS, PreparedHttpRequestV1Error } from "./prepared-http-request-validation.js";
export type { PreparedHttpFieldInputV1, PreparedHttpRequestInputV1 } from "./prepared-http-request-validation.js";

export type PreparedHttpByteSpanV1 = Readonly<{offset: number; length: number}>;
export type PreparedHttpCredentialValueSpanV1 = Readonly<{
  name: string;
  offset: number;
  length: number;
}>;

/**
 * Host-private physical serialization. Header-line spans include their final
 * CRLF; credential-value spans exclude the field name, `: `, and CRLF.
 *
 * Input byte arrays remain caller-owned. This product snapshots them and owns
 * only wireBytes and headerProjectionBytes. dispose() clears both idempotently.
 * Span metadata and arrays are frozen. No whole-buffer atomicity is claimed
 * against concurrent SharedArrayBuffer writers.
 */
export type PreparedHttpRequestV1 = Readonly<{
  wireBytes: Uint8Array;
  targetSpan: PreparedHttpByteSpanV1;
  headerLineSpans: readonly PreparedHttpByteSpanV1[];
  credentialValueSpans: readonly PreparedHttpCredentialValueSpanV1[];
  bodySpan: PreparedHttpByteSpanV1;
  headerProjectionBytes: Uint8Array;
  snapshotSpan(span: PreparedHttpByteSpanV1): Uint8Array | undefined;
  dispose(): void;
}>;

const encoder = new TextEncoder();
const SPACE = encoder.encode(" ");
const HTTP_11_CRLF = encoder.encode(" HTTP/1.1\r\n");
const COLON_SPACE = encoder.encode(": ");
const CRLF = encoder.encode("\r\n");
const HOST = encoder.encode("Host");
const CONTENT_LENGTH = encoder.encode("Content-Length");

const checkedAdd = (left: number, right: number, maximum: number): number => {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > maximum || total > 0xffff_ffff) {
    throw new PreparedHttpRequestV1Error();
  }
  return total;
};

type EmittedField = Readonly<{
  name: string;
  nameBytes: Uint8Array;
  valueBytes: Uint8Array;
  credential: boolean;
}>;

const lineLength = (field: EmittedField): number => checkedAdd(
  checkedAdd(field.nameBytes.byteLength, COLON_SPACE.byteLength, 0xffff_ffff),
  checkedAdd(field.valueBytes.byteLength, CRLF.byteLength, 0xffff_ffff),
  0xffff_ffff,
);

const writeBytes = (target: Uint8Array, offset: number, source: Uint8Array): number => {
  for (let index = 0; index < source.byteLength; index += 1) {
    target[offset + index] = source[index] as number;
  }
  return offset + source.byteLength;
};

const freezeSpan = (offset: number, length: number): PreparedHttpByteSpanV1 => Object.freeze({offset, length});

const writeU32be = (target: Uint8Array, offset: number, value: number): number => {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
  return offset + 4;
};

const createHeaderProjection = (
  wireBytes: Uint8Array,
  spans: readonly PreparedHttpByteSpanV1[],
): Uint8Array => {
  let length = 4;
  for (const span of spans) {
    length = checkedAdd(length, checkedAdd(4, span.length,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumProjectionBytes),
    PREPARED_HTTP_REQUEST_V1_LIMITS.maximumProjectionBytes);
  }
  const projection = new Uint8Array(length);
  let offset = writeU32be(projection, 0, spans.length);
  for (const span of spans) {
    offset = writeU32be(projection, offset, span.length);
    for (let index = 0; index < span.length; index += 1) {
      projection[offset + index] = wireBytes[span.offset + index] as number;
    }
    offset += span.length;
  }
  return projection;
};

const asField = (field: ValidatedPreparedHttpFieldV1, credential: boolean): EmittedField => Object.freeze({
  name: field.normalizedName,
  nameBytes: field.nameBytes,
  valueBytes: field.valueBytes,
  credential,
});

/** Serializes once; it does not decide route, account, refresh, or authorization policy. */
export const createPreparedHttpRequestV1 = (input: PreparedHttpRequestInputV1): PreparedHttpRequestV1 => {
  const validated = validatePreparedHttpRequestV1(input);
  let wireBytes: Uint8Array | undefined;
  let headerProjectionBytes: Uint8Array | undefined;
  let contentLengthBytes: Uint8Array | undefined;
  try {
    contentLengthBytes = encoder.encode(String(validated.bodyBytes.byteLength));
    const fields: EmittedField[] = [];
    for (const field of validated.presentationFields) {fields.push(asField(field, false));}
    fields.push(Object.freeze({name: "host", nameBytes: HOST, valueBytes: validated.hostBytes, credential: false}));
    for (const field of validated.credentialFields) {fields.push(asField(field, true));}
    fields.push(Object.freeze({name: "content-length", nameBytes: CONTENT_LENGTH,
      valueBytes: contentLengthBytes, credential: false}));

    let requestLineLength = checkedAdd(validated.methodBytes.byteLength, SPACE.byteLength,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumWireBytes);
    requestLineLength = checkedAdd(requestLineLength, validated.targetBytes.byteLength,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumWireBytes);
    requestLineLength = checkedAdd(requestLineLength, HTTP_11_CRLF.byteLength,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumWireBytes);
    let wireLength = requestLineLength;
    for (const field of fields) {
      wireLength = checkedAdd(wireLength, lineLength(field), PREPARED_HTTP_REQUEST_V1_LIMITS.maximumWireBytes);
    }
    wireLength = checkedAdd(wireLength, CRLF.byteLength, PREPARED_HTTP_REQUEST_V1_LIMITS.maximumWireBytes);
    wireLength = checkedAdd(wireLength, validated.bodyBytes.byteLength,
      PREPARED_HTTP_REQUEST_V1_LIMITS.maximumWireBytes);

    wireBytes = new Uint8Array(wireLength);
    let offset = writeBytes(wireBytes, 0, validated.methodBytes);
    offset = writeBytes(wireBytes, offset, SPACE);
    const targetSpan = freezeSpan(offset, validated.targetBytes.byteLength);
    offset = writeBytes(wireBytes, offset, validated.targetBytes);
    offset = writeBytes(wireBytes, offset, HTTP_11_CRLF);

    const headerLineSpans: PreparedHttpByteSpanV1[] = [];
    const credentialValueSpans: PreparedHttpCredentialValueSpanV1[] = [];
    for (const field of fields) {
      const lineOffset = offset;
      offset = writeBytes(wireBytes, offset, field.nameBytes);
      offset = writeBytes(wireBytes, offset, COLON_SPACE);
      if (field.credential) {
        credentialValueSpans.push(Object.freeze({name: field.name, offset, length: field.valueBytes.byteLength}));
      }
      offset = writeBytes(wireBytes, offset, field.valueBytes);
      offset = writeBytes(wireBytes, offset, CRLF);
      headerLineSpans.push(freezeSpan(lineOffset, offset - lineOffset));
    }
    offset = writeBytes(wireBytes, offset, CRLF);
    const bodySpan = freezeSpan(offset, validated.bodyBytes.byteLength);
    offset = writeBytes(wireBytes, offset, validated.bodyBytes);
    if (offset !== wireBytes.byteLength) {throw new PreparedHttpRequestV1Error();}

    headerProjectionBytes = createHeaderProjection(wireBytes, headerLineSpans);
    const ownedWireBytes = wireBytes;
    const ownedProjectionBytes = headerProjectionBytes;
    const ownedWireLength = ownedWireBytes.byteLength;
    let disposed = false;
    return Object.freeze({
      wireBytes: ownedWireBytes,
      targetSpan,
      headerLineSpans: Object.freeze(headerLineSpans),
      credentialValueSpans: Object.freeze(credentialValueSpans),
      bodySpan,
      headerProjectionBytes: ownedProjectionBytes,
      snapshotSpan: (span: PreparedHttpByteSpanV1): Uint8Array | undefined => {
        if (disposed) {return undefined;}
        const detachedSpan = detachPreparedHttpByteSpanV1(span, ownedWireLength);
        if (detachedSpan === undefined) {return undefined;}
        // The two intrinsic snapshots establish an exact live length without
        // consulting an overridable property on the exposed result view.
        const shorterWireSnapshot = snapshotHttpBytes(ownedWireBytes, ownedWireLength - 1);
        if (shorterWireSnapshot !== undefined) {
          zeroHttpBytes(shorterWireSnapshot);
          return undefined;
        }
        const wireSnapshot = snapshotHttpBytes(ownedWireBytes, ownedWireLength);
        if (wireSnapshot === undefined) {return undefined;}
        try {
          const {offset: spanOffset, length: spanLength} = detachedSpan;
          const copy = new Uint8Array(spanLength);
          for (let index = 0; index < spanLength; index += 1) {
            copy[index] = wireSnapshot[spanOffset + index] as number;
          }
          return copy;
        } finally {
          zeroHttpBytes(wireSnapshot);
        }
      },
      dispose: (): void => {
        if (disposed) {return;}
        disposed = true;
        zeroHttpBytes(ownedWireBytes);
        zeroHttpBytes(ownedProjectionBytes);
      },
    });
  } catch (error) {
    zeroHttpBytes(wireBytes);
    zeroHttpBytes(headerProjectionBytes);
    if (error instanceof PreparedHttpRequestV1Error) {throw error;}
    throw new PreparedHttpRequestV1Error();
  } finally {
    zeroHttpBytes(contentLengthBytes);
    for (const value of validated.temporaryCopies) {zeroHttpBytes(value);}
  }
};
