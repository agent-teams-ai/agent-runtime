import { createHash } from "node:crypto";

import { validateContainedTurnPreventionReceipt, type ContainedTurnPreventionReceipt } from "../../../domain/contained-turn-intent-guard.js";
import { assertContainedTurnExactRecord } from "../../../domain/contained-turn-record.js";
import { canonicalContainedTurnPostgresJson } from "./contained-turn-state-codec.js";

export const CONTAINED_TURN_GUARD_MAX_BYTES = 16_384;
export const CONTAINED_TURN_GUARD_SELECTION = `CASE WHEN octet_length(state::text) <= ${String(CONTAINED_TURN_GUARD_MAX_BYTES)} THEN state END AS state,
  octet_length(state::text) <= ${String(CONTAINED_TURN_GUARD_MAX_BYTES)} AS state_within_budget,
  state_codec_version,state_digest`;

export interface ContainedTurnGuardRow {
  readonly state: unknown;
  readonly state_codec_version: number;
  readonly state_digest: string;
  readonly state_within_budget: boolean;
}

export const encodeContainedTurnIntentGuard = (receipt: ContainedTurnPreventionReceipt) => {
  const payload = validateContainedTurnPreventionReceipt(receipt);
  const json = canonicalContainedTurnPostgresJson({ codecVersion: 1, payload });
  if (Buffer.byteLength(json) > CONTAINED_TURN_GUARD_MAX_BYTES) {throw new TypeError("intent guard exceeds byte budget");}
  return Object.freeze({ codecVersion: 1, digest: createHash("sha256").update(json).digest("hex"), json });
};

export const decodeContainedTurnIntentGuard = (row: ContainedTurnGuardRow): ContainedTurnPreventionReceipt => {
  if (row.state_within_budget !== true || row.state_codec_version !== 1) {
    throw new TypeError("intent guard budget or codec version rejected");
  }
  // Validate closed, shallow structure and bounded scalar fields before serializing/hash work.
  const envelope = row.state as { codecVersion: number; payload: ContainedTurnPreventionReceipt };
  assertContainedTurnExactRecord("intent guard envelope", envelope, ["codecVersion", "payload"]);
  if (envelope.codecVersion !== 1) {throw new TypeError("intent guard envelope version rejected");}
  const encoded = encodeContainedTurnIntentGuard(envelope.payload);
  if (encoded.digest !== row.state_digest) {throw new TypeError("intent guard digest mismatch");}
  return validateContainedTurnPreventionReceipt(envelope.payload);
};
