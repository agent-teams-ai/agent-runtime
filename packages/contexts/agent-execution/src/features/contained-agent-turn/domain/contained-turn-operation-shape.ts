import type { ContainedTurnProofRecord } from "./contained-turn-proof-validation.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import { assertContainedTurnCanonicalArray, assertContainedTurnDataRecord, assertContainedTurnExactRecord } from "./contained-turn-record.js";

const exactKeys = (name: string, value: unknown, expected: readonly string[]): void => {
  assertContainedTurnExactRecord(name, value, expected);
};

/** Keeps only discriminants and record containers checked by this phase. */
type VariantShape<Value> = Value extends { readonly kind: unknown }
  ? { readonly [Key in keyof Value]: Key extends "kind" | "reason" | "stage"
    ? Value[Key]
    : Key extends "fact"
      ? { readonly [Field in keyof Value[Key]]: unknown }
      : unknown }
  : never;
type StateKey = "admissionFence" | "cancellation" | "closureRecovery" | "containment" | "dispatch" |
  "operationCutoff" | "effect" | "providerProcessStart" | "physicalContainment" |
  "providerAcceptance" | "providerExecution" | "reconciliation" | "terminal";

export type ContainedTurnOperationShape = {
  readonly [Key in keyof ContainedTurnKernelOperation]: Key extends StateKey
    ? VariantShape<ContainedTurnKernelOperation[Key]>
    : Key extends "output"
      ? { readonly chunks: unknown; readonly fence: VariantShape<ContainedTurnKernelOperation["output"]["fence"]> }
      : unknown;
};

function validateOperationRecord(operation: unknown): asserts operation is Record<string, unknown> {
  assertContainedTurnDataRecord("contained-turn operation", operation);
  const operationKeys = [
    "acceptedAuthorityVector", "acceptedAuthorityVectorDigest", "adapterSnapshot", "admissionFence",
    "cancellation", "capabilityManifest", "closureRecovery", "commandFingerprint", "commandId", "containment", "dispatch",
    "effect", "effectId", "intent", "operationCutoff", "operationId", "output", "physicalContainment", "proofs",
    "providerAcceptance", "providerAccessSnapshot", "providerExecution", "providerProcessStart", "reconciliation",
    "requiredReceiptSet", "requiredReceiptSetDigest", "revision", "schemaVersion", "scope", "terminal",
  ];
  if (operation.artifactManifestRef !== undefined) {operationKeys.push("artifactManifestRef");}
  if (operation.custodyId !== undefined) {operationKeys.push("custodyId");}
  if (operation.hostBootId !== undefined) {operationKeys.push("hostBootId");}
  if (operation.hostInstanceId !== undefined) {operationKeys.push("hostInstanceId");}
  if (operation.resultRef !== undefined) {operationKeys.push("resultRef");}
  if (operation.workspaceId !== undefined) {operationKeys.push("workspaceId");}
  exactKeys("contained-turn operation", operation, operationKeys);
}

