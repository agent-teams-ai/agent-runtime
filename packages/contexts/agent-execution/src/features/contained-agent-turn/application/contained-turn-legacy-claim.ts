import { containedTurnProviderAccessSnapshotDigest } from "../domain/contained-turn-authority.js";
import type { ContainedTurnPreparationToken } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import type { ContainedTurnKernelMutation } from "../domain/contained-turn-transitions.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

type CurrentAccess = Extract<Awaited<ReturnType<
  ContainedTurnKernelDependencies["providerAccess"]["revalidateForDispatch"]
>>, { readonly kind: "current" }>;
type CurrentSecurity = Extract<Awaited<ReturnType<
  ContainedTurnKernelDependencies["security"]["revalidateForDispatch"]
>>, { readonly kind: "current" }>;

/** Temporary proof assembly for callers not yet migrated to consumed grants. */
export const containedTurnLegacyClaimMutation = (input: Readonly<{
  access: CurrentAccess;
  custody: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>;
  initial: ContainedTurnKernelOperation;
  preparationToken: ContainedTurnPreparationToken;
  prepared: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["prepareDispatch"]>>;
  security: CurrentSecurity;
}>): Extract<ContainedTurnKernelMutation, { readonly kind: "claim_dispatch" }> => {
  const { access, custody, initial, preparationToken, prepared, security } = input;
  const operationBinding = {
    authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
    operationId: initial.operationId,
  };
  const providerAccessDispatchProof = {
    binding: {
      ...operationBinding,
      acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot),
      resolutionDigest: access.dispatchResolutionDigest,
    },
    kind: "provider_access_dispatch" as const,
    proofId: access.dispatchProofId,
  };
  const runtimeSecurityDispatchProof = {
    binding: {
      ...operationBinding,
      acceptedSecurityDecisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
      currentSecurityDecisionDigest: security.dispatchDecisionDigest,
      securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
    },
    kind: "runtime_security_dispatch" as const,
    proofId: security.proofId,
  };
  return {
    attemptId: prepared.attemptId,
    claimProof: {
      binding: {
        ...operationBinding, attemptId: prepared.attemptId, effectId: initial.effectId,
        preparationToken, providerAccessDispatchProofId: access.dispatchProofId,
        runtimeSecurityDispatchProofId: security.proofId,
      },
      kind: "dispatch_claim",
      proofId: prepared.claimProofId,
    },
    custodyId: prepared.custodyId,
    cutoffProof: { binding: operationBinding, kind: "cutoff", proofId: prepared.cutoffProofId },
    executionGenerationId: prepared.executionGenerationId,
    hostBootId: custody.hostBootId,
    hostCustodyProof: custody.hostCustodyProof,
    hostInstanceId: custody.hostInstanceId,
    kind: "claim_dispatch",
    preparationToken,
    providerAccessDispatchProof,
    runtimeSecurityDispatchProof,
    writerFence: prepared.writerFence,
  };
};
