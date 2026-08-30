import { createHash } from "node:crypto";

import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";

export const CONTAINED_TURN_STATE_CODEC_VERSION = 2;

export class ContainedTurnStateQuarantineError extends Error {
  public constructor(
    public readonly codecVersion: number,
    public readonly reason: "malformed" | "unsupported_version",
  ) {
    super(`contained turn state quarantined: ${reason} codec ${String(codecVersion)}`);
    this.name = "ContainedTurnStateQuarantineError";
  }
}

export const canonicalContainedTurnPostgresJson = (value: unknown): string => {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError("PostgreSQL JSON values must be JSON-compatible");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("PostgreSQL JSON numbers must be finite");
  }
  if (value === null || typeof value !== "object") {return JSON.stringify(value);}
  if (Array.isArray(value)) {
    return `[${value.map(candidate => canonicalContainedTurnPostgresJson(candidate)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map(key =>
    `${JSON.stringify(key)}:${canonicalContainedTurnPostgresJson(record[key])}`).join(",")}}`;
};

export const digestContainedTurnPostgresJson = (value: unknown): string =>
  createHash("sha256").update(canonicalContainedTurnPostgresJson(value)).digest("hex");

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {deepFreeze(nested);}
    Object.freeze(value);
  }
  return value;
};

const objectRecord = (value: unknown, codecVersion: number): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainedTurnStateQuarantineError(codecVersion, "malformed");
  }
  return value as Record<string, unknown>;
};

const upcastV1 = (state: unknown): ContainedTurnKernelOperation => {
  const operation = objectRecord(state, 1);
  if (operation.schemaVersion !== 1 && operation.schemaVersion !== 2) {
    throw new ContainedTurnStateQuarantineError(1, "malformed");
  }
  return { ...operation, schemaVersion: 2 } as unknown as ContainedTurnKernelOperation;
};

const decodeV2 = (state: unknown): ContainedTurnKernelOperation => {
  const envelope = objectRecord(state, 2);
  if (Object.keys(envelope).toSorted().join(",") !== "codecVersion,payload" ||
      envelope.codecVersion !== 2) {
    throw new ContainedTurnStateQuarantineError(2, "malformed");
  }
  const payload = objectRecord(envelope.payload, 2);
  if (payload.schemaVersion !== 2) {
    throw new ContainedTurnStateQuarantineError(2, "malformed");
  }
  return payload as unknown as ContainedTurnKernelOperation;
};

export interface EncodedContainedTurnState {
  readonly codecVersion: typeof CONTAINED_TURN_STATE_CODEC_VERSION;
  readonly digest: string;
  readonly json: string;
}

export const encodeContainedTurnState = (
  operation: ContainedTurnKernelOperation,
): EncodedContainedTurnState => {
  validateContainedTurnOperation(operation);
  if (operation.schemaVersion !== 2) {
    throw new TypeError("new contained turn PostgreSQL state must use schema version 2");
  }
  const envelope = Object.freeze({
    codecVersion: CONTAINED_TURN_STATE_CODEC_VERSION,
    payload: operation,
  });
  const json = canonicalContainedTurnPostgresJson(envelope);
  return Object.freeze({
    codecVersion: CONTAINED_TURN_STATE_CODEC_VERSION,
    digest: createHash("sha256").update(json).digest("hex"),
    json,
  });
};

export const decodeContainedTurnState = (
  state: unknown,
  expectedDigest: string,
  persistedCodecVersion?: number,
): ContainedTurnKernelOperation => {
  const inferredVersion = persistedCodecVersion ??
    (state !== null && typeof state === "object" && !Array.isArray(state) &&
      "codecVersion" in state ? Number(state.codecVersion) : 1);
  if (!Number.isSafeInteger(inferredVersion) || inferredVersion < 1) {
    throw new ContainedTurnStateQuarantineError(inferredVersion, "malformed");
  }
  if (inferredVersion > CONTAINED_TURN_STATE_CODEC_VERSION) {
    throw new ContainedTurnStateQuarantineError(inferredVersion, "unsupported_version");
  }
  if (digestContainedTurnPostgresJson(state) !== expectedDigest) {
    throw new Error("contained turn state digest mismatch");
  }
  const operation = deepFreeze(inferredVersion === 1 ? upcastV1(state) : decodeV2(state));
  validateContainedTurnOperation(operation);
  return operation;
};
