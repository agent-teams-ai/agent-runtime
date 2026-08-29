import type {
  ContainedTurnFeatureApi,
  ContainedTurnOperationRef,
  ContainedTurnScope,
  ContainedTurnView,
  SubmitContainedTurnOutcome,
} from "@agent-teams/agent-execution";

import type {
  ObserveRuntimeContainedTurnOutcome,
  RuntimeContainedTurnView,
  RuntimeContainedTurnAccess,
  SubmitRuntimeContainedTurnInput,
  SubmitRuntimeContainedTurnOutcome,
} from "../contracts/runtime-access.js";
import { raceWithAbort } from "./runtime-access-lifecycle.js";

const unavailableOutcome = Object.freeze({
  code: "capability_unavailable" as const,
  status: "unsupported" as const,
});

const mapContainedTurnView = (turn: ContainedTurnView): RuntimeContainedTurnView => Object.freeze({
  ...(turn.artifactManifestRef === undefined ? {} : { artifactManifestRef: turn.artifactManifestRef }),
  commandId: turn.commandId,
  effectId: turn.effectId,
  operationId: turn.operationId,
  output: Object.freeze(turn.output.map(chunk => Object.freeze({ ...chunk }))),
  provider: turn.provider,
  ...(turn.resultRef === undefined ? {} : { resultRef: turn.resultRef }),
  revision: turn.revision,
  status: turn.status,
});

const copyObservation = (
  outcome: Exclude<ObserveRuntimeContainedTurnOutcome, { readonly code: "capability_unavailable" }>,
): ObserveRuntimeContainedTurnOutcome => outcome.status === "not_found"
  ? Object.freeze({ status: "not_found" as const })
  : Object.freeze({ status: "observed" as const, turn: mapContainedTurnView(outcome.turn) });

const copyInput = (input: SubmitRuntimeContainedTurnInput): SubmitRuntimeContainedTurnInput => {
  const intent = input.intent;
  return Object.freeze({
    commandId: input.commandId,
    expectedProvider: input.expectedProvider,
    intent: Object.freeze({ mode: intent.mode, prompt: intent.prompt }),
  });
};

const mapBeforeAcceptance = (
  outcome: SubmitContainedTurnOutcome,
): SubmitRuntimeContainedTurnOutcome => outcome.status === "observed"
  ? Object.freeze({ operationId: outcome.turn.operationId, status: "accepted" as const })
  : Object.freeze({ ...outcome });

export interface ContainedTurnRuntimeAccessDependencies {
  readonly assertActive: () => void;
  readonly capability: ContainedTurnFeatureApi | undefined;
  readonly hostSignal: AbortSignal;
  readonly isDisposed: () => boolean;
  readonly onAccepted: (operation: ContainedTurnOperationRef) => void;
  readonly onSettled: (operationId: string) => void;
  readonly requestCancellation: (operation: ContainedTurnOperationRef) => Promise<unknown>;
  readonly scope: ContainedTurnScope | undefined;
  readonly trackCall: <T>(operation: Promise<T>) => Promise<T>;
}

export const createContainedTurnRuntimeAccess = (
  dependencies: ContainedTurnRuntimeAccessDependencies,
): RuntimeContainedTurnAccess => Object.freeze({
  cancel: async (
    operationId: string,
    options?: { readonly signal?: AbortSignal },
  ) => {
    dependencies.assertActive();
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined
      ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    const operation = dependencies.capability.cancel.execute({
      operationId,
      scope: dependencies.scope,
    }, { signal });
    return copyObservation(await raceWithAbort(dependencies.trackCall(operation), signal));
  },
  observe: async (operationId: string) => {
    dependencies.assertActive();
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const outcome = await dependencies.trackCall(dependencies.capability.observe.execute({
      operationId,
      scope: dependencies.scope,
    }));
    return copyObservation(outcome);
  },
  submit: async (
    rawInput: SubmitRuntimeContainedTurnInput,
    options?: { readonly signal?: AbortSignal },
  ) => {
    dependencies.assertActive();
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const input = copyInput(rawInput);
    const signal = options?.signal === undefined
      ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    const response = new Promise<SubmitRuntimeContainedTurnOutcome>((resolve, reject) => {
      let responded = false;
      const accepted = (operation: ContainedTurnOperationRef): void => {
        dependencies.onAccepted(operation);
        if (!responded) {
          responded = true;
          resolve(Object.freeze({ operationId: operation.operationId, status: "accepted" as const }));
        }
        if (dependencies.isDisposed()) {
          void dependencies.requestCancellation(operation);
        }
      };
      const completion = dependencies.trackCall(dependencies.capability!.submit.execute({
        ...input,
        scope: dependencies.scope!,
      }, { onAccepted: accepted, signal }));
      void (async () => {
        try {
          const outcome = await completion;
          if (outcome.status === "observed") {
            dependencies.onSettled(outcome.turn.operationId);
          }
          if (!responded) {
            responded = true;
            resolve(mapBeforeAcceptance(outcome));
          }
        } catch (error) {
          if (!responded) {
            responded = true;
            reject(error);
          }
        }
      })();
    });
    return raceWithAbort(response, signal);
  },
});
