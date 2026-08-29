import {
  containedTurnApplicationView,
  createContainedTurnEngine,
} from "../application/contained-turn-engine.js";
import {
  validateContainedTurnKernelDependencies,
  type ContainedTurnKernelDependencies,
} from "../application/ports/outbound/contained-turn-ports.js";
import type {
  ContainedTurnFeatureApi,
  ObserveContainedTurnInput,
  RequestContainedTurnCancellationInput,
  SubmitContainedTurnInput,
  SubmitContainedTurnOptions,
  ContainedTurnOperationRef,
  ContainedTurnScope,
} from "../contracts/contained-agent-turn.js";

export type ContainedTurnFeatureDependencies = ContainedTurnKernelDependencies;

const mapScope = (scope: ContainedTurnScope) => Object.freeze({
  projectId: scope.projectId,
  tenantId: scope.tenantId,
});

const mapOperationRef = (operationId: string, scope: ContainedTurnScope): ContainedTurnOperationRef => Object.freeze({
  operationId,
  scope: mapScope(scope),
});

export const createContainedTurnFeature = (
  dependencies: ContainedTurnFeatureDependencies,
): ContainedTurnFeatureApi => {
  validateContainedTurnKernelDependencies(dependencies);
  const application = createContainedTurnEngine(dependencies);
  const feature: ContainedTurnFeatureApi = {
    cancel: Object.freeze({
      execute: async (input: RequestContainedTurnCancellationInput, options?: { readonly signal?: AbortSignal }) => {
        options?.signal?.throwIfAborted();
        const outcome = await application.cancel({ operationId: input.operationId, scope: mapScope(input.scope) });
        return outcome.status === "not_found"
          ? Object.freeze({ status: "not_found" as const })
          : Object.freeze({ status: "observed" as const, turn: containedTurnApplicationView(outcome.operation) });
      },
    }),
    observe: Object.freeze({
      execute: async (input: ObserveContainedTurnInput) => {
        const outcome = await application.observe({ operationId: input.operationId, scope: mapScope(input.scope) });
        return outcome.status === "not_found"
          ? Object.freeze({ status: "not_found" as const })
          : Object.freeze({ status: "observed" as const, turn: containedTurnApplicationView(outcome.operation) });
      },
    }),
    submit: Object.freeze({
      execute: async (input: SubmitContainedTurnInput, options?: SubmitContainedTurnOptions) => {
        options?.signal?.throwIfAborted();
        const outcome = await application.submit({
          commandId: input.commandId,
          expectedProvider: input.expectedProvider,
          intent: Object.freeze({ mode: input.intent.mode, prompt: input.intent.prompt }),
          scope: mapScope(input.scope),
        });
        if (outcome.status !== "observed") {return outcome;}
        try {
          options?.onAccepted?.(mapOperationRef(outcome.operation.operationId, outcome.operation.scope));
        } catch {
          // Acceptance truth is durable before this best-effort observer runs.
        }
        return Object.freeze({ status: "observed" as const, turn: containedTurnApplicationView(outcome.operation) });
      },
    }),
  };
  return Object.freeze(feature);
};
