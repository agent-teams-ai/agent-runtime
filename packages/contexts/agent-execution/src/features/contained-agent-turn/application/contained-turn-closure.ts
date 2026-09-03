import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { containedTurnIdentity, type ContainedTurnEvidenceId } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "../domain/contained-turn-proofs.js";
import { containedTurnSatisfactionDigest } from "../domain/contained-turn-satisfaction.js";
import { assertContainedTurnExactRecord } from "../domain/contained-turn-record.js";
import type { ContainedTurnKernelMutation } from "../domain/contained-turn-transitions.js";
import {
  advanceContainedTurn,
  recordContainedTurnReconciliationDebt,
} from "./contained-turn-committer.js";
import {
  containedTurnOwnerStoreAuthority,
  selectContainedTurnOwnerStoreRead,
} from "./contained-turn-store-authority.js";
import type {
  ContainedTurnKernelDependencies,
  ContainedTurnKernelProviderObservation,
} from "./ports/outbound/contained-turn-ports.js";
import {
  closeContainedTurnNoWorkspaceObligations,
  resumeContainedTurnClosureStage,
} from "./contained-turn-closure-recovery.js";

type DebtSource = Extract<ContainedTurnKernelMutation, {
  readonly kind: "record_reconciliation_debt";
}>["source"];

export type RedactedIndeterminateSource =
  | "artifact_seal_rejected"
  | "cancellation_closure_rejected"
  | "composite_containment_rejected"
  | "custody_open_rejected"
  | "custody_release_rejected"
  | "custody_start_rejected"
  | "dispatch_claim_rejected"
  | "dispatch_authority_mismatch"
  | "dispatch_authority_rejected"
  | "dispatch_preparation_rejected"
  | "dispatch_prevention_rejected"
  | "execution_bookkeeping_rejected"
  | "no_start_bookkeeping_rejected"
  | "physical_containment_rejected"
  | "provider_execution_rejected"
  | "terminal_proof_rejected"
  | "workspace_close_rejected"
  | "workspace_bind_lost"
  | "workspace_bind_rejected"
  | "workspace_cleanup_rejected"
  | "workspace_create_rejected"
  | "grant_settlement_rejected";

export const redactedContainedTurnEvidenceId = (
  operation: ContainedTurnKernelOperation,
  source: RedactedIndeterminateSource,
): ContainedTurnEvidenceId => {
  const digest = digestContainedTurnCanonicalValue({
    executionGenerationId: operation.dispatch.kind === "claimed"
      ? operation.dispatch.executionGenerationId
      : "not_claimed",
    operationId: operation.operationId,
    revision: operation.revision,
    source,
  });
  return containedTurnIdentity("evidence", `evidence:contained-turn-indeterminate:${digest}`);
};

export const readContainedTurnOwnedOperation = async (
  dependencies: ContainedTurnKernelDependencies,
  operationId: ContainedTurnKernelOperation["operationId"],
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation | undefined> => selectContainedTurnOwnerStoreRead({
  current: await dependencies.operationStore.read({ operationId, scope: trustedScope }),
  operationId,
  scope: trustedScope,
});

export const recordContainedTurnRejectedDebt = (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  source: RedactedIndeterminateSource,
  debtSource: DebtSource,
): Promise<ContainedTurnKernelOperation> => recordContainedTurnReconciliationDebt(
  dependencies,
  operation,
  trustedScope,
  redactedContainedTurnEvidenceId(operation, source),
  debtSource,
);

export const closeContainedTurnPhysicalContainment = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (operation.dispatch.kind !== "claimed" || operation.custodyId === undefined ||
      operation.physicalContainment.kind === "contained") {
    return operation;
  }
  const attemptId = operation.dispatch.attemptId;
  const custodyId = operation.custodyId;
  const recovered = await resumeContainedTurnClosureStage<
      Extract<ContainedTurnProof, { readonly kind: "physical_containment" }>
  >(
    dependencies,
    operation,
    trustedScope,
    {
      complete: (request, proof) => ({ kind: "complete_physical_containment", proof, request }),
      ensure: request => dependencies.custody.ensurePhysicalContainment({
          authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
          attemptId,
          custodyId,
          operationId: operation.operationId,
          requestDigest: request.requestDigest,
          requestId: request.requestId,
        }),
      proofIds: proof => [proof.proofId],
      query: request => dependencies.custody.queryPhysicalContainment({
        authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
        attemptId,
        custodyId,
        operationId: operation.operationId,
        requestDigest: request.requestDigest,
        requestId: request.requestId,
      }),
      stage: "physical_containment",
    },
  );
  return recovered.operation;
};

