import { validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import { containedTurnProviderAccessSnapshotDigest, containedTurnScopeDigest, type ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { completeContainedTurnDispatchGrantSubject, type ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";
import { validateContainedTurnOperation } from "../domain/contained-turn-validation.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import { containedTurnAcceptanceConstraintsDigestV1, containedTurnAcceptanceIntentDigestV1 } from "./contained-turn-acceptance-digests.js";

export type ContainedTurnAcceptedAuthorityHandoff = Readonly<{
  operationId: ContainedTurnKernelOperation["operationId"];
  scope: ContainedTurnScope;
  acceptanceProof: Extract<ContainedTurnKernelOperation["proofs"][number], { readonly kind: "acceptance" }>;
  acceptedAuthorityVector: ContainedTurnKernelOperation["acceptedAuthorityVector"];
  acceptedAuthorityVectorDigest: ContainedTurnKernelOperation["acceptedAuthorityVectorDigest"];
  intent: ContainedTurnKernelOperation["intent"];
  constraints: Pick<ContainedTurnKernelOperation, "adapterSnapshot" | "capabilityManifest"> & Readonly<{ intentMode: ContainedTurnKernelOperation["intent"]["mode"] }>;
  intentDigest: ReturnType<typeof containedTurnAcceptanceIntentDigestV1>;
  constraintsDigest: ReturnType<typeof containedTurnAcceptanceConstraintsDigestV1>;
}>;

export const prepareContainedTurnAcceptedSubject = (
  operation: ContainedTurnKernelOperation & { readonly workspaceId: NonNullable<ContainedTurnKernelOperation["workspaceId"]> },
  trustedScope: ContainedTurnScope,
  subject: Pick<ContainedTurnDispatchGrantSubject, "attemptId" | "custodyId" | "executionGenerationId" | "hostBootId" | "hostInstanceId" | "preparationToken">,
): ContainedTurnDispatchGrantSubject => {
  const providerAccess = operation.providerAccessSnapshot;
  const providerBindingDigest = containedTurnProviderAccessSnapshotDigest(providerAccess);
  return completeContainedTurnDispatchGrantSubject(Object.freeze({
    attemptId: subject.attemptId, custodyId: subject.custodyId, effectId: operation.effectId,
    executionGenerationId: subject.executionGenerationId, hostBootId: subject.hostBootId,
    hostInstanceId: subject.hostInstanceId, operationCutoffRevision: operation.operationCutoff.revision,
    operationId: operation.operationId, preparationToken: subject.preparationToken, provider: operation.adapterSnapshot.provider,
    providerAccessExpectation: Object.freeze({
      acceptedAuthorityDigest: operation.acceptedAuthorityVectorDigest, accessRef: providerAccess.accessRef,
      authorityHeadDigest: providerAccess.ownerAuthorityDigest, bindingDigest: providerBindingDigest,
      bindingRevision: providerAccess.revision, credentialBindingDigest: providerAccess.credentialBindingDigest,
      credentialBindingRef: providerAccess.credentialBindingRef, credentialGeneration: providerAccess.credentialGeneration,
      providerAccountRef: providerAccess.providerAccountRef, providerRouteRef: providerAccess.providerRouteRef,
    }),
    purpose: "contained_turn_provider_start_v1",
    runtimeSecurityExpectation: Object.freeze({
      acceptedAuthorityDigest: operation.acceptedAuthorityVector.securityDecisionDigest,
      authorityGeneration: operation.acceptedAuthorityVector.operationAuthorityRevision,
      authorityHeadDigest: operation.acceptedAuthorityVector.securityDecisionDigest,
      authorityRevision: operation.acceptedAuthorityVector.securityAuthorityRevision,
      constraintsDigest: containedTurnAcceptanceConstraintsDigestV1(operation),
      containmentPolicyDigest: operation.acceptedAuthorityVector.containmentPolicyDigest,
      providerBindingDigest, providerId: operation.adapterSnapshot.provider,
    }),
    scope: trustedScope, scopeDigest: containedTurnScopeDigest(trustedScope), workspaceId: operation.workspaceId,
  }));
};

/** Private acknowledged-owner path only. This projection is not standalone database commit proof. */
export const createContainedTurnAcceptedAuthorityHandoff = (
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  subject: ContainedTurnDispatchGrantSubject,
): ContainedTurnAcceptedAuthorityHandoff => {
  // Validate inside the caught handoff path so malformed custody still retires
  // through the existing preparation authority before any owner consumes.
  validateContainedTurnIdentity("attempt", subject.attemptId);
  validateContainedTurnIdentity("custody", subject.custodyId);
  validateContainedTurnIdentity("execution_generation", subject.executionGenerationId);
  validateContainedTurnIdentity("host_boot", subject.hostBootId);
  validateContainedTurnIdentity("host_instance", subject.hostInstanceId);
  validateContainedTurnIdentity("preparation", subject.preparationToken);
  validateContainedTurnOperation(operation);
  containedTurnOwnerStoreAuthority(operation, trustedScope);
  const acceptanceProof = operation.proofs.find(proof => proof.kind === "acceptance");
  if (acceptanceProof === undefined || operation.workspaceId === undefined) {
    throw new TypeError("accepted authority handoff requires acceptance and workspace");
  }
  const expected = prepareContainedTurnAcceptedSubject({ ...operation, workspaceId: operation.workspaceId }, trustedScope, subject);
  if (digestContainedTurnCanonicalValue(expected as never) !== digestContainedTurnCanonicalValue(subject as never)) {
    throw new TypeError("accepted authority handoff subject or owner request mismatch");
  }
  return detachAndFreezeContainedTurnValue({
    operationId: operation.operationId, scope: operation.scope, acceptanceProof,
    acceptedAuthorityVector: operation.acceptedAuthorityVector,
    acceptedAuthorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    intent: operation.intent,
    constraints: { adapterSnapshot: operation.adapterSnapshot, capabilityManifest: operation.capabilityManifest, intentMode: operation.intent.mode },
    intentDigest: containedTurnAcceptanceIntentDigestV1(operation.intent),
    constraintsDigest: containedTurnAcceptanceConstraintsDigestV1(operation),
  });
};
