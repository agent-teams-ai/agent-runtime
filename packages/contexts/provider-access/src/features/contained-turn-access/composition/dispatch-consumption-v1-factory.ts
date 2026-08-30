import type {
  ContainedTurnDispatchConsumptionV1, ConsumeForDispatchInput, ConsumeForDispatchOutcome,
  ObserveDispatchConsumptionInput, SettleDispatchConsumptionInput, SettleDispatchConsumptionOutcome,
} from "../contracts/dispatch-consumption-v1.js";
import { createDispatchConsumptionUseCases } from "../application/dispatch-consumption-v1.js";
import type { DispatchConsumptionClock } from "../application/ports/outbound/dispatch-consumption-clock.js";
import type { DispatchConsumptionDigest } from "../application/ports/outbound/dispatch-consumption-digest.js";
import type { DispatchConsumptionRepository } from "../application/ports/outbound/dispatch-consumption-repository.js";
import { snapshotDispatchScope, type DispatchConsumeCommand } from "../domain/dispatch-consumption.js";

export interface DispatchConsumptionV1Dependencies {
  readonly clock: DispatchConsumptionClock;
  readonly digest: DispatchConsumptionDigest;
  readonly repository: DispatchConsumptionRepository;
}

const commandFromContract = (input: ConsumeForDispatchInput): DispatchConsumeCommand => {
  if (input.purpose !== "contained-turn.provider-dispatch/v1") throw new TypeError("purpose is invalid");
  if (input.provider !== "claude" && input.provider !== "codex") throw new TypeError("provider is invalid");
  const binding = input.binding;
  return Object.freeze({
    binding: Object.freeze({
      acceptedAuthorityDigest: binding.acceptedAuthorityDigest, accessRef: binding.accessRef,
      authorityHeadDigest: binding.authorityHeadDigest, bindingDigest: binding.bindingDigest,
      bindingRevision: binding.bindingRevision, credentialBindingDigest: binding.credentialBindingDigest,
      credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
      providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef,
    }),
    claimBindingDigest: input.claimBindingDigest, grantRequestId: input.grantRequestId,
    operationId: input.operationId, provider: input.provider, purpose: input.purpose,
    requestDigest: input.requestDigest, scope: snapshotDispatchScope(input.scope),
  });
};

export const createContainedTurnDispatchConsumptionV1 = (
  dependencies: DispatchConsumptionV1Dependencies,
): ContainedTurnDispatchConsumptionV1 => {
  const useCases = createDispatchConsumptionUseCases(dependencies);
  return Object.freeze({
    async consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> {
      try { return await useCases.consume(commandFromContract(input)); }
      catch { return Object.freeze({ kind: "indeterminate" }); }
    },
    async observeDispatchConsumption(input: ObserveDispatchConsumptionInput) {
      try {
        const scope = snapshotDispatchScope(input.scope);
        return await useCases.observe({ grantRequestId: input.grantRequestId, requestDigest: input.requestDigest, scope });
      } catch { return Object.freeze({ kind: "indeterminate" as const }); }
    },
    async settleDispatchConsumption(input: SettleDispatchConsumptionInput): Promise<SettleDispatchConsumptionOutcome> {
      try {
        if (input.disposition !== "claim_committed" && input.disposition !== "abandoned_without_claim") throw new TypeError("disposition is invalid");
        return await useCases.settle(input);
      } catch { return Object.freeze({ kind: "indeterminate" }); }
    },
  });
};
