import type {
  ContainedTurnOutputKind,
  ContainedTurnProviderBinding,
  ContainedTurnScope,
  ContainedTurnStatus,
  ContainedTurnView,
} from "../contracts/contained-agent-turn.js";
import {
  isContainmentMutation,
  isDispatchMutation,
  isEffectMutation,
  isOutputMutation,
  isProviderMutation,
  isWorkspaceMutation,
  type ContainmentMutation,
  type DispatchMutation,
  type EffectMutation,
  type OutputMutation,
  type ProviderMutation,
  type PublicationMutation,
  type WorkspaceMutation,
} from "./contained-turn-mutation-groups.js";

export const CONTAINED_TURN_REQUIRED_RECEIPTS = Object.freeze([
  "command_acceptance",
  "dispatch_claim_or_proved_no_dispatch",
  "provider_execution_closure_or_proved_no_start",
  "provider_terminal_observation_or_proved_no_start",
  "output_drain_and_fence_closure",
  "host_custody",
  "workspace_closure",
  "artifact_manifest_seal",
  "coarse_effect_resolution_or_reconciliation_debt",
  "containment_execution",
  "canonical_result_publication",
  "cutoff_enforcement_when_applicable",
] as const);

export type ContainedTurnRequiredReceipt =
  (typeof CONTAINED_TURN_REQUIRED_RECEIPTS)[number];

export interface ContainedTurnReceipt {
  readonly kind: ContainedTurnRequiredReceipt;
  readonly receiptRef: string;
}

export interface ContainedTurnOperation {
  readonly artifact: { readonly kind: "open" } | { readonly kind: "sealed"; readonly manifestRef: string };
  readonly cancellation: { readonly kind: "open" } | { readonly kind: "requested"; readonly requestRef: string };
  readonly commandFingerprint: string;
  readonly commandId: string;
  readonly cutoff:
    | { readonly kind: "pending" }
    | { readonly disposition: "enforced" | "not_applicable"; readonly kind: "closed"; readonly receiptRef: string };
  readonly containment:
    | { readonly kind: "not_required" }
    | { readonly kind: "pending" }
    | { readonly kind: "contained"; readonly receiptRef: string }
    | { readonly kind: "unproven"; readonly evidenceRef: string };
  readonly dispatch:
    | { readonly kind: "unclaimed" }
    | { readonly attemptId: string; readonly claimRef: string; readonly kind: "claimed" }
    | { readonly kind: "prevented"; readonly receiptRef: string };
  readonly effect:
    | { readonly kind: "unresolved" }
    | { readonly disposition: "committed" | "not_committed"; readonly kind: "resolved"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "ambiguous" };
  readonly effectId: string;
  readonly execution:
    | { readonly kind: "not_started" }
    | { readonly kind: "running" }
    | { readonly kind: "closed"; readonly outcome: "cancelled" | "failed" | "succeeded"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "unknown" };
  readonly intent: { readonly mode: "analysis" | "workspace-write"; readonly prompt: string };
  readonly operationId: string;
  readonly output: {
    readonly chunks: readonly { readonly cursor: number; readonly kind: ContainedTurnOutputKind; readonly text: string }[];
    readonly kind: "open" | "sealed";
    readonly nextCursor: number;
    readonly sealReceiptRef?: string;
  };
  readonly providerAcceptance:
    | { readonly kind: "unobserved" }
    | { readonly kind: "accepted"; readonly receiptRef: string }
    | { readonly kind: "not_accepted"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "unknown" };
  readonly providerBinding: ContainedTurnProviderBinding;
  readonly receipts: readonly ContainedTurnReceipt[];
  readonly reconciliation: { readonly kind: "none" } | { readonly evidenceRef: string; readonly kind: "required" };
  readonly result: { readonly kind: "unpublished" } | { readonly kind: "published"; readonly resultRef: string };
  readonly revision: number;
  readonly scope: ContainedTurnScope;
  readonly securityDecision: { readonly authorityRevision: string; readonly decisionDigest: string };
  readonly terminal:
    | { readonly kind: "nonterminal" }
    | { readonly kind: "terminal"; readonly outcome: "cancelled" | "failed" | "succeeded"; readonly receiptRef: string };
  readonly workspace:
    | { readonly kind: "unbound" }
    | { readonly kind: "bound"; readonly workspaceRef: string }
    | { readonly kind: "closed"; readonly receiptRef: string; readonly workspaceRef: string }
    | { readonly evidenceRef: string; readonly kind: "quarantined"; readonly workspaceRef: string };
}

