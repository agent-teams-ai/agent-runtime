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

// oxlint-disable-next-line max-lines-per-function -- the Host-bound callbacks share one custody ledger.
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
  // oxlint-disable-next-line max-lines-per-function -- submission keeps one synchronous custody ledger.
  submit: async (rawInput: SubmitRuntimeContainedTurnInput, options?: { readonly signal?: AbortSignal }) => {
    dependencies.assertActive();
    const input = copyInput(rawInput);
    if (input === undefined) {
      return providerUnsupportedOutcome;
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined
      ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    // oxlint-disable-next-line max-lines-per-function -- acceptance and completion share one custody ledger.
    const response = new Promise<SubmitRuntimeContainedTurnOutcome>((resolve, reject) => {
      const ownerCall = Object.freeze({});
      let acceptedOperationId: string | undefined;
      let acceptanceContractViolated = false;
      let acceptanceOpen = true;
      let responded = false;
      const retainPotentialAcceptedOperation = (operationId: unknown): void => {
        if (!isBoundedIdentity(operationId)) {
          return;
        }
        const operation = Object.freeze({
          operationId,
          scope: Object.freeze({ ...dependencies.scope! }),
        });
        dependencies.onAccepted(operation, ownerCall);
        dependencies.onObserved(operationId, "contract_violation");
        acceptedOperationId ??= operationId;
        if (dependencies.isDisposed()) {
          void dependencies.requestCancellation(operation);
        }
      };
      const trackAcceptedOperation = (
        rawOperation: ContainedTurnCompositionOperationRef,
        observedStatus?: OwnerTurnObservation["status"],
        onOperationId?: (operationId: unknown) => void,
      ): string => {
        const operation = copyAcceptedOperation(rawOperation, dependencies.scope!, onOperationId);
        if (acceptedOperationId !== undefined && acceptedOperationId !== operation.operationId) {
          dependencies.onObserved(acceptedOperationId, "contract_violation");
          return contractViolation("operation_id_mismatch");
        }
        dependencies.onAccepted(operation, ownerCall);
        if (observedStatus !== undefined) {
          dependencies.onObserved(operation.operationId, observedStatus);
        }
        if (dependencies.isDisposed() &&
          (observedStatus === undefined || !isTerminalTurnStatus(observedStatus))) {
          void dependencies.requestCancellation(operation);
        }
        return operation.operationId;
      };
      const resolveAcceptance = (operationId: string): void => {
        if (acceptedOperationId !== undefined && acceptedOperationId !== operationId) {
          return contractViolation("operation_id_mismatch");
        }
        acceptedOperationId = operationId;
        if (!responded) {
          responded = true;
          resolve(Object.freeze({ operationId, status: "accepted" as const }));
        }
      };
      const accepted = (operation: ContainedTurnCompositionOperationRef): void => {
        if (!acceptanceOpen) {
          return;
        }
        let potentialOperationId: unknown;
        try {
          const operationId = trackAcceptedOperation(
            operation,
            undefined,
            potentialId => {potentialOperationId = potentialId;},
          );
          resolveAcceptance(operationId);
        } catch (error) {
          acceptanceOpen = false;
          acceptanceContractViolated = true;
          try {
            retainPotentialAcceptedOperation(potentialOperationId);
          } catch {
            // Registration already retains the existing owner record as a contract violation.
          }
          if (!responded) {
            responded = true;
            reject(error);
          }
        }
      };
      let completion: Promise<unknown>;
      try {
        completion = dependencies.executeCall(() => dependencies.capability!.submit.execute({
          ...input,
          scope: dependencies.scope!,
        }, { onAccepted: accepted, signal }));
      } catch {
        acceptanceOpen = false;
        reject(containedTurnOwnerInvocationFailed);
        return;
      }
      const handleCompletion = async (): Promise<void> => {
        let outcome: unknown;
        try {
          outcome = await completion;
        } catch {
          acceptanceOpen = false;
          if (acceptedOperationId !== undefined) {
            dependencies.onObserved(acceptedOperationId, "contract_violation");
          }
          if (!responded) {
            responded = true;
            reject(containedTurnOwnerInvocationFailed);
          }
          return;
        }
        try {
          acceptanceOpen = false;
          let potentialOperationId: unknown;
          let copied: CopiedSubmitOutcome;
          try {
            copied = copySubmitOutcome(
              outcome,
              operationId => {potentialOperationId = operationId;},
            );
          } catch (error) {
            retainPotentialAcceptedOperation(potentialOperationId);
            throw error;
          }
          if (copied.observation !== undefined) {
            if (acceptanceContractViolated) {
              const operation = copyAcceptedOperation(Object.freeze({
                operationId: copied.observation.operationId,
                scope: dependencies.scope!,
              }), dependencies.scope!);
              dependencies.onAccepted(operation, ownerCall);
              dependencies.onObserved(operation.operationId, "contract_violation");
              return;
            }
            if (acceptedOperationId !== undefined &&
              copied.observation.operationId !== acceptedOperationId) {
              dependencies.onObserved(acceptedOperationId, "contract_violation");
              throw new ContainedTurnOwnerContractError("operation_id_mismatch");
            }
            const operationId = trackAcceptedOperation(Object.freeze({
              operationId: copied.observation.operationId,
              scope: dependencies.scope!,
            }), copied.observation.status);
            if (acceptedOperationId === undefined) {
              resolveAcceptance(operationId);
            }
          }
          if (!responded) {
            responded = true;
            resolve(copied.outcome);
          }
        } catch (error) {
          acceptanceOpen = false;
          if (acceptedOperationId !== undefined) {
            dependencies.onObserved(acceptedOperationId, "contract_violation");
          }
          if (!responded) {
            responded = true;
            reject(error);
          }
        }
      };
      void handleCompletion().catch(() => {});
    });
    return raceWithAbort(response, signal);
  },
});
