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
import type { ContainedTurnMutation, ContainedTurnOperation } from "./contained-turn-operation.js";

const workspaceMutationSatisfied = (operation: ContainedTurnOperation, mutation: WorkspaceMutation): boolean => {
  switch (mutation.kind) {
    case "workspace_bound":
      return operation.workspace.kind !== "unbound" && operation.workspace.workspaceRef === mutation.workspaceRef;
    case "workspace_closed":
      return operation.workspace.kind === "closed" && operation.workspace.receiptRef === mutation.receiptRef;
    case "workspace_quarantined":
      return operation.workspace.kind === "quarantined" && operation.workspace.evidenceRef === mutation.evidenceRef;
  }
};

const dispatchMutationSatisfied = (operation: ContainedTurnOperation, mutation: DispatchMutation): boolean => {
  switch (mutation.kind) {
    case "dispatch_prevented":
      return operation.dispatch.kind === "prevented" && operation.dispatch.receiptRef === mutation.receiptRef;
    case "dispatch_claimed":
      return operation.dispatch.kind === "claimed" && operation.dispatch.attemptId === mutation.attemptId &&
        operation.dispatch.claimRef === mutation.claimRef && operation.cutoff.kind === "closed" &&
        operation.cutoff.receiptRef === mutation.cutoffReceiptRef;
    case "cancellation_requested":
      return operation.cancellation.kind === "requested" && operation.cancellation.requestRef === mutation.requestRef;
  }
};

const providerMutationSatisfied = (operation: ContainedTurnOperation, mutation: ProviderMutation): boolean => {
  switch (mutation.kind) {
    case "provider_accepted":
      return operation.providerAcceptance.kind === "accepted" && operation.providerAcceptance.receiptRef === mutation.receiptRef;
    case "provider_not_accepted":
      return operation.providerAcceptance.kind === "not_accepted" && operation.providerAcceptance.receiptRef === mutation.receiptRef;
    case "provider_acceptance_unknown":
      return operation.providerAcceptance.kind === "unknown" && operation.providerAcceptance.evidenceRef === mutation.evidenceRef;
    case "execution_started":
      return operation.execution.kind !== "not_started";
    case "execution_closed":
      return operation.execution.kind === "closed" && operation.execution.outcome === mutation.outcome && operation.execution.receiptRef === mutation.receiptRef;
    case "execution_unknown":
      return operation.execution.kind === "unknown" && operation.execution.evidenceRef === mutation.evidenceRef;
  }
};

const outputMutationSatisfied = (operation: ContainedTurnOperation, mutation: OutputMutation): boolean => {
  switch (mutation.kind) {
    case "output_appended": {
      const existing = operation.output.chunks[mutation.cursor];
      return existing?.cursor === mutation.cursor && existing.kind === mutation.outputKind && existing.text === mutation.text;
    }
    case "output_sealed":
      return operation.output.kind === "sealed" && operation.output.sealReceiptRef === mutation.receiptRef;
  }
};

const containmentMutationSatisfied = (operation: ContainedTurnOperation, mutation: ContainmentMutation): boolean => {
  switch (mutation.kind) {
    case "containment_recorded":
      return operation.containment.kind === "contained" && operation.containment.receiptRef === mutation.receiptRef;
    case "containment_unproven":
      return operation.containment.kind === "unproven" && operation.containment.evidenceRef === mutation.evidenceRef;
  }
};

const effectMutationSatisfied = (operation: ContainedTurnOperation, mutation: EffectMutation): boolean => {
  switch (mutation.kind) {
    case "effect_resolved":
      return operation.effect.kind === "resolved" && operation.effect.disposition === mutation.disposition && operation.effect.receiptRef === mutation.receiptRef;
    case "effect_ambiguous":
      return operation.effect.kind === "ambiguous" && operation.effect.evidenceRef === mutation.evidenceRef;
    case "reconciliation_required":
      return operation.reconciliation.kind === "required" && operation.reconciliation.evidenceRef === mutation.evidenceRef;
  }
};

const publicationMutationSatisfied = (operation: ContainedTurnOperation, mutation: PublicationMutation): boolean => {
  switch (mutation.kind) {
    case "artifacts_sealed":
      return operation.artifact.kind === "sealed" && operation.artifact.manifestRef === mutation.manifestRef &&
        operation.receipts.some(receipt => receipt.kind === "artifact_manifest_seal" && receipt.receiptRef === mutation.receiptRef);
    case "result_published":
      return operation.result.kind === "published" && operation.result.resultRef === mutation.resultRef &&
        operation.receipts.some(receipt => receipt.kind === "canonical_result_publication" && receipt.receiptRef === mutation.receiptRef);
    case "terminalize":
      return operation.terminal.kind === "terminal" && operation.terminal.receiptRef === mutation.receiptRef;
  }
};

export const isContainedTurnMutationSatisfied = (
  operation: ContainedTurnOperation,
  mutation: ContainedTurnMutation,
): boolean => {
  if (isWorkspaceMutation(mutation)) {return workspaceMutationSatisfied(operation, mutation);}
  if (isDispatchMutation(mutation)) {return dispatchMutationSatisfied(operation, mutation);}
  if (isProviderMutation(mutation)) {return providerMutationSatisfied(operation, mutation);}
  if (isOutputMutation(mutation)) {return outputMutationSatisfied(operation, mutation);}
  if (isContainmentMutation(mutation)) {return containmentMutationSatisfied(operation, mutation);}
  if (isEffectMutation(mutation)) {return effectMutationSatisfied(operation, mutation);}
  return publicationMutationSatisfied(operation, mutation);
};
