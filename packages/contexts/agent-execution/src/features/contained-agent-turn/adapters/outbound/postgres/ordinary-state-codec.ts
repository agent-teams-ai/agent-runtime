import {digestContainedTurnCanonicalValue, type ContainedTurnCanonicalValue} from "../../../domain/contained-turn-codecs.js";
import {ORDINARY_PROFILE, type OrdinaryOperation} from "../../../domain/ordinary-model.js";
import {validateOrdinaryOperation} from "../../../domain/ordinary-validation.js";
import {assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue} from "../../../domain/contained-turn-record.js";
const canonical = (value: unknown): ContainedTurnCanonicalValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {return value;}
  if (Array.isArray(value)) {return value.map(canonical);}
  if (typeof value !== "object" || value === null) {throw new TypeError("noncanonical ordinary data");}
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]));
};
export const ORDINARY_STATE_CODEC_VERSION = 3;
export const encodeOrdinaryState = (operation: OrdinaryOperation): string => {
  validateOrdinaryOperation(operation);
  const payload = detachAndFreezeContainedTurnValue(operation);
  return JSON.stringify({codecVersion: 3, schemaVersion: 3, ...ORDINARY_PROFILE, payload, digest: digestContainedTurnCanonicalValue(canonical(payload))});
};
export const decodeOrdinaryState = (serialized: unknown): OrdinaryOperation => {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {throw new TypeError("ordinary state budget or encoding invalid");}
  const value: unknown = JSON.parse(serialized);
  if (value === null || typeof value !== "object") {throw new TypeError("ordinary envelope invalid");}
  assertContainedTurnExactRecord("ordinary envelope", value, ["codecVersion", "schemaVersion", "executionProfile", "effectClass", "capabilityManifestRevision", "payload", "digest"]);
  const envelope = value as Record<string, unknown>;
  if (envelope.codecVersion !== 3 || envelope.schemaVersion !== 3 || envelope.executionProfile !== ORDINARY_PROFILE.executionProfile || envelope.effectClass !== ORDINARY_PROFILE.effectClass || envelope.capabilityManifestRevision !== ORDINARY_PROFILE.capabilityManifestRevision) {throw new TypeError("ordinary envelope profile invalid");}
  validateOrdinaryOperation(envelope.payload);
  if (envelope.digest !== digestContainedTurnCanonicalValue(canonical(envelope.payload))) {throw new TypeError("ordinary state digest mismatch");}
  return detachAndFreezeContainedTurnValue(envelope.payload);
};
