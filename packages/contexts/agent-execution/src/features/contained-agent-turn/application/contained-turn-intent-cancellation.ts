import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { validateContainedTurnPreventionCommand, validateContainedTurnPreventionReceipt, type ContainedTurnPreventionCommand } from "../domain/contained-turn-intent-guard.js";
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";
import type { ContainedTurnKernelOperationStore } from "./ports/outbound/contained-turn-operation-store.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";
import { readContainedTurnOwnedOperation } from "./contained-turn-closure.js";
import { resumeContainedTurnCancellation } from "./contained-turn-cancellation.js";

/** Trusted owner-private cancellation input. No operation reference exists before acceptance. */
export interface ContainedTurnIntentCancellationInput {
  readonly prevention: ContainedTurnPreventionCommand;
  /** Independently authenticated by the calling composition root. */
  readonly scope: ContainedTurnScope;
}
export type ContainedTurnIntentCancellationOutcome = Awaited<ReturnType<ContainedTurnKernelOperationStore["preventIntent"]>>;

export const preventContainedTurnIntent = async (
  dependencies: ContainedTurnKernelDependencies,
  raw: ContainedTurnIntentCancellationInput,
): Promise<ContainedTurnIntentCancellationOutcome> => {
  assertContainedTurnExactRecord("intent cancellation", raw, ["prevention", "scope"]);
  validateContainedTurnPreventionCommand(raw.prevention);
  assertContainedTurnExactRecord("trusted cancellation scope", raw.scope, ["projectId", "tenantId"]);
  if (raw.prevention.scope.tenantId !== raw.scope.tenantId ||
      raw.prevention.scope.projectId !== raw.scope.projectId) {return { kind: "denied" };}
  const input = detachAndFreezeContainedTurnValue(raw);
  const outcome = await dependencies.operationStore.preventIntent({ command: input.prevention, scope: input.scope });
  if (outcome.kind !== "committed") {
    assertContainedTurnExactRecord("intent cancellation outcome", outcome, ["kind"]);
    if (!["conflict", "denied", "indeterminate"].includes(outcome.kind)) {throw new TypeError("invalid intent cancellation outcome");}
    return Object.freeze({ kind: outcome.kind });
  }
  assertContainedTurnExactRecord("intent cancellation outcome", outcome, ["kind", "receipt"]);
  const receipt = validateContainedTurnPreventionReceipt(outcome.receipt);
  if (receipt.command.preventionDigest !== input.prevention.preventionDigest) {
    throw new TypeError("intent cancellation receipt does not match the authenticated command");
  }
  if (receipt.operationId !== null && receipt.disposition !== "already_terminal") {
    const current = await readContainedTurnOwnedOperation(dependencies, receipt.operationId, input.scope);
    if (current !== undefined) {
      if (current.commandId !== input.prevention.commandId || current.commandFingerprint !== input.prevention.commandFingerprint) {
        throw new TypeError("intent cancellation operation does not match the authenticated command");
      }
      await resumeContainedTurnCancellation(dependencies, current, input.scope);
    }
  }
  return Object.freeze({ kind: "committed", receipt });
};
