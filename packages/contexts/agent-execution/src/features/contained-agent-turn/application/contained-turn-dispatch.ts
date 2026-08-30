import {
  containedTurnProviderAccessSnapshotDigest,
  type ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import {
  encodeContainedTurnCanonicalValue,
  type ContainedTurnCanonicalValue,
} from "../domain/contained-turn-codecs.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnPreparationToken,
  ContainedTurnProofId,
} from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { containedTurnOutputWriteAuthority } from "../domain/contained-turn-output-authority.js";
import {
  mutateContainedTurnOperation,
  type ContainedTurnKernelMutation,
} from "../domain/contained-turn-transitions.js";
import {
  closeContainedTurnExecution,
  closeContainedTurnPhysicalContainment,
  closeContainedTurnWithoutExecution,
  readContainedTurnOwnedOperation,
  recordContainedTurnRejectedDebt,
  redactedContainedTurnEvidenceId,
} from "./contained-turn-closure.js";
import {
  advanceContainedTurn,
  appendContainedTurnCanonicalOutput,
  durableContainedTurnDebtOperation,
  recordContainedTurnReconciliationDebt,
} from "./contained-turn-committer.js";
import {
  containedTurnOwnerStoreAuthority,
  sanitizeContainedTurnOwnerStoreOutcome,
} from "./contained-turn-store-authority.js";
import {
  containedTurnPreparationToken,
  reconcileContainedTurnClaimPreparation,
  releaseLosingContainedTurnCustody,
} from "./contained-turn-preparation-cleanup.js";
import type {
  ContainedTurnKernelDependencies,
  ContainedTurnKernelProviderObservation,
} from "./ports/outbound/contained-turn-ports.js";

const sameSnapshot = (left: unknown, right: unknown): boolean =>
  encodeContainedTurnCanonicalValue(left as ContainedTurnCanonicalValue) ===
  encodeContainedTurnCanonicalValue(right as ContainedTurnCanonicalValue);

const raceContainedTurnCompletionBoundary = async <Value>(
  promise: Promise<Value>,
  boundary: ReturnType<ContainedTurnKernelDependencies["custody"]["completionBoundary"]>,
): Promise<
  | { readonly kind: "completed"; readonly value: Value }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "expired" }
> => {
  try {
    return await Promise.race([
      promise.then(value => ({ kind: "completed" as const, value })),
      boundary.expiration,
    ]);
  } finally {
    boundary.release();
  }
};

const preventContainedTurnDispatch = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  preventionProofId: ContainedTurnProofId,
): Promise<ContainedTurnKernelOperation> => {
  let proofs: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["proofsForPrevention"]>>;
  try {
    proofs = await dependencies.operationStore.proofsForPrevention({
      authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
      operation,
      preventionProofId,
    });
    if (proofs.noDispatchProof.proofId !== preventionProofId) {
      throw new TypeError("dispatch prevention must preserve the exact authority proof identity");
    }
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, operation, trustedScope, "dispatch_prevention_rejected", "dispatch_authority",
    );
  }
  const prevented = await advanceContainedTurn(dependencies, operation, trustedScope, {
    ...proofs,
    kind: "prevent_dispatch",
  });
  return closeContainedTurnWithoutExecution(dependencies, prevented, trustedScope);
};

