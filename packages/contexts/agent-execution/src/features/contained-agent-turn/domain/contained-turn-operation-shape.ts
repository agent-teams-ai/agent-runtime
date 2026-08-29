import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import { assertContainedTurnExactRecord } from "./contained-turn-record.js";

const exactKeys = (name: string, value: object, expected: readonly string[]): void => {
  assertContainedTurnExactRecord(name, value, expected);
};

/** Rejects object-spread leakage before semantic validation or persistence. */
// The count exhaustively mirrors closed orthogonal record variants, not lifecycle transitions.
// oxlint-disable-next-line complexity
export const validateContainedTurnOperationShape = (operation: ContainedTurnKernelOperation): void => {
  const operationKeys = [
    "acceptedAuthorityVector", "acceptedAuthorityVectorDigest", "adapterSnapshot", "admissionFence",
    "cancellation", "capabilityManifest", "commandFingerprint", "commandId", "containment", "dispatch",
    "effect", "effectId", "intent", "operationId", "output", "proofs", "providerAcceptance",
    "providerAccessSnapshot", "providerExecution", "providerProcessStart", "reconciliation", "revision",
    "schemaVersion", "scope", "terminal",
  ];
  if (operation.artifactManifestRef !== undefined) {operationKeys.push("artifactManifestRef");}
  if (operation.custodyId !== undefined) {operationKeys.push("custodyId");}
  if (operation.hostBootId !== undefined) {operationKeys.push("hostBootId");}
  if (operation.hostInstanceId !== undefined) {operationKeys.push("hostInstanceId");}
  if (operation.resultRef !== undefined) {operationKeys.push("resultRef");}
  if (operation.workspaceId !== undefined) {operationKeys.push("workspaceId");}
  exactKeys("contained-turn operation", operation, operationKeys);

  invariant(
    operation.admissionFence.kind === "open" || operation.admissionFence.kind === "fenced",
    "unknown admission-fence state fails closed",
  );
  exactKeys("admission fence", operation.admissionFence,
    operation.admissionFence.kind === "open" ? ["kind"] : ["kind", "proofId"]);
  invariant(
    operation.cancellation.kind === "open" || operation.cancellation.kind === "requested",
    "unknown cancellation state fails closed",
  );
  exactKeys("cancellation state", operation.cancellation,
    operation.cancellation.kind === "open" ? ["kind"] : ["command", "kind", "proofId"]);
  switch (operation.containment.kind) {
    case "not_requested": exactKeys("containment state", operation.containment, ["kind"]); break;
    case "pending": exactKeys("containment state", operation.containment, ["attemptId", "kind"]); break;
    case "contained":
    case "qualified_not_required": exactKeys("containment state", operation.containment, ["kind", "proofId"]); break;
    case "uncertain": exactKeys("containment state", operation.containment, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown containment state fails closed");
  }
  switch (operation.dispatch.kind) {
    case "unclaimed": exactKeys("dispatch state", operation.dispatch, ["kind"]); break;
    case "claimed": exactKeys("dispatch state", operation.dispatch, [
      "attemptId", "claimProofId", "kind", "providerAccessDispatchProofId", "runtimeSecurityDispatchProofId",
    ]); break;
    case "prevented": exactKeys("dispatch state", operation.dispatch, ["kind", "noDispatchProofId"]); break;
    default: invariant(false, "unknown dispatch state fails closed");
  }
  switch (operation.effect.kind) {
    case "unresolved": exactKeys("effect state", operation.effect, ["kind"]); break;
    case "resolved": exactKeys("effect state", operation.effect, ["disposition", "kind", "proofId"]); break;
    case "ambiguous": exactKeys("effect state", operation.effect, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown effect state fails closed");
  }
  exactKeys("output state", operation.output, ["chunks", "fence"]);
  invariant(
    operation.output.fence.kind === "open" || operation.output.fence.kind === "fenced",
    "unknown output-fence state fails closed",
  );
  exactKeys("output fence", operation.output.fence,
    operation.output.fence.kind === "open"
      ? ["kind"]
      : operation.output.fence.proofId === undefined
        ? ["finalCursor", "kind"]
        : ["finalCursor", "kind", "proofId"]);
  switch (operation.providerProcessStart.kind) {
    case "unobserved": exactKeys("provider-process-start state", operation.providerProcessStart, ["kind"]); break;
    case "pending": exactKeys("provider-process-start state", operation.providerProcessStart, ["attemptId", "kind"]); break;
    case "execution_started":
    case "proved_no_start": exactKeys("provider-process-start state", operation.providerProcessStart, ["kind", "proofId"]); break;
    case "unknown": exactKeys("provider-process-start state", operation.providerProcessStart, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown provider-process-start state fails closed");
  }
  switch (operation.providerAcceptance.kind) {
    case "unobserved": exactKeys("provider-acceptance state", operation.providerAcceptance, ["kind"]); break;
    case "accepted":
    case "not_accepted": exactKeys("provider-acceptance state", operation.providerAcceptance, ["kind", "proofId"]); break;
    case "unknown": exactKeys("provider-acceptance state", operation.providerAcceptance, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown provider-acceptance state fails closed");
  }
  switch (operation.providerExecution.kind) {
    case "not_started": exactKeys("provider-execution state", operation.providerExecution, ["kind"]); break;
    case "active": exactKeys("provider-execution state", operation.providerExecution, ["attemptId", "kind"]); break;
    case "closed": exactKeys("provider-execution state", operation.providerExecution, ["kind", "outcome", "proofId"]); break;
    case "unknown": exactKeys("provider-execution state", operation.providerExecution, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown provider-execution state fails closed");
  }
  invariant(
    operation.reconciliation.kind === "clear" || operation.reconciliation.kind === "required",
    "unknown reconciliation state fails closed",
  );
  exactKeys("reconciliation state", operation.reconciliation,
    operation.reconciliation.kind === "clear" ? ["kind"] : ["evidenceIds", "kind"]);
  invariant(operation.terminal.kind === "open" || operation.terminal.kind === "final", "unknown terminal state fails closed");
  exactKeys("terminal state", operation.terminal,
    operation.terminal.kind === "open"
      ? ["kind"]
      : ["kind", "outcome", "satisfactionDigest", "terminalProofId"]);
};
