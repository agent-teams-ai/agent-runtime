import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnWorkspaceId,
} from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import {
  readContainedTurnOwnedOperation,
  recordContainedTurnRejectedDebt,
  redactedContainedTurnEvidenceId,
} from "./contained-turn-closure.js";
import {
  advanceContainedTurn,
  ContainedTurnCasLostError,
  ContainedTurnIndeterminateCommitError,
} from "./contained-turn-committer.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

export const quarantineLosingContainedTurnWorkspace = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  workspaceId: ContainedTurnWorkspaceId,
): Promise<ContainedTurnKernelOperation> => {
  let current = operation;
  try {
    current = await readContainedTurnOwnedOperation(dependencies, operation.operationId, trustedScope) ?? operation;
    if (current.workspaceId === workspaceId) {return current;}
    await dependencies.workspace.quarantine({
      evidenceId: redactedContainedTurnEvidenceId(operation, "workspace_bind_lost"),
      operationId: operation.operationId,
      workspaceId,
    });
    return current;
  } catch {
    try {
      await dependencies.workspace.quarantine({
        evidenceId: redactedContainedTurnEvidenceId(operation, "workspace_bind_lost"),
        operationId: operation.operationId,
        workspaceId,
      });
    } catch {}
    return recordContainedTurnRejectedDebt(
      dependencies, current, trustedScope, "workspace_cleanup_rejected", "workspace",
    );
  }
};

export const bindContainedTurnCancellationWorkspace = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  const workspace = await dependencies.workspace.create({ operationId: operation.operationId, scope: trustedScope });
  try {
    return await advanceContainedTurn(dependencies, operation, trustedScope, {
      kind: "bind_workspace",
      workspaceId: workspace.workspaceId,
    });
  } catch (error) {
    const current = await quarantineLosingContainedTurnWorkspace(
      dependencies,
      error instanceof ContainedTurnIndeterminateCommitError ? error.operation : operation,
      trustedScope,
      workspace.workspaceId,
    );
    return error instanceof ContainedTurnCasLostError || error instanceof ContainedTurnIndeterminateCommitError
      ? current
      : recordContainedTurnRejectedDebt(
        dependencies, current, trustedScope, "workspace_bind_rejected", "workspace",
      );
  }
};

export const releaseLosingContainedTurnCustody = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  reservation: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    reason: "claim_lost" | "open_failed" | "prevention" | "revalidation_failed";
    workspaceId: ContainedTurnWorkspaceId;
  }>,
): Promise<ContainedTurnKernelOperation> => {
  try {
    await dependencies.custody.releaseReservation({
      ...reservation,
      operationId: operation.operationId,
    });
    return operation;
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, operation, trustedScope, "custody_release_rejected", "containment",
    );
  }
};
