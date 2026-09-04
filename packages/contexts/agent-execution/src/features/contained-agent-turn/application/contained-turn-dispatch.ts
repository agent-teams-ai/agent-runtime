import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnPreparationToken,
  ContainedTurnProofId,
} from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { containedTurnOutputWriteAuthority } from "../domain/contained-turn-output-authority.js";
import type { ContainedTurnKernelMutation } from "../domain/contained-turn-transitions.js";
import type { CommittedDispatchProofV1 } from "../domain/committed-dispatch-proof-v1.js";
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
} from "./contained-turn-committer.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import { containedTurnPreparationToken, releaseLosingContainedTurnCustody } from "./contained-turn-preparation-cleanup.js";
import { claimPreparedContainedTurn } from "./contained-turn-grant-claim.js";
import type {
  ContainedTurnKernelDependencies,
  ContainedTurnKernelProviderObservation,
} from "./ports/outbound/contained-turn-ports.js";

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

const claimContainedTurnConsumedGrantDispatch = async (input: Readonly<{
  custody: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>;
  dependencies: ContainedTurnKernelDependencies;
  initial: ContainedTurnKernelOperation;
  preparationToken: ContainedTurnPreparationToken;
  prepared: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["prepareDispatch"]>>;
  trustedScope: ContainedTurnScope;
}>): Promise<Readonly<{
  committedDispatchProof?: CommittedDispatchProofV1; operation: ContainedTurnKernelOperation; startPermitted: boolean;
}>> => {
  const { custody, dependencies, initial, preparationToken, prepared, trustedScope } = input;
  const claim = await claimPreparedContainedTurn({
    custody, dependencies, operation: initial, preparation: prepared,
    preparationToken, trustedScope,
  });
  if (claim.kind === "claimed") {
    return Object.freeze({ committedDispatchProof: claim.committedDispatchProof, operation: claim.operation, startPermitted: true });
  }
  if (claim.kind === "observed") {
    return Object.freeze({
      operation: await closeUnknownStart(
        dependencies,
        claim.operation,
        trustedScope,
        redactedContainedTurnEvidenceId(claim.operation, "dispatch_claim_rejected"),
      ),
      startPermitted: false,
    });
  }
  return claim.kind === "prevented"
    ? Object.freeze({ operation: await preventContainedTurnDispatch(
      dependencies, claim.operation, trustedScope, claim.preventionProofId,
    ), startPermitted: false })
    : Object.freeze({ operation: claim.operation, startPermitted: false });
};

const claimContainedTurnDispatch = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<Readonly<{
  operation: ContainedTurnKernelOperation;
  committedDispatchProof?: CommittedDispatchProofV1;
  startPermitted: boolean;
}>> => {
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
      commandId: initial.commandId,
      custodyId: prepared.custodyId,
      effectId: initial.effectId,
      intentMode: initial.intent.mode,
      operationId: initial.operationId,
      operationCutoffRevision: initial.operationCutoff.revision,
      operationRevision: initial.revision + 1,
      preparationToken,
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
  return claimContainedTurnConsumedGrantDispatch({
    custody, dependencies, initial, preparationToken, prepared, trustedScope,
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
  committedDispatchProof: CommittedDispatchProofV1,
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
      intentMode: claimed.intent.mode,
      operationId: claimed.operationId,
      committedDispatchProof,
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
  return claimed.startPermitted && claimed.committedDispatchProof !== undefined &&
      claimed.operation.dispatch.kind === "claimed"
    ? startContainedTurnExecution(
      dependencies, claimed.operation, trustedScope, claimed.committedDispatchProof,
    )
    : claimed.operation;
};