/** Rejects object-spread leakage before semantic validation or persistence. */
// The count exhaustively mirrors closed orthogonal record variants, not lifecycle transitions.
// oxlint-disable-next-line complexity
export function validateContainedTurnOperationShape(operation: unknown): asserts operation is ContainedTurnOperationShape {
  validateOperationRecord(operation);

  assertContainedTurnDataRecord("admissionFence state", operation.admissionFence);
  invariant(
    operation.admissionFence.kind === "open" || operation.admissionFence.kind === "fenced",
    "unknown admission-fence state fails closed",
  );
  exactKeys("admission fence", operation.admissionFence,
    operation.admissionFence.kind === "open" ? ["kind"] : ["kind", "proofId"]);
  assertContainedTurnDataRecord("cancellation state", operation.cancellation);
  invariant(
    operation.cancellation.kind === "open" || operation.cancellation.kind === "requested",
    "unknown cancellation state fails closed",
  );
  exactKeys("cancellation state", operation.cancellation,
    operation.cancellation.kind === "open" ? ["kind"] : ["command", "kind", "proofId"]);
  assertContainedTurnDataRecord("closureRecovery state", operation.closureRecovery);
  invariant(
    operation.closureRecovery.kind === "clear" || operation.closureRecovery.kind === "required" ||
      operation.closureRecovery.kind === "proved_no_workspace",
    "unknown closure-recovery state fails closed",
  );
  exactKeys(
    "closure recovery",
    operation.closureRecovery,
    operation.closureRecovery.kind === "clear"
      ? ["kind"]
      : operation.closureRecovery.kind === "proved_no_workspace"
        ? ["fact", "kind"]
        : ["debtId", "evidenceIds", "kind", "requestDigest", "requestId", "stage"],
  );
  if (operation.closureRecovery.kind === "required") {
    const closureStage = operation.closureRecovery.stage;
    invariant(["physical_containment", "artifact_seal", "workspace_close", "containment_attestation", "no_workspace"]
      .some(stage => stage === closureStage), "unknown closure-recovery stage fails closed");
  }
  if (operation.closureRecovery.kind === "proved_no_workspace") {
    exactKeys("no-workspace closure fact", operation.closureRecovery.fact, [
      "authorityVectorDigest", "cancellationCommandId", "containmentProofId", "effectProofId",
      "factDigest", "hostCustodyProofId", "noDispatchProofId", "noStartProofId", "operationId", "outputProofId",
      "providerProofId", "scopeDigest", "version",
    ]);
  }
  assertContainedTurnDataRecord("containment state", operation.containment);
  switch (operation.containment.kind) {
    case "not_requested": exactKeys("containment state", operation.containment, ["kind"]); break;
    case "pending": exactKeys("containment state", operation.containment, ["attemptId", "kind"]); break;
    case "contained":
    case "qualified_not_required": exactKeys("containment state", operation.containment, ["kind", "proofId"]); break;
    case "uncertain": exactKeys("containment state", operation.containment, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown containment state fails closed");
  }
  assertContainedTurnDataRecord("dispatch state", operation.dispatch);
  switch (operation.dispatch.kind) {
    case "unclaimed": exactKeys("dispatch state", operation.dispatch, ["kind"]); break;
    case "claimed": exactKeys("dispatch state", operation.dispatch, [
      "attemptId", "claimProofId", "executionGenerationId", "grantReceipts", "kind", "operationCutoffRevision",
      "preparationToken", "providerAccessDispatchProofId", "runtimeSecurityDispatchProofId", "writerFence",
    ]); break;
    case "prevented": exactKeys("dispatch state", operation.dispatch, ["kind", "noDispatchProofId"]); break;
    default: invariant(false, "unknown dispatch state fails closed");
  }
  assertContainedTurnDataRecord("operationCutoff state", operation.operationCutoff);
  invariant(operation.operationCutoff.kind === "open" || operation.operationCutoff.kind === "closed",
    "unknown operation-cutoff state fails closed");
  if (operation.operationCutoff.kind === "open") {
    exactKeys("operation cutoff", operation.operationCutoff, ["kind", "revision"]);
  } else if (operation.operationCutoff.reason === "continuity_lost") {
    exactKeys("operation cutoff", operation.operationCutoff, ["evidenceId", "kind", "reason", "revision"]);
  } else {
    invariant(
      operation.operationCutoff.reason === "cancellation" || operation.operationCutoff.reason === "prevention",
      "unknown operation-cutoff reason fails closed",
    );
    exactKeys("operation cutoff", operation.operationCutoff, ["kind", "proofId", "reason", "revision"]);
  }
  assertContainedTurnDataRecord("effect state", operation.effect);
  switch (operation.effect.kind) {
    case "unresolved": exactKeys("effect state", operation.effect, ["kind"]); break;
    case "resolved": exactKeys("effect state", operation.effect, ["disposition", "kind", "proofId"]); break;
    case "ambiguous": exactKeys("effect state", operation.effect, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown effect state fails closed");
  }
  assertContainedTurnDataRecord("output state", operation.output);
  exactKeys("output state", operation.output, ["chunks", "fence"]);
  assertContainedTurnDataRecord("output fence", operation.output.fence);
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
  assertContainedTurnDataRecord("providerProcessStart state", operation.providerProcessStart);
  switch (operation.providerProcessStart.kind) {
    case "unobserved": exactKeys("provider-process-start state", operation.providerProcessStart, ["kind"]); break;
    case "pending": exactKeys("provider-process-start state", operation.providerProcessStart, ["attemptId", "kind"]); break;
    case "execution_started":
    case "proved_no_start": exactKeys("provider-process-start state", operation.providerProcessStart, ["kind", "proofId"]); break;
    case "unknown": exactKeys("provider-process-start state", operation.providerProcessStart, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown provider-process-start state fails closed");
  }
  assertContainedTurnDataRecord("physicalContainment state", operation.physicalContainment);
  switch (operation.physicalContainment.kind) {
    case "not_requested": exactKeys("physical containment state", operation.physicalContainment, ["kind"]); break;
    case "pending": exactKeys("physical containment state", operation.physicalContainment, ["attemptId", "kind"]); break;
    case "contained": exactKeys("physical containment state", operation.physicalContainment, ["kind", "proofId"]); break;
    case "uncertain": exactKeys("physical containment state", operation.physicalContainment, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown physical-containment state fails closed");
  }
  assertContainedTurnDataRecord("providerAcceptance state", operation.providerAcceptance);
  switch (operation.providerAcceptance.kind) {
    case "unobserved": exactKeys("provider-acceptance state", operation.providerAcceptance, ["kind"]); break;
    case "accepted":
    case "not_accepted": exactKeys("provider-acceptance state", operation.providerAcceptance, ["kind", "proofId"]); break;
    case "unknown": exactKeys("provider-acceptance state", operation.providerAcceptance, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown provider-acceptance state fails closed");
  }
  assertContainedTurnDataRecord("providerExecution state", operation.providerExecution);
  switch (operation.providerExecution.kind) {
    case "not_started": exactKeys("provider-execution state", operation.providerExecution, ["kind"]); break;
    case "active": exactKeys("provider-execution state", operation.providerExecution, ["attemptId", "kind"]); break;
    case "closed": exactKeys("provider-execution state", operation.providerExecution, ["kind", "outcome", "proofId"]); break;
    case "unknown": exactKeys("provider-execution state", operation.providerExecution, ["evidenceId", "kind"]); break;
    default: invariant(false, "unknown provider-execution state fails closed");
  }
  assertContainedTurnDataRecord("reconciliation state", operation.reconciliation);
  invariant(
    operation.reconciliation.kind === "clear" || operation.reconciliation.kind === "required",
    "unknown reconciliation state fails closed",
  );
  exactKeys("reconciliation state", operation.reconciliation,
    operation.reconciliation.kind === "clear" ? ["kind"] : ["evidenceIds", "kind"]);
  assertContainedTurnDataRecord("terminal state", operation.terminal);
  invariant(operation.terminal.kind === "open" || operation.terminal.kind === "final", "unknown terminal state fails closed");
  exactKeys("terminal state", operation.terminal,
    operation.terminal.kind === "open"
      ? ["kind"]
      : ["kind", "outcome", "satisfactionDigest", "terminalProofId"]);
}

type EvidenceCollections<Value> = Value extends { readonly kind: unknown }
  ? { readonly [Key in keyof Value]: Key extends "evidenceIds" ? readonly unknown[] : Value[Key] }
  : never;
export type ContainedTurnOperationCollections = Omit<ContainedTurnOperationShape, "proofs" | "output" | "reconciliation" | "closureRecovery"> & {
  readonly proofs: readonly unknown[];
  readonly output: Omit<ContainedTurnOperationShape["output"], "chunks"> & { readonly chunks: readonly unknown[] };
  readonly reconciliation: EvidenceCollections<ContainedTurnOperationShape["reconciliation"]>;
  readonly closureRecovery: EvidenceCollections<ContainedTurnOperationShape["closureRecovery"]>;
};

export function validateContainedTurnOperationCollections(operation: ContainedTurnOperationShape): asserts operation is ContainedTurnOperationCollections {
  assertContainedTurnCanonicalArray(operation.proofs);
  assertContainedTurnCanonicalArray(operation.output.chunks);
  if (operation.reconciliation.kind === "required") {
    assertContainedTurnCanonicalArray(operation.reconciliation.evidenceIds);
  }
  if (operation.closureRecovery.kind === "required") {
    assertContainedTurnCanonicalArray(operation.closureRecovery.evidenceIds);
  }
}


export function validateContainedTurnOperationProofRecords(
  operation: Readonly<{ proofs: readonly unknown[] }>,
): asserts operation is Readonly<{ proofs: readonly ContainedTurnProofRecord[] }> {
  for (const proof of operation.proofs) {assertContainedTurnDataRecord("contained-turn proof", proof);}
}
