import { digestContainedTurnCanonicalValue, type ContainedTurnCanonicalDigest, type ContainedTurnCanonicalValue } from "./contained-turn-codecs.js";
import { containedTurnIdentity, type ContainedTurnCancellationCommandId, type ContainedTurnEvidenceId, type ContainedTurnIdentity, type ContainedTurnProofId } from "./contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";

export type ContainedTurnClosureStage =
  | "physical_containment"
  | "artifact_seal"
  | "workspace_close"
  | "containment_attestation"
  | "no_workspace";

export type ContainedTurnClosureDebtId = ContainedTurnIdentity<"closure_debt">;
export type ContainedTurnClosureRequestId = ContainedTurnIdentity<"closure_request">;

export interface ContainedTurnNoWorkspaceClosureFact {
  readonly authorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly cancellationCommandId: ContainedTurnCancellationCommandId;
  readonly containmentProofId: ContainedTurnProofId;
  readonly effectProofId: ContainedTurnProofId;
  readonly factDigest: ContainedTurnCanonicalDigest;
  readonly hostCustodyProofId: ContainedTurnProofId;
  readonly noDispatchProofId: ContainedTurnProofId;
  readonly noStartProofId: ContainedTurnProofId;
  readonly operationId: ContainedTurnKernelOperation["operationId"];
  readonly outputProofId: ContainedTurnProofId;
  readonly providerProofId: ContainedTurnProofId;
  readonly scopeDigest: ContainedTurnCanonicalDigest;
  readonly version: 1;
}

export type ContainedTurnClosureRecovery =
  | { readonly kind: "clear" }
  | { readonly fact: ContainedTurnNoWorkspaceClosureFact; readonly kind: "proved_no_workspace" }
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
    case "no_workspace":
      return { ...common, cancellationCommandId: operation.cancellation.kind === "requested" ? operation.cancellation.command.cancellationCommandId : null, dispatch: operation.dispatch.kind, effectId: operation.effectId, workspaceId: operation.workspaceId ?? null };
  }
};

const proofId = <Kind extends string>(operation: ContainedTurnKernelOperation, kind: Kind): ContainedTurnProofId | undefined =>
  operation.proofs.find(proof => proof.kind === kind)?.proofId;

/**
 * Derives the authority-defined non-applicability fact only from an already
 * persisted prevention decision and its independently issued no-start proofs.
 */
// The count is the exact conjunction of independently proved no-start obligations.
// oxlint-disable-next-line complexity
export const containedTurnNoWorkspaceClosureFact = (
  operation: ContainedTurnKernelOperation,
): ContainedTurnNoWorkspaceClosureFact | undefined => {
  if (operation.workspaceId !== undefined || operation.dispatch.kind !== "prevented" ||
      operation.cancellation.kind !== "requested" || operation.providerProcessStart.kind !== "unobserved" ||
      operation.providerExecution.kind !== "closed" || operation.providerExecution.outcome !== "cancelled" ||
      operation.providerAcceptance.kind !== "not_accepted" || operation.output.chunks.length !== 0 ||
      operation.output.fence.kind !== "fenced" || operation.effect.kind !== "resolved" ||
      operation.effect.disposition !== "not_committed" || operation.containment.kind !== "qualified_not_required") {
    return undefined;
  }
  const noDispatchProofId = proofId(operation, "no_dispatch");
  const noStartProofId = proofId(operation, "no_start");
  const providerProofId = proofId(operation, "provider_not_started");
  const outputProofId = proofId(operation, "output_no_start_drain");
  const hostCustodyProofId = proofId(operation, "host_custody_no_start");
  const containmentProofId = proofId(operation, "containment_not_required");
  const effectProofId = proofId(operation, "effect_no_start");
  if (noDispatchProofId === undefined || noStartProofId === undefined || providerProofId === undefined ||
      outputProofId === undefined || hostCustodyProofId === undefined || containmentProofId === undefined ||
      effectProofId === undefined || operation.dispatch.noDispatchProofId !== noDispatchProofId ||
      operation.providerExecution.proofId !== noStartProofId || operation.providerAcceptance.proofId !== providerProofId ||
      operation.output.fence.proofId !== outputProofId || operation.containment.proofId !== containmentProofId ||
      operation.effect.proofId !== effectProofId) {
    return undefined;
  }
  const value = {
    authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    cancellationCommandId: operation.cancellation.command.cancellationCommandId,
    containmentProofId,
    effectProofId,
    hostCustodyProofId,
    noDispatchProofId,
    noStartProofId,
    operationId: operation.operationId,
    outputProofId,
    providerProofId,
    scopeDigest: operation.acceptedAuthorityVector.scopeDigest,
    version: 1,
  } as const;
  const factDigest = digestContainedTurnCanonicalValue(value);
  return Object.freeze({
    ...value,
    factDigest,
  });
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