export interface CreateAcceptedContainedTurnOperationInput {
  readonly acceptanceReceiptRef: string;
  readonly commandFingerprint: string;
  readonly commandId: string;
  readonly effectId: string;
  readonly intent: ContainedTurnOperation["intent"];
  readonly operationId: string;
  readonly providerBinding: ContainedTurnProviderBinding;
  readonly scope: ContainedTurnScope;
  readonly securityDecision: ContainedTurnOperation["securityDecision"];
}

export type ContainedTurnMutation =
  | { readonly kind: "workspace_bound"; readonly workspaceRef: string }
  | { readonly kind: "workspace_closed"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "workspace_quarantined" }
  | { readonly kind: "dispatch_prevented"; readonly receiptRef: string }
  | { readonly attemptId: string; readonly claimRef: string; readonly cutoffReceiptRef: string; readonly kind: "dispatch_claimed" }
  | { readonly kind: "provider_accepted"; readonly receiptRef: string }
  | { readonly kind: "provider_not_accepted"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "provider_acceptance_unknown" }
  | { readonly cursor: number; readonly kind: "output_appended"; readonly outputKind: ContainedTurnOutputKind; readonly text: string }
  | { readonly kind: "output_sealed"; readonly receiptRef: string }
  | { readonly kind: "cancellation_requested"; readonly requestRef: string }
  | { readonly kind: "execution_started" }
  | { readonly kind: "execution_closed"; readonly outcome: "cancelled" | "failed" | "succeeded"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "execution_unknown" }
  | { readonly kind: "containment_recorded"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "containment_unproven" }
  | { readonly disposition: "committed" | "not_committed"; readonly kind: "effect_resolved"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "effect_ambiguous" }
  | { readonly evidenceRef: string; readonly kind: "reconciliation_required" }
  | { readonly kind: "artifacts_sealed"; readonly manifestRef: string; readonly receiptRef: string }
  | { readonly kind: "result_published"; readonly receiptRef: string; readonly resultRef: string }
  | { readonly kind: "terminalize"; readonly receiptRef: string };

export class ContainedTurnTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContainedTurnTransitionError";
  }
}

const fail = (message: string): never => {
  throw new ContainedTurnTransitionError(message);
};

const addReceipt = (
  receipts: readonly ContainedTurnReceipt[],
  kind: ContainedTurnRequiredReceipt,
  receiptRef: string,
): readonly ContainedTurnReceipt[] => {
  const existing = receipts.find(candidate => candidate.kind === kind);
  if (existing !== undefined) {
    if (existing.receiptRef !== receiptRef) {fail(`receipt ${kind} already has different evidence`);}
    return receipts;
  }
  return Object.freeze([...receipts, Object.freeze({ kind, receiptRef })]);
};

const addReceipts = (
  receipts: readonly ContainedTurnReceipt[],
  additions: readonly (readonly [ContainedTurnRequiredReceipt, string])[],
): readonly ContainedTurnReceipt[] => additions.reduce(
  (current, [kind, ref]) => addReceipt(current, kind, ref),
  receipts,
);

const changed = (
  operation: ContainedTurnOperation,
  changes: Partial<ContainedTurnOperation>,
): ContainedTurnOperation => Object.freeze({ ...operation, ...changes, revision: operation.revision + 1 });

const requireAttempt = (operation: ContainedTurnOperation): void => {
  if (operation.dispatch.kind !== "claimed") {fail("provider transition requires a dispatch claim");}
};

const terminalOutcome = (operation: ContainedTurnOperation): "cancelled" | "failed" | "succeeded" => {
  if (operation.reconciliation.kind !== "none") {fail("an operation with reconciliation debt cannot terminalize");}
  if (operation.dispatch.kind === "unclaimed") {
    fail("terminalization requires exact dispatch closure");
  }
  const execution = operation.execution;
  if (execution.kind !== "closed") {
    fail("terminalization requires exact execution closure");
  }
  if (operation.providerAcceptance.kind === "unknown" || operation.providerAcceptance.kind === "unobserved") {
    fail("terminalization requires exact provider acceptance evidence");
  }
  const containmentClosed =
    (operation.dispatch.kind === "claimed" && operation.containment.kind === "contained") ||
    (operation.dispatch.kind === "prevented" && operation.containment.kind === "not_required");
  if (
    !containmentClosed || operation.output.kind !== "sealed" || operation.workspace.kind !== "closed" ||
    operation.artifact.kind !== "sealed" || operation.cutoff.kind !== "closed" ||
    operation.effect.kind !== "resolved" || operation.result.kind !== "published"
  ) {fail("terminalization requires containment, output, workspace, artifact, effect, and result closure");}
  for (const kind of CONTAINED_TURN_REQUIRED_RECEIPTS) {
    if (!operation.receipts.some(candidate => candidate.kind === kind)) {fail(`terminalization requires receipt ${kind}`);}
  }
  return execution.kind === "closed"
    ? execution.outcome
    : fail("terminalization requires exact execution closure");
};

