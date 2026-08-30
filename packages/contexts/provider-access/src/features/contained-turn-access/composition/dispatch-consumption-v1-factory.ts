import type {
  ContainedTurnDispatchConsumptionV1, ConsumeForDispatchInput, ConsumeForDispatchOutcome,
  ObserveDispatchConsumptionInput, SettleDispatchConsumptionInput, SettleDispatchConsumptionOutcome,
} from "../contracts/dispatch-consumption-v1.js";
import { createDispatchConsumptionUseCases } from "../application/dispatch-consumption-v1.js";
import type { DispatchConsumptionDigest } from "../application/ports/outbound/dispatch-consumption-digest.js";
import type { DispatchConsumptionRepository } from "../application/ports/outbound/dispatch-consumption-repository.js";
import {
  consumeCommandFromContract, observeInputFromContract, settlementInputFromContract,
} from "../contracts/dispatch-consumption-input.js";

export interface DispatchConsumptionV1Dependencies {
  readonly digest: DispatchConsumptionDigest;
  readonly repository: DispatchConsumptionRepository;
}

export const createContainedTurnDispatchConsumptionV1 = (
  dependencies: DispatchConsumptionV1Dependencies,
): ContainedTurnDispatchConsumptionV1 => {
  const useCases = createDispatchConsumptionUseCases(dependencies);
  return Object.freeze({
    async consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> {
      let command;
      try { command = consumeCommandFromContract(input); }
      catch { return Object.freeze({ kind: "invalid" as const, reason: "invalid_request" as const }); }
      try { return await useCases.consume(command); }
      catch { return Object.freeze({ kind: "indeterminate" }); }
    },
    async observeDispatchConsumption(input: ObserveDispatchConsumptionInput) {
      let snapshot;
      try { snapshot = observeInputFromContract(input); }
      catch { return Object.freeze({ kind: "invalid" as const, reason: "invalid_request" as const }); }
      try { return await useCases.observe(snapshot); }
      catch { return Object.freeze({ kind: "indeterminate" as const }); }
    },
    async settleDispatchConsumption(input: SettleDispatchConsumptionInput): Promise<SettleDispatchConsumptionOutcome> {
      let snapshot;
      try { snapshot = settlementInputFromContract(input); }
      catch { return Object.freeze({ kind: "invalid" as const, reason: "invalid_request" as const }); }
      try { return await useCases.settle(snapshot); }
      catch { return Object.freeze({ kind: "indeterminate" }); }
    },
  });
};
