import type {
  ContainedTurnIntent,
  ContainedTurnProvider,
  ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
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
import { submitContainedTurn } from "./contained-turn-submission.js";
import { bindContainedTurnCancellationWorkspace } from "./contained-turn-preparation-cleanup.js";
import {
  validateContainedTurnKernelDependencies,
  type ContainedTurnKernelDependencies,
} from "./ports/outbound/contained-turn-ports.js";

export interface ContainedTurnApplicationSubmitInput {
  readonly commandId: string;
  readonly expectedProvider: ContainedTurnProvider;
  readonly intent: ContainedTurnIntent;
  readonly scope: ContainedTurnScope;
}

export interface ContainedTurnApplicationRefInput {
  readonly operationId: string;
  readonly scope: ContainedTurnScope;
}

export interface ContainedTurnApplicationView {
  readonly artifactManifestRef?: string;
  readonly commandId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly output: readonly {
    readonly cursor: number;
    readonly kind: "assistant" | "diagnostic" | "progress";
    readonly text: string;
  }[];
  readonly provider: ContainedTurnProvider;
  readonly resultRef?: string;
  readonly revision: number;
  readonly status: "accepted" | "cancelled" | "failed" | "reconcile_required" | "running" | "succeeded";
}

export type ContainedTurnApplicationSubmitOutcome =
  | { readonly code: "command_fingerprint_conflict"; readonly status: "conflict" }
  | { readonly code: "mode_unsupported" | "provider_mismatch" | "provider_unsupported"; readonly status: "unsupported" }
  | { readonly status: "denied" }
  | { readonly operation: ContainedTurnKernelOperation; readonly status: "observed" };

export type ContainedTurnApplicationObserveOutcome =
  | { readonly status: "not_found" }
  | { readonly operation: ContainedTurnKernelOperation; readonly status: "observed" };

export interface ContainedTurnApplicationApi {
  cancel(input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome>;
  observe(input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome>;
  submit(
    input: ContainedTurnApplicationSubmitInput,
    options?: Readonly<{ onAccepted?: (operation: ContainedTurnKernelOperation) => void }>,
  ): Promise<ContainedTurnApplicationSubmitOutcome>;
}

const observeContainedTurn = async (
  dependencies: ContainedTurnKernelDependencies,
  input: ContainedTurnApplicationRefInput,
): Promise<ContainedTurnApplicationObserveOutcome> => {
  assertContainedTurnExactRecord("contained-turn observation", input, ["operationId", "scope"]);
  const operationId = containedTurnIdentity("operation", input.operationId);
  const operation = await readContainedTurnOwnedOperation(dependencies, operationId, input.scope);
  return operation === undefined ? { status: "not_found" } : { operation, status: "observed" };
};

const requestContainedTurnCancellation = async (
  dependencies: ContainedTurnKernelDependencies,
  input: ContainedTurnApplicationRefInput,
): Promise<ContainedTurnApplicationObserveOutcome> => {
  const observed = await observeContainedTurn(dependencies, input);
  if (observed.status === "not_found") {return observed;}
  if (observed.operation.terminal.kind === "final" || observed.operation.cancellation.kind === "requested") {
    return observed;
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
  try {
    if (current.dispatch.kind === "unclaimed" && current.workspaceId === undefined) {
      current = await bindContainedTurnCancellationWorkspace(dependencies, current, input.scope);
    }
    if (current.dispatch.kind === "unclaimed" && current.workspaceId !== undefined) {
      const proofs = await dependencies.operationStore.proofsForPrevention({
        authority: containedTurnOwnerStoreAuthority(current, input.scope),
        operation: current,
        preventionProofId: prepared.preventionProofId,
      });
      current = await advanceContainedTurn(dependencies, current, input.scope, {
        ...proofs,
        kind: "prevent_dispatch",
      });
      current = await closeContainedTurnWithoutExecution(dependencies, current, input.scope);
    } else if (current.dispatch.kind === "claimed" && current.custodyId !== undefined &&
        current.physicalContainment.kind !== "contained") {
      current = await closeContainedTurnPhysicalContainment(dependencies, current, input.scope);
    }
  } catch (error) {
    if (error instanceof ContainedTurnIndeterminateCommitError) {current = error.operation;}
    else if (!(error instanceof ContainedTurnCasLostError)) {
      current = await recordContainedTurnRejectedDebt(
        dependencies,
        current,
        input.scope,
        "cancellation_closure_rejected",
        "store_commit",
      );
    }
  }
  return { operation: current, status: "observed" };
};

export const createContainedTurnEngine = (
  dependencies: ContainedTurnKernelDependencies,
): ContainedTurnApplicationApi => {
  validateContainedTurnKernelDependencies(dependencies);
  const authority: ContainedTurnKernelDependencies = Object.freeze({
    operationStore: dependencies.operationStore,
    security: dependencies.security,
    providerAccess: dependencies.providerAccess,
    workspace: dependencies.workspace,
    artifacts: dependencies.artifacts,
    custody: dependencies.custody,
    provider: dependencies.provider,
  });
  const api: ContainedTurnApplicationApi = {
    cancel: input => requestContainedTurnCancellation(authority, input),
    observe: input => observeContainedTurn(authority, input),
    submit: (input, options) => submitContainedTurn(authority, input, options),
  };
  return Object.freeze(api);
};

export const containedTurnApplicationView = (
  operation: ContainedTurnKernelOperation,
): ContainedTurnApplicationView => Object.freeze({
  ...(operation.artifactManifestRef === undefined ? {} : { artifactManifestRef: operation.artifactManifestRef }),
  commandId: operation.commandId,
  effectId: operation.effectId,
  operationId: operation.operationId,
  output: Object.freeze(operation.output.chunks.map(chunk => Object.freeze({
    cursor: chunk.cursor,
    kind: chunk.kind,
    text: chunk.text,
  }))),
  provider: operation.adapterSnapshot.provider,
  ...(operation.resultRef === undefined ? {} : { resultRef: operation.resultRef }),
  revision: operation.revision,
  status: operation.terminal.kind === "final"
    ? operation.terminal.outcome
    : operation.reconciliation.kind === "required"
      ? "reconcile_required"
      : operation.dispatch.kind === "claimed"
        ? "running"
        : "accepted",
});