const persistContainedTurnDispatchClaim = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  input: Readonly<{
    dispatchAuthority: Parameters<ContainedTurnKernelDependencies["operationStore"]["claimDispatch"]>[0]["dispatchAuthority"];
    mutation: Extract<ContainedTurnKernelMutation, { readonly kind: "claim_dispatch" }>;
    reservation: Readonly<{
      attemptId: Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]["attemptId"];
      custodyId: Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]["custodyId"];
      preparationToken: ContainedTurnPreparationToken;
      workspaceId: Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]["workspaceId"];
    }>;
  }>,
): Promise<Readonly<{ operation: ContainedTurnKernelOperation; startPermitted: boolean }>> => {
  let outcome: ReturnType<typeof sanitizeContainedTurnOwnerStoreOutcome>;
  try {
    outcome = sanitizeContainedTurnOwnerStoreOutcome({
      authority: containedTurnOwnerStoreAuthority(initial, trustedScope),
      outcome: await dependencies.operationStore.claimDispatch({
        authority: containedTurnOwnerStoreAuthority(initial, trustedScope),
        candidate: mutateContainedTurnOperation(initial, input.mutation),
        dispatchAuthority: input.dispatchAuthority,
        expectedRevision: initial.revision,
      }),
    });
  } catch {
    return reconcileContainedTurnClaimPreparation(
      dependencies, initial, trustedScope, input.reservation,
    );
  }
  if (outcome.kind === "applied") {
    return Object.freeze({ operation: outcome.operation, startPermitted: true });
  }
  const durableFallback = outcome.kind === "indeterminate"
    ? durableContainedTurnDebtOperation(outcome)
    : outcome.kind === "stale" ? outcome.current : undefined;
  return reconcileContainedTurnClaimPreparation(
    dependencies, initial, trustedScope, input.reservation, durableFallback,
  );
};

const containedTurnClaimMutation = (
  initial: ContainedTurnKernelOperation,
  prepared: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["prepareDispatch"]>>,
  custody: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>,
  preparationToken: ContainedTurnPreparationToken,
  access: Extract<Awaited<ReturnType<ContainedTurnKernelDependencies["providerAccess"]["revalidateForDispatch"]>>, { readonly kind: "current" }>,
  security: Extract<Awaited<ReturnType<ContainedTurnKernelDependencies["security"]["revalidateForDispatch"]>>, { readonly kind: "current" }>,
): Extract<ContainedTurnKernelMutation, { readonly kind: "claim_dispatch" }> => {
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
        ...operationBinding,
        attemptId: prepared.attemptId,
        effectId: initial.effectId,
        preparationToken,
        providerAccessDispatchProofId: access.dispatchProofId,
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

const claimContainedTurnDispatch = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<Readonly<{ operation: ContainedTurnKernelOperation; startPermitted: boolean }>> => {
  if (initial.workspaceId === undefined) {
    return Object.freeze({ operation: initial, startPermitted: false });
  }
  const workspaceId = initial.workspaceId;
  let prepared: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["prepareDispatch"]>>;
  try {
    prepared = await dependencies.operationStore.prepareDispatch({
      authority: containedTurnOwnerStoreAuthority(initial, trustedScope),
      operation: initial,
    });
  } catch {
    return Object.freeze({
      operation: await recordContainedTurnRejectedDebt(
        dependencies, initial, trustedScope, "dispatch_preparation_rejected", "dispatch_authority",
      ),
      startPermitted: false,
    });
  }
  const preparationToken = containedTurnPreparationToken({
    attemptId: prepared.attemptId,
    custodyId: prepared.custodyId,
    operationId: initial.operationId,
  });
  let custody: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>;
  const releaseReservation = (reason: "claim_lost" | "open_failed" | "prevention" | "revalidation_failed") =>
    releaseLosingContainedTurnCustody(dependencies, initial, trustedScope, {
      attemptId: prepared.attemptId,
      custodyId: prepared.custodyId,
      reason,
      workspaceId,
    });
  try {
    custody = await dependencies.custody.open({
      adapterSnapshot: initial.adapterSnapshot,
      attemptId: prepared.attemptId,
      authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
      custodyId: prepared.custodyId,
      operationId: initial.operationId,
      providerAccessSnapshot: initial.providerAccessSnapshot,
      workspaceId,
    });
  } catch {
    const released = await releaseReservation("open_failed");
    return Object.freeze({
      operation: await recordContainedTurnRejectedDebt(
        dependencies, released, trustedScope, "custody_open_rejected", "dispatch_authority",
      ),
      startPermitted: false,
    });
  }
  let access: Awaited<ReturnType<ContainedTurnKernelDependencies["providerAccess"]["revalidateForDispatch"]>>;
  let security: Awaited<ReturnType<ContainedTurnKernelDependencies["security"]["revalidateForDispatch"]>>;
  try {
    [access, security] = await Promise.all([
      dependencies.providerAccess.revalidateForDispatch({
        acceptedSnapshot: initial.providerAccessSnapshot,
        operationId: initial.operationId,
        scope: trustedScope,
      }),
      dependencies.security.revalidateForDispatch({
        decisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
        operationId: initial.operationId,
        scope: trustedScope,
        securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
      }),
    ]);
  } catch {
    const released = await releaseReservation("revalidation_failed");
    return Object.freeze({
      operation: await recordContainedTurnRejectedDebt(
        dependencies, released, trustedScope, "dispatch_authority_rejected", "dispatch_authority",
      ),
      startPermitted: false,
    });
  }
  const preventionProofId = access.kind === "prevented"
    ? access.preventionProofId
    : security.kind === "prevented"
      ? security.preventionProofId
      : undefined;
  if (preventionProofId !== undefined) {
    const released = await releaseReservation("prevention");
    const operation = released.reconciliation.kind === "required"
      ? released
      : preventContainedTurnDispatch(dependencies, released, trustedScope, preventionProofId);
    return Object.freeze({ operation: await operation, startPermitted: false });
  }
  const authorityEvidenceId = access.kind === "indeterminate"
    ? access.evidenceId
    : security.kind === "indeterminate"
      ? security.evidenceId
      : undefined;
  if (authorityEvidenceId !== undefined) {
    const released = await releaseReservation("revalidation_failed");
    return Object.freeze({
      operation: await recordContainedTurnReconciliationDebt(
        dependencies, released, trustedScope, authorityEvidenceId, "dispatch_authority",
      ),
      startPermitted: false,
    });
  }
  if (access.kind !== "current" || security.kind !== "current" ||
      !sameSnapshot(access.snapshot, initial.providerAccessSnapshot)) {
    const released = await releaseReservation("revalidation_failed");
    return Object.freeze({
      operation: await recordContainedTurnRejectedDebt(
        dependencies, released, trustedScope, "dispatch_authority_mismatch", "dispatch_authority",
      ),
      startPermitted: false,
    });
  }
  const mutation = containedTurnClaimMutation(
    initial, prepared, custody, preparationToken, access, security,
  );
  return persistContainedTurnDispatchClaim(dependencies, initial, trustedScope, {
    dispatchAuthority: {
      acceptedProviderAccessSnapshotDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot),
      acceptedSecurityDecisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
      providerAccessDispatchProofId: access.dispatchProofId,
      providerAccessRevision: initial.providerAccessSnapshot.revision,
      runtimeSecurityDispatchProofId: security.proofId,
      securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
    },
    mutation,
    reservation: {
      attemptId: prepared.attemptId,
      custodyId: prepared.custodyId,
      preparationToken,
      workspaceId,
    },
  });
};

