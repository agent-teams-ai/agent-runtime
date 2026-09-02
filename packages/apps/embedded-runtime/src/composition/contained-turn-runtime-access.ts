import type {
  ObserveRuntimeContainedTurnOutcome,
  RuntimeContainedTurnAccess,
  SubmitRuntimeContainedTurnInput,
  SubmitRuntimeContainedTurnOutcome,
} from "../contracts/runtime-access.js";
import { raceWithAbort } from "./runtime-access-lifecycle.js";
import {
  containedTurnOwnerInvocationFailed,
  ContainedTurnOwnerContractError,
} from "./agent-runtime-host-disposal.js";
import {
  contractViolation,
  copyAcceptedOperation,
  copyInput,
  copyObservation,
  copySubmitOutcome,
  isBoundedIdentity,
  isTerminalTurnStatus,
  providerUnsupportedOutcome,
  unavailableOutcome,
  type CopiedSubmitOutcome,
} from "./contained-turn-runtime-validation.js";
import type { ContainedTurnCompositionOperationRef } from "./contained-turn-operation-ref.js";
import type {
  OwnerTurnObservation,
} from "./contained-turn-composition-types.js";
import type { ContainedTurnCompositionScope } from "./trusted-runtime-access-scope.js";

type ContainedTurnOwnerStatus =
  | "accepted"
  | "cancelled"
  | "failed"
  | "reconcile_required"
  | "running"
  | "succeeded";

export interface ContainedTurnCapabilityBundle {
  readonly cancel: {
    execute(
      input: ContainedTurnCompositionOperationRef,
      options?: { readonly signal?: AbortSignal },
    ): Promise<unknown>;
  };
  readonly observe: {
    execute(input: ContainedTurnCompositionOperationRef): Promise<unknown>;
  };
  readonly submit: {
    execute(
      input: {
        readonly commandId: string;
        readonly expectedProvider: string;
        readonly intent: {
          readonly mode: "analysis" | "workspace-write";
          readonly prompt: string;
        };
        readonly scope: ContainedTurnCompositionScope;
      },
      options?: {
        readonly onAccepted?: (operation: ContainedTurnCompositionOperationRef) => void;
        readonly signal?: AbortSignal;
      },
    ): Promise<unknown>;
  };
}

export interface ContainedTurnRuntimeAccessDependencies {
  readonly assertActive: () => void;
  readonly capability: ContainedTurnCapabilityBundle | undefined;
  readonly hostSignal: AbortSignal;
  readonly isDisposed: () => boolean;
  readonly onAccepted: (
    operation: ContainedTurnCompositionOperationRef,
    ownerCall: object,
  ) => void;
  readonly onObserved: (
    operationId: string,
    status: ContainedTurnOwnerStatus | "contract_violation",
  ) => void;
  readonly requestCancellation: (operation: ContainedTurnCompositionOperationRef) => Promise<unknown>;
  readonly scope: ContainedTurnCompositionScope | undefined;
  readonly executeCall: <T>(operation: () => Promise<T>) => Promise<T>;
}

type SubmitResolution = (outcome: SubmitRuntimeContainedTurnOutcome) => void;

class ContainedTurnSubmissionCustody {
  readonly #dependencies: ContainedTurnRuntimeAccessDependencies;
  readonly #ownerCall = Object.freeze({});
  readonly #reject: (reason: unknown) => void;
  readonly #resolve: SubmitResolution;
  #acceptedOperationId: string | undefined;
  #acceptanceContractViolated = false;
  #acceptanceOpen = true;
  #responded = false;

  public constructor(
    dependencies: ContainedTurnRuntimeAccessDependencies,
    resolve: SubmitResolution,
    reject: (reason: unknown) => void,
  ) {
    this.#dependencies = dependencies;
    this.#resolve = resolve;
    this.#reject = reject;
  }

