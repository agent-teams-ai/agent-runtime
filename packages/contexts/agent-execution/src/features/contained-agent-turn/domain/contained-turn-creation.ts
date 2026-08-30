import {
  containedTurnAuthorityVectorDigest,
  containedTurnCommandFingerprint,
  type ContainedTurnAuthorityVector,
  type ContainedTurnCapabilityManifest,
  type ContainedTurnIntent,
  type ContainedTurnProviderAccessSnapshot,
  type ContainedTurnProviderAdapterSnapshot,
  type ContainedTurnScope,
} from "./contained-turn-authority.js";
import type {
  ContainedTurnCommandId,
  ContainedTurnEffectId,
  ContainedTurnOperationId,
} from "./contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import type { ContainedTurnSchemaVersion } from "./contained-turn-limits.js";
import { containedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";
import {
  assertContainedTurnExactRecord,
  detachAndFreezeContainedTurnValue,
} from "./contained-turn-record.js";
import { createContainedTurnRequiredReceiptSnapshot } from "./contained-turn-required-receipts.js";
import { validateContainedTurnOperation } from "./contained-turn-validation.js";

export interface CreateContainedTurnOperationInput {
  readonly acceptanceProof: Extract<ContainedTurnProof, { readonly kind: "acceptance" }>;
  readonly providerAccessAcceptanceProof: Extract<ContainedTurnProof, { readonly kind: "provider_access_acceptance" }>;
  readonly runtimeSecurityAcceptanceProof: Extract<ContainedTurnProof, { readonly kind: "runtime_security_acceptance" }>;
  readonly acceptedAuthorityVector: ContainedTurnAuthorityVector;
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly capabilityManifest: ContainedTurnCapabilityManifest;
  readonly commandId: ContainedTurnCommandId;
  readonly effectId: ContainedTurnEffectId;
  readonly intent: ContainedTurnIntent;
  readonly operationId: ContainedTurnOperationId;
  readonly providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
  readonly schemaVersion: ContainedTurnSchemaVersion;
  readonly scope: ContainedTurnScope;
}

export const createContainedTurnOperation = (
  input: CreateContainedTurnOperationInput,
): ContainedTurnKernelOperation => {
  assertContainedTurnExactRecord("contained-turn acceptance input", input, [
    "acceptanceProof", "acceptedAuthorityVector", "adapterSnapshot", "capabilityManifest", "commandId",
    "effectId", "intent", "operationId", "providerAccessAcceptanceProof", "providerAccessSnapshot",
    "runtimeSecurityAcceptanceProof", "schemaVersion", "scope",
  ]);
  const detached = detachAndFreezeContainedTurnValue(input);
  const requiredReceipts = createContainedTurnRequiredReceiptSnapshot();
  const operation: ContainedTurnKernelOperation = {
    acceptedAuthorityVector: detached.acceptedAuthorityVector,
    acceptedAuthorityVectorDigest: containedTurnAuthorityVectorDigest(detached.acceptedAuthorityVector),
    adapterSnapshot: detached.adapterSnapshot,
    admissionFence: Object.freeze({ kind: "open" }),
    cancellation: Object.freeze({ kind: "open" }),
    capabilityManifest: detached.capabilityManifest,
    commandFingerprint: containedTurnCommandFingerprint({ intent: detached.intent, provider: detached.adapterSnapshot.provider, scope: detached.scope }),
    commandId: detached.commandId,
    containment: Object.freeze({ kind: "not_requested" }),
    dispatch: Object.freeze({ kind: "unclaimed" }),
    effect: Object.freeze({ kind: "unresolved" }),
    effectId: detached.effectId,
    intent: detached.intent,
    operationId: detached.operationId,
    operationCutoff: Object.freeze({ kind: "open", revision: containedTurnOperationCutoffRevision(0) }),
    output: Object.freeze({ chunks: Object.freeze([]), fence: Object.freeze({ kind: "open" }) }),
    proofs: Object.freeze([detached.acceptanceProof, detached.providerAccessAcceptanceProof, detached.runtimeSecurityAcceptanceProof]),
    physicalContainment: Object.freeze({ kind: "not_requested" }),
    providerAccessSnapshot: detached.providerAccessSnapshot,
    providerProcessStart: Object.freeze({ kind: "unobserved" }),
    providerAcceptance: Object.freeze({ kind: "unobserved" }),
    providerExecution: Object.freeze({ kind: "not_started" }),
    reconciliation: Object.freeze({ kind: "clear" }),
    requiredReceiptSet: requiredReceipts.set,
    requiredReceiptSetDigest: requiredReceipts.digest,
    revision: 0,
    schemaVersion: detached.schemaVersion,
    scope: detached.scope,
    terminal: Object.freeze({ kind: "open" }),
  };
  validateContainedTurnOperation(operation);
  return detachAndFreezeContainedTurnValue(operation);
};
