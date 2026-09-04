import { committedDispatchProofV1, type CommittedDispatchProofV1Seed } from "../../../../dist/features/contained-agent-turn/domain/committed-dispatch-proof-v1.js";
import { asContainedTurnCommandFingerprint, digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelCustodyPort } from "../../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import type { ContainedTurnKernelOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import type { ContainedTurnDispatchGrantSubject, ContainedTurnConsumedGrantReceipts } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnProof } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";

const digest = (owner: string) => digestContainedTurnCanonicalValue({ owner, synthetic: true });

export const committedDispatchProofFixture = (
  open: Parameters<ContainedTurnKernelCustodyPort["open"]>[0],
  outcome: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>,
  overrides: Partial<CommittedDispatchProofV1Seed> = {},
) => {
  return committedDispatchProofV1({
    acceptedAuthorityVectorDigest: open.authorityVectorDigest,
    admissionCutoffProofId: containedTurnIdentity("proof", "proof:synthetic-admission-cutoff"),
    attemptId: open.attemptId,
    commandFingerprint: asContainedTurnCommandFingerprint(digest("command-fingerprint")),
    commandId: open.commandId,
    committedOperationRevision: open.operationRevision,
    custodyId: open.custodyId,
    dispatchClaimProofId: containedTurnIdentity("proof", "proof:synthetic-dispatch-claim"),
    effectId: open.effectId,
    executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:synthetic"),
    hostBootId: outcome.hostBootId,
    hostCustodyProofId: outcome.hostCustodyProof.proofId,
    hostInstanceId: outcome.hostInstanceId,
    operationCutoffRevision: open.operationCutoffRevision,
    operationId: open.operationId,
    preparationToken: open.preparationToken,
    projectId: open.providerAccessSnapshot.projectId,
    provider: open.adapterSnapshot.provider,
    providerAccessDispatchProofId: containedTurnIdentity("proof", "proof:synthetic-provider-access-dispatch"),
    providerAccessGrantReceiptDigest: digest("provider-access-receipt"),
    purpose: "contained_turn_committed_dispatch_v1",
    runtimeSecurityDispatchProofId: containedTurnIdentity("proof", "proof:synthetic-runtime-security-dispatch"),
    runtimeSecurityGrantReceiptDigest: digest("runtime-security-receipt"),
    tenantId: open.providerAccessSnapshot.tenantId,
    version: 1,
    workspaceId: open.workspaceId,
    ...overrides,
  });
};

export const committedDispatchProofForClaim = (
  operation: ContainedTurnKernelOperation,
  subject: ContainedTurnDispatchGrantSubject,
  hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>,
  receipts: ContainedTurnConsumedGrantReceipts,
) => {
  if (operation.dispatch.kind !== "claimed") {throw new TypeError("claim proof fixture requires a claimed operation");}
  if (operation.admissionFence.kind !== "fenced") {throw new TypeError("claim proof fixture requires an admission cutoff");}
  return committedDispatchProofV1({
    acceptedAuthorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    admissionCutoffProofId: operation.admissionFence.proofId,
    attemptId: operation.dispatch.attemptId, commandFingerprint: operation.commandFingerprint,
    commandId: operation.commandId, committedOperationRevision: operation.revision,
    custodyId: subject.custodyId, effectId: operation.effectId, hostBootId: subject.hostBootId,
    dispatchClaimProofId: operation.dispatch.claimProofId,
    executionGenerationId: operation.dispatch.executionGenerationId,
    hostCustodyProofId: hostCustodyProof.proofId, hostInstanceId: subject.hostInstanceId,
    operationCutoffRevision: operation.dispatch.operationCutoffRevision, operationId: operation.operationId,
    preparationToken: subject.preparationToken, projectId: subject.scope.projectId,
    provider: subject.provider, providerAccessDispatchProofId: operation.dispatch.providerAccessDispatchProofId,
    providerAccessGrantReceiptDigest: digestContainedTurnCanonicalValue(receipts[0] as never),
    purpose: "contained_turn_committed_dispatch_v1",
    runtimeSecurityDispatchProofId: operation.dispatch.runtimeSecurityDispatchProofId,
    runtimeSecurityGrantReceiptDigest: digestContainedTurnCanonicalValue(receipts[1] as never),
    tenantId: subject.scope.tenantId, version: 1, workspaceId: subject.workspaceId,
  });
};