type StagedOperation =
  | { readonly kind: "debt"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "ready"; readonly operation: ContainedTurnKernelOperation };

const sealArtifactsAndWorkspace = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<StagedOperation> => {
  if (initial.workspaceId === undefined) {
    const operation = await closeContainedTurnNoWorkspaceObligations(dependencies, initial, trustedScope);
    return operation.closureRecovery.kind === "proved_no_workspace"
      ? { kind: "ready", operation }
      : { kind: "debt", operation };
  }
  const workspaceId = initial.workspaceId;
  let current = initial;
  if (current.artifactManifestRef === undefined || current.resultRef === undefined) {
    const recovered = await resumeContainedTurnClosureStage<Readonly<{
      artifactProof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }>;
      resultProof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>;
    }>>(
      dependencies,
      current,
      trustedScope,
      {
        complete: (request, proof) => ({
          artifactManifestRef: proof.artifactProof.binding.artifactManifestRef,
          artifactProof: proof.artifactProof,
          kind: "complete_artifact_seal",
          request,
          resultProof: proof.resultProof,
          resultRef: proof.resultProof.binding.resultRef,
        }),
        ensure: request => dependencies.artifacts.ensureSealed({
          authorityVectorDigest: current.acceptedAuthorityVectorDigest,
          operationId: current.operationId,
          output: current.output.chunks,
          requestDigest: request.requestDigest,
          requestId: request.requestId,
          workspaceId,
        }),
        proofIds: proof => [proof.artifactProof.proofId, proof.resultProof.proofId],
        query: request => dependencies.artifacts.querySeal({
          authorityVectorDigest: current.acceptedAuthorityVectorDigest,
          operationId: current.operationId,
          requestDigest: request.requestDigest,
          requestId: request.requestId,
          workspaceId,
        }),
        stage: "artifact_seal",
      },
    );
    if (recovered.kind === "debt") {return { kind: "debt", operation: recovered.operation };}
    current = recovered.operation;
  }
  const workspaceIsClosed = current.proofs.some(proof =>
    proof.kind === "workspace_closure" && proof.binding.workspaceId === workspaceId,
  );
  if (!workspaceIsClosed && current.resultRef !== undefined) {
    const recovered = await resumeContainedTurnClosureStage<
      Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>
    >(
      dependencies,
      current,
      trustedScope,
      {
        complete: (request, proof) => ({ kind: "complete_workspace_close", proof, request }),
        ensure: request => dependencies.workspace.ensureClosed({
          authorityVectorDigest: current.acceptedAuthorityVectorDigest,
          operationId: current.operationId,
          requestDigest: request.requestDigest,
          requestId: request.requestId,
          workspaceId,
        }),
        proofIds: proof => [proof.proofId],
        query: request => dependencies.workspace.queryClosure({
          authorityVectorDigest: current.acceptedAuthorityVectorDigest,
          operationId: current.operationId,
          requestDigest: request.requestDigest,
          requestId: request.requestId,
          workspaceId,
        }),
        stage: "workspace_close",
      },
    );
    return recovered.kind === "debt"
      ? { kind: "debt", operation: recovered.operation }
      : { kind: "ready", operation: recovered.operation };
  }
  if (current.artifactManifestRef !== undefined && current.resultRef !== undefined && workspaceIsClosed) {
    return { kind: "ready", operation: current };
  }
  return { kind: "debt", operation: current };
};

const finalizeContainedTurn = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (operation.reconciliation.kind === "required") {return operation;}
  if (operation.closureRecovery.kind === "required") {return operation;}
  let terminalProof: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["terminalProof"]>>;
  try {
    terminalProof = await dependencies.operationStore.terminalProof({
      authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
      operation,
      satisfactionDigest: containedTurnSatisfactionDigest(operation),
    });
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, operation, trustedScope, "terminal_proof_rejected", "store_commit",
    );
  }
  return advanceContainedTurn(dependencies, operation, trustedScope, {
    kind: "finalize",
    proof: terminalProof,
  });
};

