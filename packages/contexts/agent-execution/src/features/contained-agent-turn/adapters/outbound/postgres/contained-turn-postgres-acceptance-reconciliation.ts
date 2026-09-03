import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";

/**
 * Complete write-once acceptance projection. Later lifecycle state is excluded,
 * while the original acceptance proofs are retained to bind identity and state.
 */
export const containedTurnPostgresAcceptanceFingerprint = (
  operation: ContainedTurnKernelOperation,
): string => digestContainedTurnCanonicalValue({
  acceptedAuthorityVector: operation.acceptedAuthorityVector,
  acceptedAuthorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  acceptanceProofs: operation.proofs.slice(0, 3),
  adapterSnapshot: operation.adapterSnapshot,
  capabilityManifest: operation.capabilityManifest,
  commandFingerprint: operation.commandFingerprint,
  commandId: operation.commandId,
  effectId: operation.effectId,
  intent: operation.intent,
  operationId: operation.operationId,
  providerAccessSnapshot: operation.providerAccessSnapshot,
  requiredReceiptSet: operation.requiredReceiptSet,
  requiredReceiptSetDigest: operation.requiredReceiptSetDigest,
  schemaVersion: operation.schemaVersion,
  scope: operation.scope,
} as never);

export const containedTurnPostgresAcceptanceMatches = (
  left: ContainedTurnKernelOperation,
  right: ContainedTurnKernelOperation,
): boolean => containedTurnPostgresAcceptanceFingerprint(left) ===
  containedTurnPostgresAcceptanceFingerprint(right);
