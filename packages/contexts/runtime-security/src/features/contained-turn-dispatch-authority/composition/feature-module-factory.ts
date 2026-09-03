import { createContainedTurnDispatchAuthority } from "../application/contained-turn-dispatch-authority.js";
import type { DispatchControlClock } from "../application/ports/outbound/control-clock.js";
import type { DispatchConsumptionRepository } from "../application/ports/outbound/dispatch-consumption-repository.js";
import type { DispatchDigest } from "../application/ports/outbound/dispatch-digest.js";
import { createNodeDispatchAuthorityOperations, detachDispatchBoundaryValue } from
  "./node-dispatch-boundary.js";

export interface ContainedTurnDispatchAuthorityFeatureDependencies {
  readonly repository: DispatchConsumptionRepository;
  readonly clock: DispatchControlClock;
  readonly digest: DispatchDigest;
}

export const createContainedTurnDispatchAuthorityFeature = (
  dependencies: ContainedTurnDispatchAuthorityFeatureDependencies,
) => {
  const authority = createContainedTurnDispatchAuthority(
    createNodeDispatchAuthorityOperations(dependencies),
  );
  return Object.freeze({
    dispatchAuthorityV1: Object.freeze({
      async consumeForDispatch(input: Parameters<typeof authority.consumeForDispatch>[0]) {
        try {
          return await authority.consumeForDispatch(detachDispatchBoundaryValue(input) as never);
        } catch {
          return Object.freeze({ status: "indeterminate", reason: "owner_unavailable" } as const);
        }
      },
      observeDispatchConsumption:
        async (input: Parameters<typeof authority.observeDispatchConsumption>[0]) => {
          try {
            return await authority.observeDispatchConsumption(
              detachDispatchBoundaryValue(input) as never);
          } catch {
            return Object.freeze({ status: "indeterminate", reason: "owner_unavailable" } as const);
          }
        },
      settleDispatchConsumption:
        async (input: Parameters<typeof authority.settleDispatchConsumption>[0]) => {
          try {
            return await authority.settleDispatchConsumption(
              detachDispatchBoundaryValue(input) as never);
          } catch {
            return Object.freeze({ status: "invalid_request" } as const);
          }
        },
    }),
  });
};