const containedTurnCompositeContainmentBinding = (
  operation: ContainedTurnKernelOperation,
): Extract<ContainedTurnProof, { readonly kind: "containment" }>["binding"] => {
  if (operation.dispatch.kind !== "claimed" || operation.custodyId === undefined ||
      operation.hostBootId === undefined || operation.hostInstanceId === undefined ||
      operation.workspaceId === undefined || operation.admissionFence.kind !== "fenced") {
    throw new TypeError("composite containment requires exact claimed closure identities");
  }
  const requiredProofId = (kind: ContainedTurnProof["kind"]) => {
    const proof = operation.proofs.find(candidate => candidate.kind === kind);
    if (proof === undefined) {throw new TypeError(`composite containment is missing ${kind} proof`);}
    return proof.proofId;
  };
  return Object.freeze({
    adapterRevision: operation.adapterSnapshot.adapterRevision,
    artifactManifestSealProofId: requiredProofId("artifact_manifest_seal"),
    attemptId: operation.dispatch.attemptId,
    authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    binaryRevision: operation.adapterSnapshot.binaryRevision,
    capabilityManifestRevision: operation.capabilityManifest.manifestRevision,
    containmentPolicyDigest: operation.acceptedAuthorityVector.containmentPolicyDigest,
    credentialBindingDigest: operation.providerAccessSnapshot.credentialBindingDigest,
    custodyId: operation.custodyId,
    cutoffProofId: operation.operationCutoff.kind === "closed" && "proofId" in operation.operationCutoff
      ? operation.operationCutoff.proofId
      : operation.admissionFence.proofId,
    effectId: operation.effectId,
    executionClosureProofId: requiredProofId("execution_closure"),
    finalCursor: operation.output.chunks.length,
    hostBootId: operation.hostBootId,
    hostInstanceId: operation.hostInstanceId,
    immutableScopeDigest: operation.acceptedAuthorityVector.scopeDigest,
    operationId: operation.operationId,
    outputDrainProofId: requiredProofId("output_drain"),
    physicalContainmentProofId: requiredProofId("physical_containment"),
    providerRouteRef: operation.providerAccessSnapshot.providerRouteRef,
    terminalObservationProofId: requiredProofId("provider_terminal_observation"),
    workspaceId: operation.workspaceId,
  });
};

type ExecutionAttestation =
  | { readonly kind: "indeterminate"; readonly operation: ContainedTurnKernelOperation }
  | {
    readonly kind: "proved";
    readonly proofs: Extract<Awaited<ReturnType<
      ContainedTurnKernelDependencies["operationStore"]["proofsForAcceptedEffect"]
    >>, { readonly kind: "proved" }> & Extract<Awaited<ReturnType<
      ContainedTurnKernelDependencies["custody"]["attestExecutionClosure"]
    >>, { readonly kind: "proved" }>;
  };

const attestContainedTurnExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  observation: Extract<ContainedTurnKernelProviderObservation, { readonly kind: "completed" }>,
): Promise<ExecutionAttestation> => {
  if (operation.dispatch.kind !== "claimed" || operation.custodyId === undefined) {
    throw new TypeError("execution attestation requires the exact claimed custody reservation");
  }
  const [effectAuthority, hostAuthority] = await Promise.all([
    dependencies.operationStore.proofsForAcceptedEffect({
      authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
      operation,
    }),
    dependencies.custody.attestExecutionClosure({
      attemptId: operation.dispatch.attemptId,
      custodyId: operation.custodyId,
      finalCursor: operation.output.chunks.length,
      operationId: operation.operationId,
    }),
  ]);
  if (effectAuthority.kind === "indeterminate") {
    return {
      kind: "indeterminate",
      operation: await advanceContainedTurn(dependencies, operation, trustedScope, {
        evidenceId: effectAuthority.evidenceId,
        kind: "record_ambiguity",
      }),
    };
  }
  if (hostAuthority.kind === "indeterminate") {
    return {
      kind: "indeterminate",
      operation: await advanceContainedTurn(dependencies, operation, trustedScope, {
        evidenceId: hostAuthority.evidenceId,
        kind: "record_ambiguity",
      }),
    };
  }
  if (hostAuthority.executionClosureProof.binding.outcome !== observation.outcome ||
      hostAuthority.terminalObservationProof.binding.outcome !== observation.outcome ||
      hostAuthority.executionClosureProof.binding.outcome !== hostAuthority.terminalObservationProof.binding.outcome) {
    throw new TypeError("provider observation does not match independently attested execution closure");
  }
  return { kind: "proved", proofs: { ...effectAuthority, ...hostAuthority } };
};

