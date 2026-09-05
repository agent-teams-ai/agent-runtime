import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import type { ContainedTurnApplicationRefInput, ContainedTurnApplicationObserveOutcome } from "./contained-turn-engine.js";
import { assertContainedTurnExactRecord } from "../domain/contained-turn-record.js";
import { mutateContainedTurnOperation } from "../domain/contained-turn-transitions.js";
import {
  closeContainedTurnPhysicalContainment,
  closeContainedTurnWithoutExecution,
  readContainedTurnOwnedOperation,
  recordContainedTurnRejectedDebt,
} from "./contained-turn-closure.js";
import {
  advanceContainedTurn,
  ContainedTurnCasLostError,
  ContainedTurnIndeterminateCommitError,
  durableContainedTurnDebtOperation,
} from "./contained-turn-committer.js";
import {
  containedTurnOwnerStoreAuthority,
  sanitizeContainedTurnOwnerStoreOutcome,
} from "./contained-turn-store-authority.js";
import { bindContainedTurnCancellationWorkspace } from "./contained-turn-preparation-cleanup.js";
import {
  type ContainedTurnKernelDependencies,
} from "./ports/outbound/contained-turn-ports.js";

export const requestContainedTurnCancellation = async (
  dependencies: ContainedTurnKernelDependencies,
  input: ContainedTurnApplicationRefInput,
): Promise<ContainedTurnApplicationObserveOutcome> => {
  assertContainedTurnExactRecord("contained-turn cancellation", input, ["operationId", "scope"]);
  const operationId = containedTurnIdentity("operation", input.operationId);
  const operation = await readContainedTurnOwnedOperation(dependencies, operationId, input.scope);
  if (operation === undefined) {return { status: "not_found" };}
  const observed = { operation, status: "observed" as const };
  if (observed.operation.terminal.kind === "final") {return observed;}
  if (observed.operation.cancellation.kind === "requested") {
    return { operation: await resumeContainedTurnCancellation(dependencies, operation, input.scope), status: "observed" };
  }
  const prepared = await dependencies.operationStore.prepareCancellation({
    authority: containedTurnOwnerStoreAuthority(observed.operation, input.scope),
    operation: observed.operation,
  });
  let cancellationBase = observed.operation;
  let current: ContainedTurnKernelOperation;
  while (true) {
    const next = mutateContainedTurnOperation(cancellationBase, {
      command: prepared.command,
      cutoffProof: prepared.cutoffProof,
      kind: "request_cancellation",
      proof: prepared.proof,
    });
    const result = sanitizeContainedTurnOwnerStoreOutcome({
      authority: containedTurnOwnerStoreAuthority(cancellationBase, input.scope),
      outcome: await dependencies.operationStore.requestCancellation({
        authority: containedTurnOwnerStoreAuthority(cancellationBase, input.scope),
        candidate: next,
        command: prepared.command,
        expectedRevision: cancellationBase.revision,
      }),
    });
    if (result.kind === "not_found") {return { status: "not_found" };}
    if (result.kind === "indeterminate") {
      return { operation: durableContainedTurnDebtOperation(result), status: "observed" };
    }
    if (result.kind === "applied") {
      current = result.operation;
      break;
    }
    if (result.current.cancellation.kind === "requested" || result.current.terminal.kind === "final") {
      current = result.current;
      break;
    }
    cancellationBase = result.current;
  }
  return { operation: await resumeContainedTurnCancellation(dependencies, current, input.scope), status: "observed" };
};

/** Resume closure from the durable command without accepting a second cancellation. */
export const resumeContainedTurnCancellation = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (operation.terminal.kind === "final" || operation.cancellation.kind !== "requested") {return operation;}
  let current = operation;
  try {
    if (current.dispatch.kind === "unclaimed" && current.workspaceId === undefined) {
      current = await bindContainedTurnCancellationWorkspace(dependencies, current, trustedScope);
    }
    if (current.dispatch.kind === "unclaimed" && current.workspaceId !== undefined) {
      const preventionProofId = containedTurnIdentity("proof", `proof:cancellation-prevention:${digestContainedTurnCanonicalValue({
        cancellationCommandId: operation.cancellation.command.cancellationCommandId,
        cancellationProofId: operation.cancellation.proofId,
        operationId: operation.operationId,
      })}`);
      const proofs = await dependencies.operationStore.proofsForPrevention({
        authority: containedTurnOwnerStoreAuthority(current, trustedScope),
        operation: current,
        preventionProofId,
      });
      if (proofs.noDispatchProof.proofId !== preventionProofId) {
        throw new TypeError("cancellation prevention must preserve the exact authority proof identity");
      }
      current = await advanceContainedTurn(dependencies, current, trustedScope, {
        ...proofs,
        kind: "prevent_dispatch",
      });
    }
    if (current.dispatch.kind === "prevented") {
      current = await closeContainedTurnWithoutExecution(dependencies, current, trustedScope);
    } else if (current.dispatch.kind === "claimed" && current.custodyId !== undefined &&
        current.physicalContainment.kind !== "contained") {
      current = await closeContainedTurnPhysicalContainment(dependencies, current, trustedScope);
    }
  } catch (error) {
    if (error instanceof ContainedTurnIndeterminateCommitError) {current = error.operation;}
    else if (error instanceof ContainedTurnCasLostError) {
      current = await readContainedTurnOwnedOperation(dependencies, operation.operationId, trustedScope) ?? current;
    } else {
      current = await recordContainedTurnRejectedDebt(
        dependencies,
        current,
        trustedScope,
        "cancellation_closure_rejected",
        "store_commit",
      );
    }
  }
  return current;
};