export const createAcceptedContainedTurnOperation = (
  input: CreateAcceptedContainedTurnOperationInput,
): ContainedTurnOperation => Object.freeze({
  artifact: Object.freeze({ kind: "open" }),
  cancellation: Object.freeze({ kind: "open" }),
  commandFingerprint: input.commandFingerprint,
  commandId: input.commandId,
  cutoff: Object.freeze({ kind: "pending" }),
  containment: Object.freeze({ kind: "not_required" }),
  dispatch: Object.freeze({ kind: "unclaimed" }),
  effect: Object.freeze({ kind: "unresolved" }),
  effectId: input.effectId,
  execution: Object.freeze({ kind: "not_started" }),
  intent: Object.freeze({ ...input.intent }),
  operationId: input.operationId,
  output: Object.freeze({ chunks: Object.freeze([]), kind: "open", nextCursor: 0 }),
  providerAcceptance: Object.freeze({ kind: "unobserved" }),
  providerBinding: Object.freeze({ ...input.providerBinding }),
  receipts: Object.freeze([Object.freeze({ kind: "command_acceptance" as const, receiptRef: input.acceptanceReceiptRef })]),
  reconciliation: Object.freeze({ kind: "none" }),
  result: Object.freeze({ kind: "unpublished" }),
  revision: 0,
  scope: Object.freeze({ ...input.scope }),
  securityDecision: Object.freeze({ ...input.securityDecision }),
  terminal: Object.freeze({ kind: "nonterminal" }),
  workspace: Object.freeze({ kind: "unbound" }),
});

const applyWorkspaceMutation = (
  operation: ContainedTurnOperation,
  mutation: WorkspaceMutation,
): ContainedTurnOperation => {
  switch (mutation.kind) {
    case "workspace_bound":
      if (operation.workspace.kind !== "unbound" || operation.dispatch.kind !== "unclaimed") {return fail("workspace can bind exactly once before dispatch");}
      return changed(operation, { workspace: Object.freeze({ kind: "bound", workspaceRef: mutation.workspaceRef }) });
    case "workspace_closed":
      if (operation.workspace.kind !== "bound") {return fail("only a bound workspace can close");}
      return changed(operation, {
        receipts: addReceipt(operation.receipts, "workspace_closure", mutation.receiptRef),
        workspace: Object.freeze({ kind: "closed", receiptRef: mutation.receiptRef, workspaceRef: operation.workspace.workspaceRef }),
      });
    case "workspace_quarantined":
      if (operation.workspace.kind !== "bound") {return fail("only a bound workspace can be quarantined");}
      return changed(operation, {
        reconciliation: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "required" }),
        workspace: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "quarantined", workspaceRef: operation.workspace.workspaceRef }),
      });
  }
};

