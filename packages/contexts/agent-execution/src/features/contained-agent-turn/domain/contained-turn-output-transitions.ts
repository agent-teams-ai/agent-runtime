import type { ContainedTurnEvidenceId } from "./contained-turn-identities.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
} from "./contained-turn-kernel-model.js";
import { nextContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import {
  assertContainedTurnExactRecord,
  detachAndFreezeContainedTurnValue,
} from "./contained-turn-record.js";
import { validateContainedTurnOperation } from "./contained-turn-validation.js";

export const closeOperationCutoffForContinuity = (
  operation: ContainedTurnKernelOperation,
  evidenceId: ContainedTurnEvidenceId,
): ContainedTurnKernelOperation["operationCutoff"] => {
  const revision = nextContainedTurnOperationCutoffRevision(operation.operationCutoff.revision);
  if (operation.operationCutoff.kind === "open" || operation.operationCutoff.reason === "continuity_lost") {
    return { evidenceId, kind: "closed", reason: "continuity_lost", revision };
  }
  return { ...operation.operationCutoff, revision };
};

/**
 * Owner-store-only output transition. Callers first win the atomic
 * scope/revision/cursor/private-authority predicate used by `appendOutput`.
 */
export const appendContainedTurnOutputForOwnerStore = (
  operation: ContainedTurnKernelOperation,
  output: ContainedTurnKernelOutputChunk,
): ContainedTurnKernelOperation => {
  assertContainedTurnExactRecord("output chunk", output, ["cursor", "kind", "text"]);
  invariant(
    operation.dispatch.kind === "claimed" && operation.operationCutoff.kind === "open" &&
      operation.operationCutoff.revision === operation.dispatch.operationCutoffRevision &&
      operation.output.fence.kind === "open" && operation.providerProcessStart.kind === "execution_started" &&
      operation.providerExecution.kind === "active" && operation.terminal.kind === "open",
    "canonical output append requires current active execution authority",
  );
  invariant(
    output.cursor === operation.output.chunks.length,
    "canonical output cursor must be the contiguous next cursor",
  );
  const candidate: ContainedTurnKernelOperation = {
    ...operation,
    output: { chunks: [...operation.output.chunks, output], fence: operation.output.fence },
    revision: operation.revision + 1,
  };
  validateContainedTurnOperation(candidate, { previous: operation });
  return detachAndFreezeContainedTurnValue(candidate);
};
