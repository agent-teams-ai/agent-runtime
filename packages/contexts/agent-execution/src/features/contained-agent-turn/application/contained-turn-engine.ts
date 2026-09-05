import type {
  ContainedTurnIntent,
  ContainedTurnProvider,
  ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { assertContainedTurnExactRecord } from "../domain/contained-turn-record.js";
import { readContainedTurnOwnedOperation } from "./contained-turn-closure.js";
import { submitContainedTurn } from "./contained-turn-submission.js";
import { requestContainedTurnCancellation } from "./contained-turn-cancellation.js";
import { preventContainedTurnIntent, type ContainedTurnIntentCancellationInput, type ContainedTurnIntentCancellationOutcome } from "./contained-turn-intent-cancellation.js";
import { validateContainedTurnKernelDependencies, type ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

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
  | {
      /** Acceptance is unresolved; these references are evidence, not a persisted operation or retry permission. */
      readonly candidateOperationId: string;
      readonly commandId: string;
      readonly evidenceId: string;
      readonly status: "potential_acceptance";
    }
  | { readonly code: "command_fingerprint_conflict"; readonly status: "conflict" }
  | { readonly code: "mode_unsupported" | "provider_mismatch" | "provider_unsupported"; readonly status: "unsupported" }
  | { readonly status: "denied" }
  | { readonly operation: ContainedTurnKernelOperation; readonly status: "observed" };

export type ContainedTurnApplicationObserveOutcome =
  | { readonly status: "not_found" }
  | { readonly operation: ContainedTurnKernelOperation; readonly status: "observed" };

export interface ContainedTurnApplicationApi {
  cancel(input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome>;
  cancel(input: ContainedTurnIntentCancellationInput): Promise<ContainedTurnIntentCancellationOutcome>;
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
  function cancel(input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome>;
  function cancel(input: ContainedTurnIntentCancellationInput): Promise<ContainedTurnIntentCancellationOutcome>;
  function cancel(input: ContainedTurnApplicationRefInput | ContainedTurnIntentCancellationInput) {
    return "prevention" in input ? preventContainedTurnIntent(authority.operationStore, input)
      : requestContainedTurnCancellation(authority, input);
  }
  const api: ContainedTurnApplicationApi = {
    cancel,
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
    : operation.reconciliation.kind === "required" || operation.closureRecovery.kind === "required"
      ? "reconcile_required"
      : operation.dispatch.kind === "claimed"
        ? "running"
        : "accepted",
});