const applyDispatchMutation = (
  operation: ContainedTurnOperation,
  mutation: DispatchMutation,
): ContainedTurnOperation => {
  switch (mutation.kind) {
    case "dispatch_prevented":
      if (operation.dispatch.kind !== "unclaimed") {return fail("dispatch prevention must win before a claim");}
      return changed(operation, {
        containment: Object.freeze({ kind: "not_required" }),
        cutoff: Object.freeze({ disposition: "enforced", kind: "closed", receiptRef: mutation.receiptRef }),
        dispatch: Object.freeze({ kind: "prevented", receiptRef: mutation.receiptRef }),
        effect: Object.freeze({ disposition: "not_committed", kind: "resolved", receiptRef: mutation.receiptRef }),
        execution: Object.freeze({ kind: "closed", outcome: operation.cancellation.kind === "requested" ? "cancelled" : "failed", receiptRef: mutation.receiptRef }),
        providerAcceptance: Object.freeze({ kind: "not_accepted", receiptRef: mutation.receiptRef }),
        receipts: addReceipts(operation.receipts, [
          ["dispatch_claim_or_proved_no_dispatch", mutation.receiptRef],
          ["provider_execution_closure_or_proved_no_start", mutation.receiptRef],
          ["provider_terminal_observation_or_proved_no_start", mutation.receiptRef],
          ["host_custody", mutation.receiptRef],
          ["containment_execution", mutation.receiptRef],
          ["coarse_effect_resolution_or_reconciliation_debt", mutation.receiptRef],
          ["cutoff_enforcement_when_applicable", mutation.receiptRef],
        ]),
      });
    case "dispatch_claimed":
      if (operation.dispatch.kind !== "unclaimed" || operation.workspace.kind !== "bound") {return fail("dispatch requires one unclaimed operation with a bound workspace");}
      if (operation.cancellation.kind === "requested") {return fail("dispatch cannot claim after durable cancellation");}
      if (operation.cutoff.kind !== "pending") {return fail("dispatch claim must close cutoff exactly once");}
      return changed(operation, {
        containment: Object.freeze({ kind: "pending" }),
        cutoff: Object.freeze({ disposition: "not_applicable", kind: "closed", receiptRef: mutation.cutoffReceiptRef }),
        dispatch: Object.freeze({ attemptId: mutation.attemptId, claimRef: mutation.claimRef, kind: "claimed" }),
        receipts: addReceipts(operation.receipts, [
          ["dispatch_claim_or_proved_no_dispatch", mutation.claimRef],
          ["cutoff_enforcement_when_applicable", mutation.cutoffReceiptRef],
        ]),
      });
    case "cancellation_requested":
      if (operation.cancellation.kind === "requested") {
        if (operation.cancellation.requestRef !== mutation.requestRef) {return fail("cancellation already has different authority");}
        return operation;
      }
      return changed(operation, { cancellation: Object.freeze({ kind: "requested", requestRef: mutation.requestRef }) });
  }
};

const applyProviderMutation = (
  operation: ContainedTurnOperation,
  mutation: ProviderMutation,
): ContainedTurnOperation => {
  requireAttempt(operation);
  switch (mutation.kind) {
    case "provider_accepted":
    case "provider_not_accepted":
      if (operation.providerAcceptance.kind !== "unobserved") {return fail("provider acceptance can be observed once");}
      return changed(operation, { providerAcceptance: Object.freeze({ kind: mutation.kind === "provider_accepted" ? "accepted" : "not_accepted", receiptRef: mutation.receiptRef }) });
    case "provider_acceptance_unknown":
      return changed(operation, {
        providerAcceptance: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "unknown" }),
        reconciliation: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "required" }),
      });
    case "execution_started":
      if (operation.execution.kind !== "not_started") {return fail("execution can start once");}
      return changed(operation, { execution: Object.freeze({ kind: "running" }) });
    case "execution_closed":
      if (operation.execution.kind !== "running") {return fail("only running execution can close");}
      return changed(operation, {
        execution: Object.freeze({ kind: "closed", outcome: mutation.outcome, receiptRef: mutation.receiptRef }),
        receipts: addReceipts(operation.receipts, [
          ["provider_execution_closure_or_proved_no_start", mutation.receiptRef],
          ["provider_terminal_observation_or_proved_no_start", mutation.receiptRef],
        ]),
      });
    case "execution_unknown":
      return changed(operation, {
        execution: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "unknown" }),
        reconciliation: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "required" }),
      });
  }
};

const applyOutputMutation = (
  operation: ContainedTurnOperation,
  mutation: OutputMutation,
): ContainedTurnOperation => {
  switch (mutation.kind) {
    case "output_appended":
      requireAttempt(operation);
      if (operation.output.kind !== "open" || mutation.cursor !== operation.output.nextCursor) {return fail("output cursor is stale or output is sealed");}
      return changed(operation, { output: Object.freeze({ chunks: Object.freeze([...operation.output.chunks, Object.freeze({ cursor: mutation.cursor, kind: mutation.outputKind, text: mutation.text })]), kind: "open", nextCursor: mutation.cursor + 1 }) });
    case "output_sealed":
      if (operation.output.kind !== "open") {return fail("output can seal once");}
      return changed(operation, {
        output: Object.freeze({ ...operation.output, kind: "sealed", sealReceiptRef: mutation.receiptRef }),
        receipts: addReceipt(operation.receipts, "output_drain_and_fence_closure", mutation.receiptRef),
      });
  }
};

const applyContainmentMutation = (
  operation: ContainedTurnOperation,
  mutation: ContainmentMutation,
): ContainedTurnOperation => {
  requireAttempt(operation);
  switch (mutation.kind) {
    case "containment_recorded":
      if (operation.containment.kind !== "pending") {return fail("containment can close once after dispatch");}
      return changed(operation, {
        containment: Object.freeze({ kind: "contained", receiptRef: mutation.receiptRef }),
        receipts: addReceipts(operation.receipts, [["host_custody", mutation.receiptRef], ["containment_execution", mutation.receiptRef]]),
      });
    case "containment_unproven":
      return changed(operation, {
        containment: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "unproven" }),
        reconciliation: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "required" }),
      });
  }
};

