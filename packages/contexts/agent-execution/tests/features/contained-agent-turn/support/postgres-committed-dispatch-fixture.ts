import assert from "node:assert/strict";

import type { Pool } from "pg";

import { PostgresContainedTurnOperationStore } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnPreparationToken } from "../../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "../../../../dist/features/contained-agent-turn/composition/dispatch-grant-anti-corruption.js";
import { containedTurnProviderAccessSnapshotDigest } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { completeContainedTurnDispatchGrantSubject } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { createOperation, proofId } from "../../../contained-turn-kernel-fixtures.ts";
import { operationAuthority, operationForProject } from "../postgres-contained-turn-test-helpers.ts";

export const postgresClaimInput = (
  bound: ReturnType<typeof createOperation>,
  workspaceId: NonNullable<ReturnType<typeof createOperation>["workspaceId"]>,
  reservation: Awaited<ReturnType<PostgresContainedTurnOperationStore["prepareDispatch"]>>,
  suffix: string,
) => {
  const preparationToken = containedTurnPreparationToken({
    attemptId: reservation.attemptId,
    custodyId: reservation.custodyId,
    operationId: bound.operationId,
  });
  const providerBindingDigest = containedTurnProviderAccessSnapshotDigest(bound.providerAccessSnapshot);
  const subject = completeContainedTurnDispatchGrantSubject(Object.freeze({
    attemptId: reservation.attemptId,
    custodyId: reservation.custodyId,
    effectId: bound.effectId,
    executionGenerationId: reservation.executionGenerationId,
    hostBootId: containedTurnIdentity("host_boot", `host-boot:claim:${suffix}`),
    hostInstanceId: containedTurnIdentity("host_instance", `host-instance:claim:${suffix}`),
    operationCutoffRevision: bound.operationCutoff.revision,
    operationId: bound.operationId,
    preparationToken,
    purpose: "contained_turn_provider_start_v1" as const,
    provider: bound.adapterSnapshot.provider,
    providerAccessExpectation: Object.freeze({
      acceptedAuthorityDigest: bound.acceptedAuthorityVectorDigest,
      accessRef: bound.providerAccessSnapshot.accessRef,
      authorityHeadDigest: bound.providerAccessSnapshot.ownerAuthorityDigest,
      bindingDigest: providerBindingDigest,
      bindingRevision: bound.providerAccessSnapshot.revision,
      credentialBindingDigest: bound.providerAccessSnapshot.credentialBindingDigest,
      credentialBindingRef: bound.providerAccessSnapshot.credentialBindingRef,
      credentialGeneration: bound.providerAccessSnapshot.credentialGeneration,
      providerAccountRef: bound.providerAccessSnapshot.providerAccountRef,
      providerRouteRef: bound.providerAccessSnapshot.providerRouteRef,
    }),
    runtimeSecurityExpectation: Object.freeze({
      acceptedAuthorityDigest: bound.acceptedAuthorityVector.securityDecisionDigest,
      authorityGeneration: bound.acceptedAuthorityVector.operationAuthorityRevision,
      authorityHeadDigest: bound.acceptedAuthorityVector.securityDecisionDigest,
      authorityRevision: bound.acceptedAuthorityVector.securityAuthorityRevision,
      constraintsDigest: digestContainedTurnCanonicalValue({
        adapterSnapshot: bound.adapterSnapshot,
        capabilityManifest: bound.capabilityManifest,
        intentMode: bound.intent.mode,
      } as never),
      containmentPolicyDigest: bound.acceptedAuthorityVector.containmentPolicyDigest,
      providerBindingDigest,
      providerId: bound.adapterSnapshot.provider,
    }),
    scope: bound.scope,
    scopeDigest: bound.acceptedAuthorityVector.scopeDigest,
    workspaceId,
  }));
  const receipt = (owner: "provider_access" | "runtime_security") => {
    const request = owner === "provider_access" ? subject.providerAccessRequest : subject.runtimeSecurityRequest;
    return normalizeContainedTurnConsumedGrantReceipt(owner, subject, {
      authorityFacts: owner === "provider_access" ? subject.providerAccessExpectation : subject.runtimeSecurityExpectation,
      claimBeforeControlTime: 100,
      claimBindingDigest: request.claimBindingDigest,
      consumedAtControlTime: 50,
      consumptionDigest: digestContainedTurnCanonicalValue({ owner, state: "consumed", suffix }),
      grantRequestId: request.grantRequestId,
      operationId: subject.operationId,
      ownerEvidenceRef: `${owner}:evidence:${suffix}`,
      provider: subject.provider,
      purpose: "contained-turn.provider-dispatch/v1" as const,
      requestDigest: request.requestDigest,
      scope: Object.freeze({ ...subject.scope, scopeDigest: subject.scopeDigest }),
    });
  };
  const receipts = Object.freeze([receipt("provider_access"), receipt("runtime_security")]) as const;
  return Object.freeze({
    claimInput: Object.freeze({
      authority: operationAuthority(bound),
      consumedGrantReceipts: receipts,
      expectedOperationRevision: bound.revision,
      hostCustodyProof: Object.freeze({
        binding: Object.freeze({
          attemptId: subject.attemptId,
          authorityVectorDigest: bound.acceptedAuthorityVectorDigest,
          custodyId: subject.custodyId,
          effectId: bound.effectId,
          operationId: bound.operationId,
        }),
        kind: "host_custody" as const,
        proofId: proofId(`proof:host-custody:${subject.attemptId}`),
      }),
      subject,
    }),
    preparationToken,
    receipts,
    subject,
  });
};

export const preparePostgresClaim = async (pool: Pool, suffix: string) => {
  const store = new PostgresContainedTurnOperationStore({ pool });
  const initial = operationForProject(`project:${suffix}`, suffix);
  assert.equal((await store.accept(initial, operationAuthority(initial))).kind, "accepted");
  const workspaceId = containedTurnIdentity("workspace", `workspace:${suffix}`);
  const bound = mutateContainedTurnOperation(initial, { kind: "bind_workspace", workspaceId });
  assert.equal((await store.commit({
    authority: operationAuthority(initial), candidate: bound, expectedRevision: initial.revision,
  })).kind, "applied");
  const prepared = await store.prepareDispatch({ authority: operationAuthority(bound), operation: bound });
  return Object.freeze({
    bound,
    claim: postgresClaimInput(bound, workspaceId, prepared, suffix),
    store,
  });
};