export const closeContainedTurnExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  outcome: ContainedTurnKernelProviderObservation,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.dispatch.kind !== "claimed" || initial.custodyId === undefined ||
      initial.providerProcessStart.kind !== "execution_started") {
    return initial;
  }
  let current = await readContainedTurnOwnedOperation(
    dependencies, initial.operationId, trustedScope,
  ) ?? initial;
  try {
    if (outcome.kind === "indeterminate") {
      assertContainedTurnExactRecord("provider indeterminate observation", outcome, ["evidenceId", "kind"]);
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        evidenceId: outcome.evidenceId,
        kind: "record_ambiguity",
      });
    } else if (outcome.kind === "completed") {
      assertContainedTurnExactRecord("provider completion observation", outcome, ["kind", "outcome"]);
      const attestation = await attestContainedTurnExecution(dependencies, current, trustedScope, outcome);
      if (attestation.kind === "indeterminate") {
        return closeContainedTurnPhysicalContainment(dependencies, attestation.operation, trustedScope);
      }
      const { proofs } = attestation;
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        kind: "record_provider_acceptance",
        proof: proofs.acceptanceProof,
      });
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        executionProof: proofs.executionClosureProof,
        kind: "close_provider_execution",
        terminalObservationProof: proofs.terminalObservationProof,
      });
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        kind: "drain_output",
        proof: proofs.outputDrainProof,
      });
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        kind: "resolve_effect",
        proof: proofs.effectProof,
      });
    } else {
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        evidenceId: redactedContainedTurnEvidenceId(current, "provider_execution_rejected"),
        kind: "record_ambiguity",
      });
    }
  } catch {
    try {
      current = await readContainedTurnOwnedOperation(
        dependencies, initial.operationId, trustedScope,
      ) ?? current;
    } catch {}
    try {
      if (current.reconciliation.kind === "clear") {
        current = await recordContainedTurnRejectedDebt(
          dependencies, current, trustedScope, "execution_bookkeeping_rejected", "store_commit",
        );
      }
    } finally {
      current = await closeContainedTurnPhysicalContainment(dependencies, current, trustedScope);
    }
    return current;
  }
  current = await closeContainedTurnPhysicalContainment(dependencies, current, trustedScope);
  if (outcome.kind === "indeterminate" || current.physicalContainment.kind !== "contained" ||
      current.reconciliation.kind === "required") {
    return current;
  }
  return resumeContainedTurnTerminalization(dependencies, current, trustedScope);
};

/**
 * Resumes only durable owner-side closure after provider execution is closed.
 * This path cannot dispatch or execute the provider again.
 */
export const resumeContainedTurnTerminalization = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.terminal.kind === "final" || initial.reconciliation.kind === "required" ||
      initial.dispatch.kind !== "claimed" || initial.custodyId === undefined ||
      initial.providerProcessStart.kind !== "execution_started" ||
      initial.providerExecution.kind !== "closed") {
    return initial;
  }
  const attemptId = initial.dispatch.attemptId;
  const custodyId = initial.custodyId;
  let current = await closeContainedTurnPhysicalContainment(dependencies, initial, trustedScope);
  if (current.physicalContainment.kind !== "contained" || current.reconciliation.kind === "required") {
    return current;
  }
  const staged = await sealArtifactsAndWorkspace(dependencies, current, trustedScope);
  if (staged.kind === "debt") {return staged.operation;}
  current = staged.operation;
  const recovered = await resumeContainedTurnClosureStage<
      Extract<ContainedTurnProof, { readonly kind: "containment" }>
  >(
    dependencies,
    current,
    trustedScope,
    {
      complete: (request, proof) => ({ kind: "complete_containment_attestation", proof, request }),
      ensure: request => dependencies.custody.attestContainment({
          authorityVectorDigest: current.acceptedAuthorityVectorDigest,
          attemptId,
          binding: containedTurnCompositeContainmentBinding(current),
          custodyId,
          operationId: current.operationId,
          requestDigest: request.requestDigest,
          requestId: request.requestId,
        }),
      proofIds: proof => [proof.proofId],
      query: request => dependencies.custody.queryContainmentAttestation({
        authorityVectorDigest: current.acceptedAuthorityVectorDigest,
        attemptId,
        binding: containedTurnCompositeContainmentBinding(current),
        custodyId,
        operationId: current.operationId,
        requestDigest: request.requestDigest,
        requestId: request.requestId,
      }),
      stage: "containment_attestation",
    },
  );
  return recovered.kind === "debt"
    ? recovered.operation
    : finalizeContainedTurn(dependencies, recovered.operation, trustedScope);
};

export const closeContainedTurnWithoutExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.providerExecution.kind !== "closed") {return initial;}
  const staged = await sealArtifactsAndWorkspace(dependencies, initial, trustedScope);
  return staged.kind === "debt"
    ? staged.operation
    : finalizeContainedTurn(dependencies, staged.operation, trustedScope);
};
