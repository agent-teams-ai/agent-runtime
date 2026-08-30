import type { ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import { snapshotContainedTurnDispatchPreparation } from "../../../application/contained-turn-preparation-scope.js";
import {
  canonicalContainedTurnPostgresJson,
  digestContainedTurnPostgresJson,
  ContainedTurnStateQuarantineError,
} from "./contained-turn-state-codec.js";

export const CONTAINED_TURN_PREPARATION_CODEC_VERSION = 2;

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainedTurnStateQuarantineError(1, "malformed");
  }
  return value as Record<string, unknown>;
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

const upcastV1 = (state: unknown): ContainedTurnDispatchPreparation => {
  const legacy = record(state);
  const upcast = {
    ...legacy,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
    ...(legacy.kind === "cleanup_pending"
      ? { providerAccessSettled: true, runtimeSecuritySettled: true }
      : {}),
  };
  return validatePreparation(upcast, 1);
};

export const encodeContainedTurnPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): Readonly<{ codecVersion: 2; digest: string; json: string }> => {
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
  if (expectedDigest !== null && digestContainedTurnPostgresJson(state) !== expectedDigest) {
    throw new Error("contained turn preparation digest mismatch");
  }
  if (codecVersion === 1) {
    return upcastV1(state);
  }
  if (expectedDigest === null) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  const envelope = record(state);
  if (Object.keys(envelope).toSorted().join(",") !== "codecVersion,payload" ||
      envelope.codecVersion !== CONTAINED_TURN_PREPARATION_CODEC_VERSION) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  return validatePreparation(envelope.payload, codecVersion);
};
