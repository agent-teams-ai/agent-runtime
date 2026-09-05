import { containedTurnProviderAccessSnapshotDigest, containedTurnScopeDigest } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { completeContainedTurnDispatchGrantSubject } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnKernelOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import {
  attemptId, createOperation, custodyId, effectId, executionGenerationId, hostBootId,
  hostInstanceId, operationId, preparationToken, scope, workspaceId,
} from "../../../contained-turn-kernel-fixtures.ts";

export const grantSubject = (operation: ContainedTurnKernelOperation = createOperation()) => {
  const providerAccess = operation.providerAccessSnapshot;
  const providerBindingDigest = containedTurnProviderAccessSnapshotDigest(providerAccess);
  return completeContainedTurnDispatchGrantSubject({
    attemptId, custodyId, effectId, executionGenerationId, hostBootId, hostInstanceId,
    operationCutoffRevision: operation.operationCutoff.revision, operationId, preparationToken,
    provider: operation.adapterSnapshot.provider,
    providerAccessExpectation: {
      acceptedAuthorityDigest: operation.acceptedAuthorityVectorDigest, accessRef: providerAccess.accessRef,
      authorityHeadDigest: providerAccess.ownerAuthorityDigest, bindingDigest: providerBindingDigest,
      bindingRevision: providerAccess.revision, credentialBindingDigest: providerAccess.credentialBindingDigest,
      credentialBindingRef: providerAccess.credentialBindingRef, credentialGeneration: providerAccess.credentialGeneration,
      providerAccountRef: providerAccess.providerAccountRef, providerRouteRef: providerAccess.providerRouteRef,
    },
    purpose: "contained_turn_provider_start_v1",
    runtimeSecurityExpectation: {
      acceptedAuthorityDigest: operation.acceptedAuthorityVector.securityDecisionDigest,
      authorityGeneration: operation.acceptedAuthorityVector.operationAuthorityRevision,
      authorityHeadDigest: operation.acceptedAuthorityVector.securityDecisionDigest,
      authorityRevision: operation.acceptedAuthorityVector.securityAuthorityRevision,
      constraintsDigest: digestContainedTurnCanonicalValue({
        adapterSnapshot: operation.adapterSnapshot, capabilityManifest: operation.capabilityManifest, intentMode: operation.intent.mode,
      } as never),
      containmentPolicyDigest: operation.acceptedAuthorityVector.containmentPolicyDigest,
      providerBindingDigest, providerId: operation.adapterSnapshot.provider,
    },
    scope, scopeDigest: containedTurnScopeDigest(scope), workspaceId,
  });
};

export const consumedReceipt = (owner: "provider_access" | "runtime_security", subject: ReturnType<typeof grantSubject>) => {
  const request = owner === "provider_access" ? subject.providerAccessRequest : subject.runtimeSecurityRequest;
  return Object.freeze({
    authorityFacts: owner === "provider_access" ? subject.providerAccessExpectation : subject.runtimeSecurityExpectation,
    claimBeforeControlTime: 100, claimBindingDigest: request.claimBindingDigest, consumedAtControlTime: 50,
    consumptionDigest: `${owner}-consumption:one`, grantRequestDigest: request.grantRequestId.slice("grant-request:".length) as never,
    grantRequestId: request.grantRequestId, operationId: subject.operationId, owner,
    ownerEvidenceRef: `${owner}-evidence:v1:one`, provider: subject.provider,
    purpose: "contained-turn.provider-dispatch/v1" as const, requestDigest: request.requestDigest,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
    validThroughOperationCutoffRevision: subject.operationCutoffRevision,
  });
};
