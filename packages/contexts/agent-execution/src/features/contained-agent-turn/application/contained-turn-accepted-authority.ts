import { validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnAuthorityScope } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { containedTurnOperationDispatchSubject, type ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";
import { validateContainedTurnOperation } from "../domain/contained-turn-validation.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import { containedTurnAcceptanceConstraintsDigestV1, containedTurnAcceptanceIntentDigestV1 } from "./contained-turn-acceptance-digests.js";

export type ContainedTurnAcceptedAuthorityHandoff = Readonly<{
  operationId: ContainedTurnKernelOperation["operationId"];
  scope: ContainedTurnAuthorityScope;
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
  trustedScope: ContainedTurnAuthorityScope,
  subject: Pick<ContainedTurnDispatchGrantSubject, "attemptId" | "custodyId" | "executionGenerationId" | "hostBootId" | "hostInstanceId" | "preparationToken">,
): ContainedTurnDispatchGrantSubject => {
  return containedTurnOperationDispatchSubject(operation, trustedScope, subject, operation.operationCutoff.revision);
};

/** Private acknowledged-owner path only. This projection is not standalone database commit proof. */
export const createContainedTurnAcceptedAuthorityHandoff = (
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnAuthorityScope,
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
