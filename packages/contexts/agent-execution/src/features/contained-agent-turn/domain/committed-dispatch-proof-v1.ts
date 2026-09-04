import type { ContainedTurnProvider } from "./contained-turn-authority.js";
import {
  digestContainedTurnCanonicalValue,
  parseContainedTurnCanonicalDigest,
  type ContainedTurnCanonicalDigest,
  type ContainedTurnCommandFingerprint,
} from "./contained-turn-codecs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCommandId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnExecutionGenerationId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnPreparationToken,
  ContainedTurnProofId,
  ContainedTurnWorkspaceId,
} from "./contained-turn-identities.js";
import { validateContainedTurnIdentity } from "./contained-turn-identities.js";
import type { ContainedTurnDispatchGrantSubject } from "./contained-turn-dispatch-authority.js";
import { validateContainedTurnConsumedGrantReceipts } from "./contained-turn-dispatch-authority.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";
import { containedTurnOperationCutoffRevision, type ContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "./contained-turn-record.js";

export const COMMITTED_DISPATCH_PROOF_V1_PURPOSE = "contained_turn_committed_dispatch_v1" as const;

/** Typed evidence handoff from the sole acknowledged committed dispatch claim to Host Custody. */
export interface CommittedDispatchProofV1 {
  readonly acceptedAuthorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly admissionCutoffProofId: ContainedTurnProofId;
  readonly attemptId: ContainedTurnAttemptId;
  readonly commandFingerprint: ContainedTurnCommandFingerprint;
  readonly commandId: ContainedTurnCommandId;
  readonly committedOperationRevision: number;
  readonly custodyId: ContainedTurnCustodyId;
  readonly dispatchClaimProofId: ContainedTurnProofId;
  readonly effectId: ContainedTurnEffectId;
  readonly executionGenerationId: ContainedTurnExecutionGenerationId;
  readonly hostBootId: ContainedTurnHostBootId;
  readonly hostCustodyProofId: ContainedTurnProofId;
  readonly hostInstanceId: ContainedTurnHostInstanceId;
  readonly operationCutoffRevision: ContainedTurnOperationCutoffRevision;
  readonly operationId: ContainedTurnOperationId;
  readonly preparationToken: ContainedTurnPreparationToken;
  readonly projectId: string;
  readonly proofDigest: ContainedTurnCanonicalDigest;
  readonly provider: ContainedTurnProvider;
  readonly providerAccessDispatchProofId: ContainedTurnProofId;
  readonly providerAccessGrantReceiptDigest: ContainedTurnCanonicalDigest;
  readonly purpose: typeof COMMITTED_DISPATCH_PROOF_V1_PURPOSE;
  readonly runtimeSecurityDispatchProofId: ContainedTurnProofId;
  readonly runtimeSecurityGrantReceiptDigest: ContainedTurnCanonicalDigest;
  readonly tenantId: string;
  readonly version: 1;
  readonly workspaceId: ContainedTurnWorkspaceId;
}

export type CommittedDispatchProofV1Seed = Omit<CommittedDispatchProofV1, "proofDigest">;

const KEYS = Object.freeze([
  "acceptedAuthorityVectorDigest", "admissionCutoffProofId", "attemptId", "commandFingerprint",
  "commandId", "committedOperationRevision", "custodyId", "dispatchClaimProofId", "effectId",
  "executionGenerationId", "hostBootId", "hostCustodyProofId", "hostInstanceId",
  "operationCutoffRevision", "operationId", "preparationToken", "projectId", "proofDigest", "provider",
  "providerAccessDispatchProofId", "providerAccessGrantReceiptDigest", "purpose",
  "runtimeSecurityDispatchProofId", "runtimeSecurityGrantReceiptDigest", "tenantId", "version", "workspaceId",
] as const satisfies readonly (keyof CommittedDispatchProofV1)[]);

const proofFields = (proof: CommittedDispatchProofV1 | CommittedDispatchProofV1Seed) => {
  const { proofDigest: _proofDigest, ...fields } = proof as CommittedDispatchProofV1;
  return fields;
};

/** Version and purpose form an explicit domain envelope around every preceding proof field. */
export const digestCommittedDispatchProofV1 = (
  proof: CommittedDispatchProofV1 | CommittedDispatchProofV1Seed,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue({
  domain: { purpose: COMMITTED_DISPATCH_PROOF_V1_PURPOSE, version: 1 },
  fields: proofFields(proof),
} as never);

const validateText = (name: string, value: string): string => {
  validateContainedTurnText(name, value, CONTAINED_TURN_LIMITS.text.identifier);
  return value;
};

/** Validates the closed record and returns a recursively detached immutable copy. */
export const validateCommittedDispatchProofV1 = (value: unknown): CommittedDispatchProofV1 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("committed dispatch proof must be an exact record");
  }
  assertContainedTurnExactRecord("committed dispatch proof", value, KEYS);
  const proof = value as CommittedDispatchProofV1;
  if (proof.version !== 1 || proof.purpose !== COMMITTED_DISPATCH_PROOF_V1_PURPOSE ||
      !Number.isSafeInteger(proof.committedOperationRevision) ||
      Object.is(proof.committedOperationRevision, -0) || proof.committedOperationRevision < 1) {
    throw new TypeError("committed dispatch proof domain or committed operation revision is invalid");
  }
  containedTurnOperationCutoffRevision(proof.operationCutoffRevision);
  if (Object.is(proof.operationCutoffRevision, -0)) {
    throw new TypeError("committed dispatch proof operation cutoff revision is invalid");
  }
  validateContainedTurnIdentity("attempt", proof.attemptId);
  validateContainedTurnIdentity("command", proof.commandId);
  validateContainedTurnIdentity("custody", proof.custodyId);
  validateContainedTurnIdentity("effect", proof.effectId);
  validateContainedTurnIdentity("execution_generation", proof.executionGenerationId);
  validateContainedTurnIdentity("host_boot", proof.hostBootId);
  validateContainedTurnIdentity("host_instance", proof.hostInstanceId);
  validateContainedTurnIdentity("operation", proof.operationId);
  validateContainedTurnIdentity("preparation", proof.preparationToken);
  validateContainedTurnIdentity("proof", proof.admissionCutoffProofId);
  validateContainedTurnIdentity("proof", proof.dispatchClaimProofId);
  validateContainedTurnIdentity("proof", proof.hostCustodyProofId);
  validateContainedTurnIdentity("proof", proof.providerAccessDispatchProofId);
  validateContainedTurnIdentity("proof", proof.runtimeSecurityDispatchProofId);
  validateContainedTurnIdentity("workspace", proof.workspaceId);
  validateText("project identity", proof.projectId);
  validateText("provider identity", proof.provider);
  validateText("tenant identity", proof.tenantId);
  parseContainedTurnCanonicalDigest(proof.acceptedAuthorityVectorDigest);
  parseContainedTurnCanonicalDigest(proof.commandFingerprint);
  parseContainedTurnCanonicalDigest(proof.providerAccessGrantReceiptDigest);
  parseContainedTurnCanonicalDigest(proof.runtimeSecurityGrantReceiptDigest);
  parseContainedTurnCanonicalDigest(proof.proofDigest);
  if (proof.proofDigest !== digestCommittedDispatchProofV1(proof)) {
    throw new TypeError("committed dispatch proof digest does not match its exact fields");
  }
  return detachAndFreezeContainedTurnValue(proof);
};

