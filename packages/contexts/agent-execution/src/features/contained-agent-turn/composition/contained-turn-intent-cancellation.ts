import { containedTurnApplicationView, type ContainedTurnApplicationApi } from "../application/contained-turn-engine.js";
import type { ContainedTurnIntentCancellationInput, ContainedTurnIntentCancellationOutcome } from "../application/contained-turn-intent-cancellation.js";
import type { ContainedTurnFeatureApi, RequestContainedTurnCancellationInput, RequestContainedTurnCancellationOutcome } from "../contracts/contained-agent-turn.js";

export type { ContainedTurnIntentCancellationInput, ContainedTurnIntentCancellationOutcome } from "../application/contained-turn-intent-cancellation.js";

/** Only the trusted composition root receives this overload; public contracts stay operation-targeted. */
export interface ContainedTurnPrivateFeatureApi extends ContainedTurnFeatureApi {
  readonly cancel: {
    execute(input: RequestContainedTurnCancellationInput, options?: { readonly signal?: AbortSignal }): Promise<RequestContainedTurnCancellationOutcome>;
    execute(input: ContainedTurnIntentCancellationInput, options?: { readonly signal?: AbortSignal }): Promise<ContainedTurnIntentCancellationOutcome>;
  };
}

export const createContainedTurnPrivateCancellation = (
  application: ContainedTurnApplicationApi,
): ContainedTurnPrivateFeatureApi["cancel"] => {
  function execute(input: RequestContainedTurnCancellationInput, options?: { readonly signal?: AbortSignal }): Promise<RequestContainedTurnCancellationOutcome>;
  function execute(input: ContainedTurnIntentCancellationInput, options?: { readonly signal?: AbortSignal }): Promise<ContainedTurnIntentCancellationOutcome>;
  async function execute(
    input: RequestContainedTurnCancellationInput | ContainedTurnIntentCancellationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RequestContainedTurnCancellationOutcome | ContainedTurnIntentCancellationOutcome> {
    options?.signal?.throwIfAborted();
    if ("prevention" in input) {return application.cancel(input);}
    const outcome = await application.cancel({ operationId: input.operationId, scope: {
      projectId: input.scope.projectId, tenantId: input.scope.tenantId,
    } });
    return outcome.status === "not_found" ? Object.freeze({ status: "not_found" })
      : Object.freeze({ status: "observed", turn: containedTurnApplicationView(outcome.operation) });
  }
  return Object.freeze({ execute });
};