  readonly #retainPotentialAcceptedOperation = (operationId: unknown): void => {
    if (!isBoundedIdentity(operationId)) {
      return;
    }
    const operation = Object.freeze({
      operationId,
      scope: Object.freeze({ ...this.#dependencies.scope! }),
    });
    this.#dependencies.onAccepted(operation, this.#ownerCall);
    this.#dependencies.onObserved(operationId, "contract_violation");
    this.#acceptedOperationId ??= operationId;
    if (this.#dependencies.isDisposed()) {
      void this.#dependencies.requestCancellation(operation);
    }
  };

  readonly #trackAcceptedOperation = (
    rawOperation: ContainedTurnCompositionOperationRef,
    observedStatus?: OwnerTurnObservation["status"],
    onOperationId?: (operationId: unknown) => void,
  ): string => {
    const operation = copyAcceptedOperation(
      rawOperation,
      this.#dependencies.scope!,
      onOperationId,
    );
    if (this.#acceptedOperationId !== undefined &&
      this.#acceptedOperationId !== operation.operationId) {
      this.#dependencies.onObserved(this.#acceptedOperationId, "contract_violation");
      return contractViolation("operation_id_mismatch");
    }
    this.#dependencies.onAccepted(operation, this.#ownerCall);
    if (observedStatus !== undefined) {
      this.#dependencies.onObserved(operation.operationId, observedStatus);
    }
    if (this.#dependencies.isDisposed() &&
      (observedStatus === undefined || !isTerminalTurnStatus(observedStatus))) {
      void this.#dependencies.requestCancellation(operation);
    }
    return operation.operationId;
  };

  readonly #resolveAcceptance = (operationId: string): void => {
    if (this.#acceptedOperationId !== undefined && this.#acceptedOperationId !== operationId) {
      return contractViolation("operation_id_mismatch");
    }
    this.#acceptedOperationId = operationId;
    if (!this.#responded) {
      this.#responded = true;
      this.#resolve(Object.freeze({ operationId, status: "accepted" }));
    }
  };

  readonly #accepted = (operation: ContainedTurnCompositionOperationRef): void => {
    if (!this.#acceptanceOpen) {
      return;
    }
    let potentialOperationId: unknown;
    try {
      const operationId = this.#trackAcceptedOperation(
        operation,
        undefined,
        potentialId => {potentialOperationId = potentialId;},
      );
      this.#resolveAcceptance(operationId);
    } catch (error) {
      this.#acceptanceOpen = false;
      this.#acceptanceContractViolated = true;
      try {
        this.#retainPotentialAcceptedOperation(potentialOperationId);
      } catch {
        // Registration already retains the existing owner record as a contract violation.
      }
      if (!this.#responded) {
        this.#responded = true;
        this.#reject(error);
      }
    }
  };

  readonly #recordCopiedObservation = (copied: CopiedSubmitOutcome): void => {
    if (copied.observation === undefined) {
      return;
    }
    if (this.#acceptanceContractViolated) {
      const operation = copyAcceptedOperation(Object.freeze({
        operationId: copied.observation.operationId,
        scope: this.#dependencies.scope!,
      }), this.#dependencies.scope!);
      this.#dependencies.onAccepted(operation, this.#ownerCall);
      this.#dependencies.onObserved(operation.operationId, "contract_violation");
      return;
    }
    if (this.#acceptedOperationId !== undefined &&
      copied.observation.operationId !== this.#acceptedOperationId) {
      this.#dependencies.onObserved(this.#acceptedOperationId, "contract_violation");
      throw new ContainedTurnOwnerContractError("operation_id_mismatch");
    }
    const operationId = this.#trackAcceptedOperation(Object.freeze({
      operationId: copied.observation.operationId,
      scope: this.#dependencies.scope!,
    }), copied.observation.status);
    if (this.#acceptedOperationId === undefined) {
      this.#resolveAcceptance(operationId);
    }
  };

  readonly #processCompletion = (outcome: unknown): void => {
    this.#acceptanceOpen = false;
    let potentialOperationId: unknown;
    let copied: CopiedSubmitOutcome;
    try {
      copied = copySubmitOutcome(outcome, operationId => {potentialOperationId = operationId;});
    } catch (error) {
      this.#retainPotentialAcceptedOperation(potentialOperationId);
      throw error;
    }
    this.#recordCopiedObservation(copied);
    if (!this.#responded) {
      this.#responded = true;
      this.#resolve(copied.outcome);
    }
  };

  readonly #handleCompletion = async (completion: Promise<unknown>): Promise<void> => {
    let outcome: unknown;
    try {
      outcome = await completion;
    } catch {
      this.#acceptanceOpen = false;
      if (this.#acceptedOperationId !== undefined) {
        this.#dependencies.onObserved(this.#acceptedOperationId, "contract_violation");
      }
      if (!this.#responded) {
        this.#responded = true;
        this.#reject(containedTurnOwnerInvocationFailed);
      }
      return;
    }
    try {
      this.#processCompletion(outcome);
    } catch (error) {
      this.#acceptanceOpen = false;
      if (this.#acceptedOperationId !== undefined) {
        this.#dependencies.onObserved(this.#acceptedOperationId, "contract_violation");
      }
      if (!this.#responded) {
        this.#responded = true;
        this.#reject(error);
      }
    }
  };

  public start(input: Readonly<SubmitRuntimeContainedTurnInput>, hostSignal: AbortSignal): void {
    let completion: Promise<unknown>;
    try {
      completion = this.#dependencies.executeCall(() =>
        this.#dependencies.capability!.submit.execute({
          ...input,
          scope: this.#dependencies.scope!,
        }, { onAccepted: this.#accepted, signal: hostSignal }));
    } catch {
      this.#acceptanceOpen = false;
      this.#reject(containedTurnOwnerInvocationFailed);
      return;
    }
    void this.#handleCompletion(completion).catch(() => {});
  }
}