export const committedDispatchProofV1 = (
  seed: CommittedDispatchProofV1Seed,
): CommittedDispatchProofV1 => validateCommittedDispatchProofV1({
  ...seed,
  proofDigest: digestCommittedDispatchProofV1(seed),
});

const oneProof = <Kind extends ContainedTurnProof["kind"]>(
  operation: ContainedTurnKernelOperation,
  proofId: ContainedTurnProofId,
  kind: Kind,
): Extract<ContainedTurnProof, { readonly kind: Kind }> => {
  const matches = operation.proofs.filter(proof => proof.proofId === proofId && proof.kind === kind);
  if (matches.length !== 1) {throw new TypeError(`committed dispatch requires one matching ${kind} proof`);}
  return matches[0] as Extract<ContainedTurnProof, { readonly kind: Kind }>;
};

/** Cross-binds an owner outcome's handoff to its detached committed operation and durable receipt order. */
export const validateCommittedDispatchClaimV1 = (
  value: unknown,
  operation: ContainedTurnKernelOperation,
  subject: ContainedTurnDispatchGrantSubject,
  openedHostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>,
): CommittedDispatchProofV1 => {
  const proof = validateCommittedDispatchProofV1(value);
  if (operation.dispatch.kind !== "claimed" || operation.admissionFence.kind !== "fenced" ||
      operation.custodyId === undefined || operation.hostBootId === undefined ||
      operation.hostInstanceId === undefined || operation.workspaceId === undefined) {
    throw new TypeError("committed dispatch proof requires one complete claimed operation");
  }
  const receipts = validateContainedTurnConsumedGrantReceipts(subject, operation.dispatch.grantReceipts);
  const providerReceiptDigest = digestContainedTurnCanonicalValue(receipts[0] as never);
  const securityReceiptDigest = digestContainedTurnCanonicalValue(receipts[1] as never);
  const claim = oneProof(operation, operation.dispatch.claimProofId, "dispatch_claim");
  const cutoff = oneProof(operation, operation.admissionFence.proofId, "cutoff");
  const host = oneProof(operation, proof.hostCustodyProofId, "host_custody");
  const providerAccess = oneProof(operation, operation.dispatch.providerAccessDispatchProofId, "provider_access_dispatch");
  const runtimeSecurity = oneProof(operation, operation.dispatch.runtimeSecurityDispatchProofId, "runtime_security_dispatch");
  const expected = committedDispatchProofV1({
    acceptedAuthorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    admissionCutoffProofId: cutoff.proofId,
    attemptId: operation.dispatch.attemptId,
    commandFingerprint: operation.commandFingerprint,
    commandId: operation.commandId,
    committedOperationRevision: operation.revision,
    custodyId: operation.custodyId,
    dispatchClaimProofId: claim.proofId,
    effectId: operation.effectId,
    executionGenerationId: operation.dispatch.executionGenerationId,
    hostBootId: operation.hostBootId,
    hostCustodyProofId: host.proofId,
    hostInstanceId: operation.hostInstanceId,
    operationCutoffRevision: operation.dispatch.operationCutoffRevision,
    operationId: operation.operationId,
    preparationToken: operation.dispatch.preparationToken,
    projectId: operation.scope.projectId,
    provider: operation.adapterSnapshot.provider,
    providerAccessDispatchProofId: providerAccess.proofId,
    providerAccessGrantReceiptDigest: providerReceiptDigest,
    purpose: COMMITTED_DISPATCH_PROOF_V1_PURPOSE,
    runtimeSecurityDispatchProofId: runtimeSecurity.proofId,
    runtimeSecurityGrantReceiptDigest: securityReceiptDigest,
    tenantId: operation.scope.tenantId,
    version: 1,
    workspaceId: operation.workspaceId,
  });
  const relationshipsMatch =
    claim.binding.providerAccessDispatchProofId === providerAccess.proofId &&
    claim.binding.runtimeSecurityDispatchProofId === runtimeSecurity.proofId &&
    providerAccess.binding.resolutionDigest === providerReceiptDigest &&
    runtimeSecurity.binding.currentSecurityDecisionDigest === securityReceiptDigest &&
    digestContainedTurnCanonicalValue(host as never) === digestContainedTurnCanonicalValue(openedHostCustodyProof as never);
  if (proof.proofDigest !== expected.proofDigest || !relationshipsMatch) {
    throw new TypeError("committed dispatch proof conflicts with its operation, proofs, or ordered receipts");
  }
  return proof;
};
