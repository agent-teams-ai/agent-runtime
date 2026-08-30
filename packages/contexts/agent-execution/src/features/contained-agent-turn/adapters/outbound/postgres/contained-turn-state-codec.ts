import { createHash } from "node:crypto";

import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(candidate => canonicalJson(candidate)).join(",")}]`;}
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {deepFreeze(nested);}
    Object.freeze(value);
  }
  return value;
};

export const encodeContainedTurnState = (operation: ContainedTurnKernelOperation): {
  readonly digest: string;
  readonly json: string;
} => {
  validateContainedTurnOperation(operation);
  const json = canonicalJson(operation);
  return Object.freeze({ digest: createHash("sha256").update(json).digest("hex"), json });
};

export const decodeContainedTurnState = (state: unknown, expectedDigest: string): ContainedTurnKernelOperation => {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("contained turn PostgreSQL state must be an object");
  }
  const operation = deepFreeze(state) as ContainedTurnKernelOperation;
  const digest = createHash("sha256").update(canonicalJson(operation)).digest("hex");
  if (digest !== expectedDigest) {throw new Error("contained turn state digest mismatch");}
  validateContainedTurnOperation(operation);
  return operation;
};
