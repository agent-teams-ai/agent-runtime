import { createHash } from "node:crypto";

import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";

export const CONTAINED_TURN_STATE_CODEC_VERSION = 2;

export const CONTAINED_TURN_POSTGRES_JSON_BUDGET = Object.freeze({
  maximumCanonicalBytes: 8 * 1024 * 1024,
  maximumCollectionWidth: 4_096,
  maximumDepth: 64,
  maximumNodes: 50_000,
  maximumSerializedBytes: 8 * 1024 * 1024,
});
export const CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC =
  "contained turn persisted state exceeds the deterministic decoding budget";

export class ContainedTurnStateBudgetError extends Error {
  public constructor() {
    super(CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC);
    this.name = "ContainedTurnStateBudgetError";
  }
}

export class ContainedTurnStateQuarantineError extends Error {
  public constructor(
    public readonly codecVersion: number,
    public readonly reason: "malformed" | "unsupported_version",
  ) {
    super(`contained turn state quarantined: ${reason} codec ${String(codecVersion)}`);
    this.name = "ContainedTurnStateQuarantineError";
  }
}

const rejectOutsideCanonicalBudget = (root: unknown): void => {
  const pending: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 0, value: root }];
  let canonicalBytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {break;}
    nodes += 1;
    if (nodes > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumNodes ||
        current.depth > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumDepth) {
      throw new ContainedTurnStateBudgetError();
    }
    if (current.value === null || typeof current.value !== "object") {
      const serialized = JSON.stringify(current.value);
      canonicalBytes += typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : 0;
      if (canonicalBytes > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCanonicalBytes) {
        throw new ContainedTurnStateBudgetError();
      }
      continue;
    }
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Readonly<Record<string, unknown>>);
    if (values.length > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCollectionWidth) {
      throw new ContainedTurnStateBudgetError();
    }
    canonicalBytes += 2 + Math.max(0, values.length - 1);
    if (!Array.isArray(current.value)) {
      for (const key of Object.keys(current.value)) {
        canonicalBytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
      }
    }
    if (canonicalBytes > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCanonicalBytes) {
      throw new ContainedTurnStateBudgetError();
    }
    for (const nested of values) {pending.push({ depth: current.depth + 1, value: nested });}
  }
};

const canonicalJson = (value: unknown): string => {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError("PostgreSQL JSON values must be JSON-compatible");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("PostgreSQL JSON numbers must be finite");
  }
  if (value === null || typeof value !== "object") {return JSON.stringify(value);}
  if (Array.isArray(value)) {
    return `[${value.map(candidate => canonicalJson(candidate)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

export const canonicalContainedTurnPostgresJson = (value: unknown): string => {
  rejectOutsideCanonicalBudget(value);
  const canonical = canonicalJson(value);
  if (Buffer.byteLength(canonical, "utf8") >
      CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCanonicalBytes) {
    throw new ContainedTurnStateBudgetError();
  }
  return canonical;
};

export const digestContainedTurnPostgresJson = (value: unknown): string =>
  createHash("sha256").update(canonicalContainedTurnPostgresJson(value)).digest("hex");

const deepFreeze = <Value>(value: Value): Value => {
  const pending: unknown[] = [value];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || typeof candidate !== "object" || visited.has(candidate)) {continue;}
    visited.add(candidate);
    pending.push(...Object.values(candidate));
  }
  for (const candidate of [...visited].reverse()) {Object.freeze(candidate);}
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
