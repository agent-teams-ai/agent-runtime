import type { ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import { CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT } from "../../../domain/contained-turn-dispatch-preparation.js";
import { snapshotContainedTurnDispatchPreparation } from "../../../application/contained-turn-preparation-scope.js";
import {
  canonicalContainedTurnPostgresJson,
  digestContainedTurnPostgresJson,
  ContainedTurnStateQuarantineError,
} from "./contained-turn-state-codec.js";

export const CONTAINED_TURN_PREPARATION_CODEC_VERSION = 3;

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

const recoverLegacyCleanupDebt = (legacy: Record<string, unknown>): Record<string, unknown> => legacy.kind === "cleanup_pending"
  ? {
    ...legacy,
    custodyReleased: false,
    providerAccessSettled: legacy.providerAccessGrantRequestId === null,
    runtimeSecuritySettled: legacy.runtimeSecurityGrantRequestId === null,
  }
  : legacy;

const upcastV1 = (state: unknown): ContainedTurnDispatchPreparation => {
  const legacy = recoverLegacyCleanupDebt(addConsumptionEvidenceFields({
    ...record(state),
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
  }));
  return validatePreparation({
    ...legacy,
  }, 1);
};

const decodeEnvelope = (state: unknown, codecVersion: 2 | 3): ContainedTurnDispatchPreparation => {
  const envelope = record(state);
  if (Object.keys(envelope).toSorted().join(",") !== "codecVersion,payload" ||
      envelope.codecVersion !== codecVersion) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  const payload = codecVersion === 2
    ? recoverLegacyCleanupDebt(addConsumptionEvidenceFields(record(envelope.payload)))
    : envelope.payload;
  return validatePreparation(payload, codecVersion);
};

export const encodeContainedTurnPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): Readonly<{ codecVersion: 3; digest: string; json: string }> => {
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
  return decodeEnvelope(state, codecVersion as 2 | 3);
};
