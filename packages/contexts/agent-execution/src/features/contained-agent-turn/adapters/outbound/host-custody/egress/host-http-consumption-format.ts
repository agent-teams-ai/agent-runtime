import { createHash } from "node:crypto";
import { types } from "node:util";

import type { HostHttpGrant } from "./http-egress-ports.js";

export type ConsumptionKey = HostHttpGrant["payload"]["consumption"]["journalKey"];

/** Host-private, credential-free selections. These references do not authenticate
 * a claim, a current authority cut, a Docker observation, or a signer. */
export interface HostHttpConsumptionEnvelope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly scopeDigest: string;
  readonly attemptId: string;
  readonly custodyId: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly executionGenerationId: string;
  readonly selectedDockerAuthorityDigest: string;
  readonly networkNamespaceIdentity: string;
  readonly cgroupIdentity: string;
  readonly listenerIdentity: string;
  readonly signerIdentity: string;
}

export interface HostHttpConsumptionLimits {
  readonly maxBoundaryUses: number;
  readonly maxJournalBytes: number;
}

export const CONSUMPTION_FILE = "host-http-consumption-v1.journal";
export const CONSUMPTION_TOMBSTONE = "host-http-consumption-v1.tombstone";
export const MAX_FRAME_BYTES = 4_096;
export const MAX_CONSUMPTION_BYTES = 2_048;
export const MAX_SCAN_ENTRIES = 2;
const FRAME_PREFIX_BYTES = 36;
const VERSION = "host-http-consumption/v1";
const NAMESPACE = "provider-process-egress/v2";
const KEY_FIELDS = ["namespace", "tenantId", "projectId", "operationId", "boundaryUseId"] as const;
const ENVELOPE_FIELDS = [
  "tenantId", "projectId", "operationId", "scopeDigest", "attemptId", "custodyId",
  "hostInstanceId", "hostBootId", "executionGenerationId", "selectedDockerAuthorityDigest",
  "networkNamespaceIdentity", "cgroupIdentity", "listenerIdentity", "signerIdentity",
] as const;

// Do not coerce, normalize, concatenate with delimiters, or invoke accessors on
// signed inputs. Bound the object before copying or serializing any of its data.
const exact = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) { throw new Error("invalid consumption shape"); }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new Error("invalid consumption fields");
  }
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid consumption data");
    }
  }
  return value as Record<string, unknown>;
};

const opaque = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(value)) {
    throw new Error("invalid consumption identity");
  }
  return value;
};

export const consumptionDigest = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const consumptionFingerprint = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error("invalid consumption digest");
  }
  return value;
};

export const captureConsumptionEnvelope = (input: HostHttpConsumptionEnvelope): HostHttpConsumptionEnvelope => {
  const value = exact(input, ENVELOPE_FIELDS);
  const snapshot = Object.fromEntries(ENVELOPE_FIELDS.map(key => [key, opaque(value[key])]));
  consumptionFingerprint(snapshot.scopeDigest);
  consumptionFingerprint(snapshot.selectedDockerAuthorityDigest);
  return Object.freeze(snapshot) as unknown as HostHttpConsumptionEnvelope;
};

export const captureConsumptionKey = (input: ConsumptionKey): ConsumptionKey => {
  const value = exact(input, KEY_FIELDS);
  if (value.namespace !== NAMESPACE) { throw new Error("invalid consumption namespace"); }
  return Object.freeze({ namespace: NAMESPACE, tenantId: opaque(value.tenantId),
    projectId: opaque(value.projectId), operationId: opaque(value.operationId), boundaryUseId: opaque(value.boundaryUseId) });
};

export const sameConsumptionScope = (key: ConsumptionKey, envelope: HostHttpConsumptionEnvelope): boolean =>
  key.tenantId === envelope.tenantId && key.projectId === envelope.projectId && key.operationId === envelope.operationId;

export const captureConsumptionLimits = (input?: HostHttpConsumptionLimits): HostHttpConsumptionLimits => {
  const value = input === undefined ? { maxBoundaryUses: 256, maxJournalBytes: 1_048_576 } :
    exact(input, ["maxBoundaryUses", "maxJournalBytes"]);
  const { maxBoundaryUses, maxJournalBytes } = value;
  if (!Number.isSafeInteger(maxBoundaryUses) || (maxBoundaryUses as number) < 1 || (maxBoundaryUses as number) > 256 ||
      !Number.isSafeInteger(maxJournalBytes) || (maxJournalBytes as number) < MAX_FRAME_BYTES + MAX_CONSUMPTION_BYTES ||
      (maxJournalBytes as number) > 1_048_576) { throw new Error("invalid consumption capacity"); }
  return Object.freeze({ maxBoundaryUses, maxJournalBytes }) as HostHttpConsumptionLimits;
};

const frame = (value: object, maxBytes: number): Buffer => {
  const json = JSON.stringify(value);
  const length = Buffer.byteLength(json);
  if (length + FRAME_PREFIX_BYTES > maxBytes) { throw new Error("consumption record exceeds capacity"); }
  const bytes = Buffer.alloc(length + FRAME_PREFIX_BYTES);
  bytes.writeUInt32BE(length);
  bytes.set(createHash("sha256").update(json).digest(), 4);
  bytes.write(json, FRAME_PREFIX_BYTES);
  return bytes;
};

export const consumptionHeader = (envelope: HostHttpConsumptionEnvelope, limits: HostHttpConsumptionLimits): Buffer =>
  frame({ version: VERSION, kind: "header", envelope, limits }, MAX_FRAME_BYTES);

export const consumptionRecord = (input: Readonly<{
  sequence: number; envelopeDigest: string; previousDigest: string;
  key: ConsumptionKey; requestFingerprint: string;
}>): Buffer => frame({ version: VERSION, kind: "consume", ...input }, MAX_CONSUMPTION_BYTES);

export const consumptionTombstone = (input: Readonly<{
  disposition: "retired" | "quarantined"; envelopeDigest: string; acknowledgedUses: number; tailDigest: string;
}>): Buffer => frame({ version: VERSION, kind: "tombstone", ...input }, MAX_FRAME_BYTES);

/** Bounded cleanup inspection only. Never rebuild an executable journal from
 * these bytes, even if every checksum and envelope agrees. */
export const inspectConsumptionResidue = (bytes: Buffer, maxRecords: number): void => {
  let offset = 0;
  let count = 0;
  while (offset < bytes.length) {
    if (++count > maxRecords || bytes.length - offset < FRAME_PREFIX_BYTES) {
      throw new Error("torn consumption residue");
    }
    const length = bytes.readUInt32BE(offset);
    if (length === 0 || length + FRAME_PREFIX_BYTES > MAX_FRAME_BYTES ||
        length + FRAME_PREFIX_BYTES > bytes.length - offset) { throw new Error("invalid consumption frame"); }
    const payload = bytes.subarray(offset + FRAME_PREFIX_BYTES, offset + FRAME_PREFIX_BYTES + length);
    if (!createHash("sha256").update(payload).digest().equals(bytes.subarray(offset + 4, offset + FRAME_PREFIX_BYTES))) {
      throw new Error("corrupt consumption residue");
    }
    offset += FRAME_PREFIX_BYTES + length;
  }
  if (count === 0) { throw new Error("empty consumption residue"); }
};
