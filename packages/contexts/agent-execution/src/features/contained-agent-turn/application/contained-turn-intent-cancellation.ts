import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { validateContainedTurnPreventionCommand, validateContainedTurnPreventionReceipt, type ContainedTurnPreventionCommand } from "../domain/contained-turn-intent-guard.js";
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";
import type { ContainedTurnKernelOperationStore } from "./ports/outbound/contained-turn-operation-store.js";

/** Trusted owner-private cancellation input. No operation reference exists before acceptance. */
export interface ContainedTurnIntentCancellationInput {
  readonly prevention: ContainedTurnPreventionCommand;
  /** Independently authenticated by the calling composition root. */
  readonly scope: ContainedTurnScope;
}
export type ContainedTurnIntentCancellationOutcome = Awaited<ReturnType<ContainedTurnKernelOperationStore["preventIntent"]>>;

export const preventContainedTurnIntent = async (
  store: ContainedTurnKernelOperationStore,
  raw: ContainedTurnIntentCancellationInput,
): Promise<ContainedTurnIntentCancellationOutcome> => {
  assertContainedTurnExactRecord("intent cancellation", raw, ["prevention", "scope"]);
  validateContainedTurnPreventionCommand(raw.prevention);
  assertContainedTurnExactRecord("trusted cancellation scope", raw.scope, ["projectId", "tenantId"]);
  if (raw.prevention.scope.tenantId !== raw.scope.tenantId ||
      raw.prevention.scope.projectId !== raw.scope.projectId) {return { kind: "denied" };}
  const input = detachAndFreezeContainedTurnValue(raw);
  const outcome = await store.preventIntent({ command: input.prevention, scope: input.scope });
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
  return Object.freeze({ kind: "committed", receipt });
};
