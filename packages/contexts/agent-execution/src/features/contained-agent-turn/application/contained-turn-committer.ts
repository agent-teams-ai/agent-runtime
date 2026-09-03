import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import type { ContainedTurnEvidenceId } from "../domain/contained-turn-identities.js";
import type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
} from "../domain/contained-turn-kernel-model.js";
import type { ContainedTurnOutputWriteAuthority } from "../domain/contained-turn-output-authority.js";
import { appendContainedTurnOutputForOwnerStore } from "../domain/contained-turn-output-transitions.js";
import {
  mutateContainedTurnOperation,
  type ContainedTurnKernelMutation,
} from "../domain/contained-turn-transitions.js";
import {
  containedTurnOwnerStoreAuthority,
  sanitizeContainedTurnOwnerStoreOutcome,
} from "./contained-turn-store-authority.js";
import type {
  CommitContainedTurnKernelOperationOutcome,
  ContainedTurnKernelDependencies,
} from "./ports/outbound/contained-turn-ports.js";

export class ContainedTurnCasLostError extends Error {}

export class ContainedTurnIndeterminateCommitError extends Error {
  public constructor(public readonly operation: ContainedTurnKernelOperation) {
    super("contained-turn owner-store commit acknowledgement was indeterminate");
  }
}

export const durableContainedTurnDebtOperation = (
  outcome: Extract<CommitContainedTurnKernelOperationOutcome, { readonly kind: "indeterminate" }>,
): ContainedTurnKernelOperation => {
  if (outcome.debtOperation.reconciliation.kind !== "required" ||
      !outcome.debtOperation.reconciliation.evidenceIds.includes(outcome.evidenceId) ||
      outcome.debtOperation.terminal.kind !== "open") {
    throw new Error("indeterminate owner-store acknowledgement lacks durable reconciliation debt");
  }
  return outcome.debtOperation;
};

const sanitize = (
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  outcome: CommitContainedTurnKernelOperationOutcome,
): CommitContainedTurnKernelOperationOutcome => sanitizeContainedTurnOwnerStoreOutcome({
  authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
  outcome,
});

export const commitContainedTurnMutation = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  mutation: ContainedTurnKernelMutation,
): Promise<CommitContainedTurnKernelOperationOutcome> => sanitize(
  operation,
  trustedScope,
  await dependencies.operationStore.commit({
    authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
    candidate: mutateContainedTurnOperation(operation, mutation),
    expectedRevision: operation.revision,
  }),
);

export const advanceContainedTurn = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  mutation: ContainedTurnKernelMutation,
): Promise<ContainedTurnKernelOperation> => {
  const outcome = await commitContainedTurnMutation(dependencies, operation, trustedScope, mutation);
  if (outcome.kind === "applied") {return outcome.operation;}
  if (outcome.kind === "indeterminate") {
    throw new ContainedTurnIndeterminateCommitError(durableContainedTurnDebtOperation(outcome));
  }
  throw new ContainedTurnCasLostError("contained-turn transition lost its single CAS");
};

export const appendContainedTurnCanonicalOutput = async (input: Readonly<{
  authority: ContainedTurnOutputWriteAuthority;
  dependencies: ContainedTurnKernelDependencies;
  operation: ContainedTurnKernelOperation;
  output: ContainedTurnKernelOutputChunk;
  trustedScope: ContainedTurnScope;
}>): Promise<ContainedTurnKernelOperation> => {
  // Pure validation catches malformed chunks before the owner-store transaction;
  // the store repeats the same transition only after its private authority CAS.
  appendContainedTurnOutputForOwnerStore(input.operation, input.output);
  const outcome = sanitize(input.operation, input.trustedScope, await input.dependencies.operationStore.appendOutput({
    authority: containedTurnOwnerStoreAuthority(input.operation, input.trustedScope),
    expectedCursor: input.operation.output.chunks.length,
    expectedRevision: input.operation.revision,
    outputAuthority: input.authority,
    output: input.output,
  }));
  if (outcome.kind === "applied") {return outcome.operation;}
  if (outcome.kind === "indeterminate") {
    throw new ContainedTurnIndeterminateCommitError(durableContainedTurnDebtOperation(outcome));
  }
  throw new ContainedTurnCasLostError("canonical-output append lost its private-authority CAS");
};

export const recordContainedTurnReconciliationDebt = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  evidenceId: ContainedTurnEvidenceId,
  source: Extract<ContainedTurnKernelMutation, { readonly kind: "record_reconciliation_debt" }>["source"],
): Promise<ContainedTurnKernelOperation> => {
  const outcome = await commitContainedTurnMutation(
    dependencies,
    operation,
    trustedScope,
    { evidenceId, kind: "record_reconciliation_debt", source },
  );
  if (outcome.kind === "applied") {return outcome.operation;}
  if (outcome.kind === "indeterminate") {return durableContainedTurnDebtOperation(outcome);}
  if (outcome.kind === "stale" && outcome.current.reconciliation.kind === "required" &&
      outcome.current.reconciliation.evidenceIds.includes(evidenceId)) {
    return outcome.current;
  }
  throw new ContainedTurnCasLostError("reconciliation debt lost its owner-store CAS");
};

export const readContainedTurnOwnedOperation = (
  dependencies: ContainedTurnKernelDependencies,
  operationId: ContainedTurnKernelOperation["operationId"],
  scope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation | undefined> => dependencies.operationStore.read({ operationId, scope });
