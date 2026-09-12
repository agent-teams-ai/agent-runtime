import type { ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import { CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT } from "../../../domain/contained-turn-dispatch-preparation.js";
import { snapshotContainedTurnDispatchPreparation } from "../../../application/contained-turn-preparation-scope.js";
import { validateContainedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "../../../domain/contained-turn-limits.js";
import { assertContainedTurnCanonicalArray } from "../../../domain/contained-turn-record.js";
import {
  canonicalContainedTurnPostgresJson,
  digestContainedTurnPostgresJson,
  ContainedTurnStateQuarantineError,
} from "./contained-turn-state-codec.js";

export const CONTAINED_TURN_PREPARATION_CODEC_VERSION = 6;

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainedTurnStateQuarantineError(1, "malformed");
  }
  return value as Record<string, unknown>;
};

const rejectOversizedStoredEvidence = (state: unknown, codecVersion: number): void => {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {return;}
  const outer = state as Record<string, unknown>;
  const candidate = codecVersion === 1 ? outer : outer.payload;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {return;}
  const payload = candidate as Record<string, unknown>;
  if ((payload.kind === "cleanup_pending" || payload.kind === "cleanup_closed") &&
      Array.isArray(payload.cleanupEvidenceIds) &&
      payload.cleanupEvidenceIds.length > CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
};

const validatePreparation = (
  value: unknown,
  codecVersion: number,
): ContainedTurnDispatchPreparation => {
  try {
    const preparation = snapshotContainedTurnDispatchPreparation(
      record(value) as unknown as ContainedTurnDispatchPreparation,
    );
    for (const grantRequestId of [
      preparation.providerAccessGrantRequestId,
      preparation.runtimeSecurityGrantRequestId,
    ]) {
      if (grantRequestId !== null && !/^grant-request:sha256:[a-f0-9]{64}$/u.test(grantRequestId)) {
        throw new TypeError("dispatch preparation grant request ID is not digest-bound");
      }
    }
    return preparation;
  } catch (error) {
    if (error instanceof ContainedTurnStateQuarantineError) {throw error;}
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
};

const addConsumptionEvidenceFields = (legacy: Record<string, unknown>): Record<string, unknown> => ({
  ...legacy,
  ...(legacy.kind === "cleanup_pending" || legacy.kind === "cleanup_closed"
    ? {
      ...(legacy.kind === "cleanup_closed" ? { cleanupEvidenceIds: [] } : {}),
      providerAccessConsumptionEvidenceId: null,
      runtimeSecurityConsumptionEvidenceId: null,
    }
    : {}),
});

const validateLegacyGrantIdentities = (legacy: Record<string, unknown>): void => {
  for (const key of ["providerAccessGrantRequestId", "runtimeSecurityGrantRequestId"]) {
    if (!Object.hasOwn(legacy, key) || legacy[key] === null) {continue;}
    const value = legacy[key];
    if (typeof value !== "string") {throw new TypeError("legacy grant identity must be text");}
    validateContainedTurnText("legacy grant identity", value, CONTAINED_TURN_LIMITS.text.identifier);
  }
};

const validateLegacyConsumptionEvidence = (legacy: Record<string, unknown>): void => {
  for (const key of ["providerAccessConsumptionEvidenceId", "runtimeSecurityConsumptionEvidenceId"]) {
    if (!Object.hasOwn(legacy, key) || legacy[key] === null) {continue;}
    const value = legacy[key];
    if (typeof value !== "string") {throw new TypeError("legacy consumption evidence must be text");}
    validateContainedTurnIdentity("evidence", value);
  }
  if (!Object.hasOwn(legacy, "cleanupEvidenceIds")) {return;}
  const evidence = legacy.cleanupEvidenceIds;
  if (!Array.isArray(evidence) || evidence.length > CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT) {
    throw new TypeError("legacy cleanup evidence must be a bounded array");
  }
  assertContainedTurnCanonicalArray(evidence);
  for (const evidenceId of evidence) {validateContainedTurnIdentity("evidence", evidenceId);}
};

// Upcasting may discard valid historical claims, but must not erase corruption.
// Fields retained by the upcast still pass the complete current validator.
const validateLegacyFields = (legacy: Record<string, unknown>, codecVersion: number): void => {
  try {
    for (const key of ["custodyReleased", "providerAccessSettled", "runtimeSecuritySettled"]) {
      if (Object.hasOwn(legacy, key) && typeof legacy[key] !== "boolean") {
        throw new TypeError("legacy cleanup flags must be primitive booleans");
      }
    }
    if (codecVersion === 1) {validateLegacyGrantIdentities(legacy);}
    if (codecVersion <= 2) {validateLegacyConsumptionEvidence(legacy);}
  } catch {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
};

const recoverLegacyCleanupDebt = (legacy: Record<string, unknown>): Record<string, unknown> => legacy.kind === "cleanup_pending"
  ? {
    ...legacy,
    custodyReleased: false,
    providerAccessSettled: false,
    runtimeSecuritySettled: false,
  }
  : legacy;

const upcastV1 = (state: unknown): ContainedTurnDispatchPreparation => {
  const original = record(state);
  validateLegacyFields(original, 1);
  const legacy = recoverLegacyCleanupDebt(addConsumptionEvidenceFields({
    ...original,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
  }));
  return validatePreparation(addNegativeConsumptionFields(legacy), 1);
};

const addNegativeConsumptionFields = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload.kind === "cleanup_pending" || payload.kind === "cleanup_closed"
    ? { ...payload, providerAccessNotConsumed: false, runtimeSecurityNotConsumed: false }
    : payload;

const decodeEnvelope = (state: unknown, codecVersion: 2 | 3 | 4 | 5 | 6): ContainedTurnDispatchPreparation => {
  const envelope = record(state);
  if (Object.keys(envelope).toSorted().join(",") !== "codecVersion,payload" ||
      envelope.codecVersion !== codecVersion) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  if (codecVersion < 5) {validateLegacyFields(record(envelope.payload), codecVersion);}
  const legacyPayload = codecVersion < 5
    ? recoverLegacyCleanupDebt(codecVersion === 2
      ? addConsumptionEvidenceFields(record(envelope.payload)) : record(envelope.payload))
    : envelope.payload;
  const payload = codecVersion < 6 ? addNegativeConsumptionFields(record(legacyPayload)) : legacyPayload;
  return validatePreparation(payload, codecVersion);
};

export const encodeContainedTurnPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): Readonly<{ codecVersion: 6; digest: string; json: string }> => {
  const validated = validatePreparation(preparation, CONTAINED_TURN_PREPARATION_CODEC_VERSION);
  const envelope = Object.freeze({
    codecVersion: CONTAINED_TURN_PREPARATION_CODEC_VERSION,
    payload: validated,
  });
  return Object.freeze({
    codecVersion: CONTAINED_TURN_PREPARATION_CODEC_VERSION,
    digest: digestContainedTurnPostgresJson(envelope),
    json: canonicalContainedTurnPostgresJson(envelope),
  });
};

export const decodeContainedTurnPreparation = (
  state: unknown,
  expectedDigest: string | null,
  codecVersion: number,
): ContainedTurnDispatchPreparation => {
  if (!Number.isSafeInteger(codecVersion) || codecVersion < 1) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  if (codecVersion > CONTAINED_TURN_PREPARATION_CODEC_VERSION) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "unsupported_version");
  }
  rejectOversizedStoredEvidence(state, codecVersion);
  if (expectedDigest !== null && digestContainedTurnPostgresJson(state) !== expectedDigest) {
    throw new Error("contained turn preparation digest mismatch");
  }
  if (codecVersion === 1) {
    return upcastV1(state);
  }
  if (expectedDigest === null) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  return decodeEnvelope(state, codecVersion as 2 | 3 | 4 | 5 | 6);
};