const waitForSubmissionAcceptance = (
  dependencies: ContainedTurnRuntimeAccessDependencies,
  input: Readonly<SubmitRuntimeContainedTurnInput>,
  callerSignal: AbortSignal | undefined,
): Promise<SubmitRuntimeContainedTurnOutcome> => new Promise((resolve, reject) => {
  let settled = false;
  const signals = callerSignal === undefined
    ? [dependencies.hostSignal]
    : [dependencies.hostSignal, callerSignal];
  const abortListeners: Readonly<{
    abort: () => void;
    signal: AbortSignal;
  }>[] = [];
  const settle = (callback: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    for (const listener of abortListeners) {
      listener.signal.removeEventListener("abort", listener.abort);
    }
    callback();
  };
  for (const signal of signals) {
    abortListeners.push(Object.freeze({
      abort: () => settle(() => reject(
        signal.reason ?? new DOMException("Agent Runtime operation was cancelled", "AbortError"),
      )),
      signal,
    }));
  }

  for (const listener of abortListeners) {
    if (listener.signal.aborted) {
      listener.abort();
      return;
    }
    listener.signal.addEventListener("abort", listener.abort, { once: true });
  }
  new ContainedTurnSubmissionCustody(
    dependencies,
    outcome => settle(() => resolve(outcome)),
    reason => settle(() => reject(reason)),
  ).start(input, dependencies.hostSignal);
});

export const createContainedTurnRuntimeAccess = (
  dependencies: ContainedTurnRuntimeAccessDependencies,
): RuntimeContainedTurnAccess => Object.freeze({
  cancel: async (operationId: string, options?: { readonly signal?: AbortSignal }) => {
    dependencies.assertActive();
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    const ownerCompletion = dependencies.executeCall(() => dependencies.capability!.cancel.execute({
        operationId,
        scope: dependencies.scope!,
      }, { signal })).then(
        outcome => Object.freeze({ kind: "completed" as const, outcome }),
        () => Object.freeze({ kind: "owner_failure" as const }),
      );
    const completion = await raceWithAbort(ownerCompletion, signal);
    if (completion.kind === "owner_failure") {
      dependencies.onObserved(operationId, "contract_violation");
      throw containedTurnOwnerInvocationFailed;
    }
    let outcome: ObserveRuntimeContainedTurnOutcome;
    try {
      outcome = copyObservation(completion.outcome, operationId);
    } catch (error) {
      dependencies.onObserved(operationId, "contract_violation");
      throw error;
    }
    if (outcome.status === "observed") {
      dependencies.onObserved(outcome.turn.operationId, outcome.turn.status);
    }
    return outcome;
  },
  observe: async (operationId: string) => {
    dependencies.assertActive();
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const ownerCompletion = dependencies.executeCall(() => dependencies.capability!.observe.execute({
        operationId,
        scope: dependencies.scope!,
      })).catch(() => {throw containedTurnOwnerInvocationFailed;});
    let outcome: ObserveRuntimeContainedTurnOutcome;
    try {
      outcome = copyObservation(await ownerCompletion, operationId);
    } catch (error) {
      dependencies.onObserved(operationId, "contract_violation");
      throw error;
    }
    if (outcome.status === "observed") {
      dependencies.onObserved(outcome.turn.operationId, outcome.turn.status);
    }
    return outcome;
  },
  submit: async (rawInput: SubmitRuntimeContainedTurnInput, options?: { readonly signal?: AbortSignal }) => {
    dependencies.assertActive();
    const input = copyInput(rawInput);
    if (input === undefined) {
      return providerUnsupportedOutcome;
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    dependencies.hostSignal.throwIfAborted();
    options?.signal?.throwIfAborted();
    return waitForSubmissionAcceptance(dependencies, input, options?.signal);
  },
});