const closeUnknownStart = async (
  dependencies: ContainedTurnKernelDependencies,
  claimed: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  evidenceId: ContainedTurnEvidenceId,
): Promise<ContainedTurnKernelOperation> => {
  let current = await readContainedTurnOwnedOperation(
    dependencies, claimed.operationId, trustedScope,
  ) ?? claimed;
  if (current.providerProcessStart.kind === "pending") {
    current = await advanceContainedTurn(dependencies, current, trustedScope, {
      evidenceId,
      kind: "record_process_start_unknown",
    });
  } else if (current.reconciliation.kind === "clear") {
    current = await recordContainedTurnRejectedDebt(
      dependencies, current, trustedScope, "custody_start_rejected", "store_commit",
    );
  }
  return closeContainedTurnPhysicalContainment(dependencies, current, trustedScope);
};

const startContainedTurnExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  claimed: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (claimed.dispatch.kind !== "claimed" || claimed.custodyId === undefined ||
      claimed.workspaceId === undefined) {
    return claimed;
  }
  const custodyId = claimed.custodyId;
  const dispatch = claimed.dispatch;
  const workspaceId = claimed.workspaceId;
  let current = claimed;
  let releasePersistedStart!: () => void;
  const persistedStart = new Promise<void>(resolve => {releasePersistedStart = resolve;});
  const outputAuthority = containedTurnOutputWriteAuthority(claimed);
  let start: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["start"]>>;
  const startBoundary = dependencies.custody.completionBoundary({
    attemptId: dispatch.attemptId,
    custodyId,
    operationId: claimed.operationId,
    phase: "start",
  });
  try {
    const boundedStart = await raceContainedTurnCompletionBoundary(dependencies.custody.start({
      attemptId: dispatch.attemptId,
      custodyId,
      execute: delegatedStart => dependencies.provider.execute({
        adapterSnapshot: current.adapterSnapshot,
        attemptId: dispatch.attemptId,
        authorityVectorDigest: current.acceptedAuthorityVectorDigest,
        custodyId,
        effectId: current.effectId,
        emit: async output => {
          await persistedStart;
          current = await appendContainedTurnCanonicalOutput({
            authority: outputAuthority,
            dependencies,
            operation: current,
            output,
            trustedScope,
          });
        },
        intent: current.intent,
        isCancellationRequested: async () =>
          (await readContainedTurnOwnedOperation(dependencies, current.operationId, trustedScope))
            ?.cancellation.kind === "requested",
        operationId: current.operationId,
        providerAccessSnapshot: current.providerAccessSnapshot,
        start: delegatedStart,
        workspaceId,
      }),
      intent: claimed.intent,
      operationId: claimed.operationId,
      workspaceId,
    }), startBoundary);
    if (boundedStart.kind === "expired") {
      releasePersistedStart();
      return closeUnknownStart(dependencies, claimed, trustedScope, boundedStart.evidenceId);
    }
    start = boundedStart.value;
  } catch {
    releasePersistedStart();
    return closeUnknownStart(
      dependencies,
      claimed,
      trustedScope,
      redactedContainedTurnEvidenceId(claimed, "custody_start_rejected"),
    );
  }
  if (start.kind === "indeterminate") {
    releasePersistedStart();
    return closeUnknownStart(dependencies, claimed, trustedScope, start.evidenceId);
  }
  try {
    current = await advanceContainedTurn(dependencies, claimed, trustedScope, {
      kind: start.kind === "execution_started" ? "record_process_start" : "record_process_no_start",
      proof: start.proof,
    } as ContainedTurnKernelMutation);
  } catch {
    return closeUnknownStart(
      dependencies,
      claimed,
      trustedScope,
      redactedContainedTurnEvidenceId(claimed, "custody_start_rejected"),
    );
  } finally {
    releasePersistedStart();
  }
  if (start.kind === "execution_started") {
    let outcome: ContainedTurnKernelProviderObservation;
    const executionBoundary = dependencies.custody.completionBoundary({
      attemptId: dispatch.attemptId,
      custodyId,
      operationId: claimed.operationId,
      phase: "execution",
    });
    try {
      const boundedExecution = await raceContainedTurnCompletionBoundary(start.execution, executionBoundary);
      outcome = boundedExecution.kind === "completed"
        ? boundedExecution.value
        : { evidenceId: boundedExecution.evidenceId, kind: "indeterminate" };
    } catch {
      outcome = {
        evidenceId: redactedContainedTurnEvidenceId(current, "provider_execution_rejected"),
        kind: "indeterminate",
      };
    }
    return closeContainedTurnExecution(dependencies, current, trustedScope, outcome);
  }
  let proofs: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["proofsForProcessNoStart"]>>;
  try {
    proofs = await dependencies.operationStore.proofsForProcessNoStart({
      authority: containedTurnOwnerStoreAuthority(current, trustedScope),
      operation: current,
    });
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, current, trustedScope, "no_start_bookkeeping_rejected", "store_commit",
    );
  }
  current = await advanceContainedTurn(dependencies, current, trustedScope, {
    ...proofs,
    kind: "close_process_no_start",
  });
  return closeContainedTurnWithoutExecution(dependencies, current, trustedScope);
};

export const dispatchContainedTurn = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  const claimed = await claimContainedTurnDispatch(dependencies, initial, trustedScope);
  return claimed.startPermitted && claimed.operation.dispatch.kind === "claimed"
    ? startContainedTurnExecution(dependencies, claimed.operation, trustedScope)
    : claimed.operation;
};