const applyEffectMutation = (
  operation: ContainedTurnOperation,
  mutation: EffectMutation,
): ContainedTurnOperation => {
  switch (mutation.kind) {
    case "effect_resolved":
      if (operation.effect.kind !== "unresolved") {return fail("coarse effect can resolve once");}
      return changed(operation, {
        effect: Object.freeze({ disposition: mutation.disposition, kind: "resolved", receiptRef: mutation.receiptRef }),
        receipts: addReceipt(operation.receipts, "coarse_effect_resolution_or_reconciliation_debt", mutation.receiptRef),
      });
    case "effect_ambiguous":
      if (operation.effect.kind !== "unresolved") {return fail("coarse effect can become ambiguous once");}
      return changed(operation, {
        effect: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "ambiguous" }),
        reconciliation: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "required" }),
        receipts: addReceipt(operation.receipts, "coarse_effect_resolution_or_reconciliation_debt", mutation.evidenceRef),
      });
    case "reconciliation_required":
      return changed(operation, { reconciliation: Object.freeze({ evidenceRef: mutation.evidenceRef, kind: "required" }) });
  }
};

const applyPublicationMutation = (
  operation: ContainedTurnOperation,
  mutation: PublicationMutation,
): ContainedTurnOperation => {
  switch (mutation.kind) {
    case "artifacts_sealed":
      if (operation.artifact.kind !== "open") {return fail("artifact manifest can seal once");}
      return changed(operation, {
        artifact: Object.freeze({ kind: "sealed", manifestRef: mutation.manifestRef }),
        receipts: addReceipt(operation.receipts, "artifact_manifest_seal", mutation.receiptRef),
      });
    case "result_published":
      if (operation.result.kind !== "unpublished") {return fail("canonical result can publish once");}
      return changed(operation, {
        receipts: addReceipt(operation.receipts, "canonical_result_publication", mutation.receiptRef),
        result: Object.freeze({ kind: "published", resultRef: mutation.resultRef }),
      });
    case "terminalize": {
      const outcome = terminalOutcome(operation);
      return changed(operation, { terminal: Object.freeze({ kind: "terminal", outcome, receiptRef: mutation.receiptRef }) });
    }
  }
};

export const applyContainedTurnMutation = (
  operation: ContainedTurnOperation,
  mutation: ContainedTurnMutation,
): ContainedTurnOperation => {
  if (operation.terminal.kind === "terminal") {
    if (mutation.kind === "terminalize" && operation.terminal.receiptRef === mutation.receiptRef) {return operation;}
    return fail("terminal operation is immutable");
  }

  if (isWorkspaceMutation(mutation)) {return applyWorkspaceMutation(operation, mutation);}
  if (isDispatchMutation(mutation)) {return applyDispatchMutation(operation, mutation);}
  if (isProviderMutation(mutation)) {return applyProviderMutation(operation, mutation);}
  if (isOutputMutation(mutation)) {return applyOutputMutation(operation, mutation);}
  if (isContainmentMutation(mutation)) {return applyContainmentMutation(operation, mutation);}
  if (isEffectMutation(mutation)) {return applyEffectMutation(operation, mutation);}
  return applyPublicationMutation(operation, mutation);
};

export const containedTurnStatus = (operation: ContainedTurnOperation): ContainedTurnStatus => {
  if (operation.terminal.kind === "terminal") {return operation.terminal.outcome;}
  if (operation.reconciliation.kind === "required") {return "reconcile_required";}
  if (operation.dispatch.kind === "claimed") {return "running";}
  return "accepted";
};

export const containedTurnView = (operation: ContainedTurnOperation): ContainedTurnView => Object.freeze({
  ...(operation.artifact.kind === "sealed" ? { artifactManifestRef: operation.artifact.manifestRef } : {}),
  commandId: operation.commandId,
  effectId: operation.effectId,
  operationId: operation.operationId,
  output: Object.freeze(operation.output.chunks.map(chunk => Object.freeze({ ...chunk }))),
  provider: operation.providerBinding.provider,
  ...(operation.result.kind === "published" ? { resultRef: operation.result.resultRef } : {}),
  revision: operation.revision,
  status: containedTurnStatus(operation),
});
