import { digestContainedTurnCanonicalValue, type ContainedTurnCanonicalDigest, type ContainedTurnCanonicalValue } from "./contained-turn-codecs.js";
import { containedTurnIdentity, type ContainedTurnEvidenceId, type ContainedTurnIdentity } from "./contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";

export type ContainedTurnClosureStage =
  | "physical_containment"
  | "artifact_seal"
  | "workspace_close"
  | "containment_attestation";

export type ContainedTurnClosureDebtId = ContainedTurnIdentity<"closure_debt">;
export type ContainedTurnClosureRequestId = ContainedTurnIdentity<"closure_request">;

export type ContainedTurnClosureRecovery =
  | { readonly kind: "clear" }
  | {
    readonly debtId: ContainedTurnClosureDebtId;
    readonly evidenceIds: readonly ContainedTurnEvidenceId[];
    readonly kind: "required";
    readonly requestDigest: ContainedTurnCanonicalDigest;
    readonly requestId: ContainedTurnClosureRequestId;
    readonly stage: ContainedTurnClosureStage;
  };

// The score counts closed-stage binding alternatives and null normalization, not control flow.
// oxlint-disable-next-line complexity
const closureRequestValue = (
  operation: ContainedTurnKernelOperation,
  stage: ContainedTurnClosureStage,
): ContainedTurnCanonicalValue => {
  const common = {
    authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    operationId: operation.operationId,
    stage,
    version: 1,
  } as const;
  switch (stage) {
    case "physical_containment":
      return { ...common, attemptId: operation.dispatch.kind === "claimed" ? operation.dispatch.attemptId : null, custodyId: operation.custodyId ?? null, hostBootId: operation.hostBootId ?? null, hostInstanceId: operation.hostInstanceId ?? null };
    case "artifact_seal":
      return { ...common, finalCursor: operation.output.chunks.length, outputDigest: digestContainedTurnCanonicalValue(operation.output.chunks as unknown as ContainedTurnCanonicalValue), physicalContainmentProofId: operation.physicalContainment.kind === "contained" ? operation.physicalContainment.proofId : null, workspaceId: operation.workspaceId ?? null };
    case "workspace_close":
      return { ...common, artifactManifestRef: operation.artifactManifestRef ?? null, artifactProofId: operation.proofs.find(proof => proof.kind === "artifact_manifest_seal")?.proofId ?? null, resultProofId: operation.proofs.find(proof => proof.kind === "result_publication")?.proofId ?? null, resultRef: operation.resultRef ?? null, workspaceId: operation.workspaceId ?? null };
    case "containment_attestation":
      return { ...common, cutoffProofId: operation.operationCutoff.kind === "closed" && "proofId" in operation.operationCutoff ? operation.operationCutoff.proofId : operation.admissionFence.kind === "fenced" ? operation.admissionFence.proofId : null, cutoffRevision: operation.operationCutoff.revision, physicalContainmentProofId: operation.physicalContainment.kind === "contained" ? operation.physicalContainment.proofId : null };
  }
};

export const containedTurnClosureRequest = (
  operation: ContainedTurnKernelOperation,
  stage: ContainedTurnClosureStage,
): Extract<ContainedTurnClosureRecovery, { readonly kind: "required" }> => {
  const debtDigest = digestContainedTurnCanonicalValue({ operationId: operation.operationId, scopeDigest: operation.acceptedAuthorityVector.scopeDigest, stage, version: 1 });
  const debtId = containedTurnIdentity("closure_debt", `closure-debt:${debtDigest}`);
  const requestDigest = digestContainedTurnCanonicalValue(closureRequestValue(operation, stage));
  const requestIdDigest = digestContainedTurnCanonicalValue({ debtId, requestDigest });
  return Object.freeze({ debtId, evidenceIds: Object.freeze([]), kind: "required", requestDigest, requestId: containedTurnIdentity("closure_request", `closure-request:${requestIdDigest}`), stage });
};
