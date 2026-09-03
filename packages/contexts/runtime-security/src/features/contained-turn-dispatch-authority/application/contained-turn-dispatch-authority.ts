import type {
  ContainedTurnDispatchAuthorityV1,
  ConsumeForDispatchInput,
  ConsumeForDispatchOutcome,
  ObserveDispatchConsumptionInput,
  ObserveDispatchConsumptionOutcome,
  SettleDispatchConsumptionInput,
  SettleDispatchConsumptionOutcome,
} from "../contracts/contained-turn-dispatch-authority-v1.js";
import {
  mapConsumeRequestFromV1,
  mapConsumeResultToV1,
  mapObservationQueryFromV1,
  mapObservedResultToV1,
  mapSettlementRequestFromV1,
  mapSettlementResultToV1,
} from "./contained-turn-dispatch-authority-v1-mappers.js";
import { consumeForDispatch } from "./consume-for-dispatch.js";
import type { DispatchAuthorityOperations } from "./dispatch-authority-dependencies.js";
import { observeDispatchConsumption } from "./observe-dispatch-consumption.js";
import { settleDispatchConsumption } from "./settle-dispatch-consumption.js";

const ownerUnavailable = () => Object.freeze({
  status: "indeterminate", reason: "owner_unavailable",
} as const);
const invalidSettlement = () => Object.freeze({ status: "invalid_request" } as const);

export const createContainedTurnDispatchAuthority = (
  operations: DispatchAuthorityOperations,
): ContainedTurnDispatchAuthorityV1 => {
  return Object.freeze({
    async consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> {
      try {
        const request = mapConsumeRequestFromV1(input);
        if (request === undefined) {
          return ownerUnavailable();
        }
        return mapConsumeResultToV1(await consumeForDispatch(request, operations),
          operations.digestCanonical);
      } catch {
        return ownerUnavailable();
      }
    },
    async observeDispatchConsumption(
      input: ObserveDispatchConsumptionInput,
    ): Promise<ObserveDispatchConsumptionOutcome> {
      try {
        const query = mapObservationQueryFromV1(input);
        if (query === undefined) {
          return ownerUnavailable();
        }
        const observed = await observeDispatchConsumption(query, operations);
        if (observed.outcome.status === "consumed") {
          return observed.lifecycleState === undefined
            ? ownerUnavailable()
            : mapObservedResultToV1(observed.outcome, observed.lifecycleState,
              operations.digestCanonical);
        }
        return mapObservedResultToV1(observed.outcome, "consumed_pending",
          operations.digestCanonical);
      } catch {
        return ownerUnavailable();
      }
    },
    async settleDispatchConsumption(
      input: SettleDispatchConsumptionInput,
    ): Promise<SettleDispatchConsumptionOutcome> {
      let request;
      try {
        request = mapSettlementRequestFromV1(input);
      } catch {
        return invalidSettlement();
      }
      if (request === undefined) {return invalidSettlement();}
      try {
        return mapSettlementResultToV1(await settleDispatchConsumption(request, operations));
      } catch {
        return ownerUnavailable();
      }
    },
  });
};
