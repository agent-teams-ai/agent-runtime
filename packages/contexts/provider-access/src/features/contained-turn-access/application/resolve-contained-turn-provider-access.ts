import type {
  ResolveContainedTurnProviderAccess,
  ResolveContainedTurnProviderAccessOutcome,
} from "../contracts/contained-turn-provider-access.js";
import { providerAccessView } from "../domain/provider-access-binding.js";
import type { ProviderAccessBindingRepository } from "./ports/outbound/provider-access-binding-repository.js";

export const createResolveContainedTurnProviderAccess = (
  repository: ProviderAccessBindingRepository,
): ResolveContainedTurnProviderAccess => {
  const useCase: ResolveContainedTurnProviderAccess = {
    async execute(input): Promise<ResolveContainedTurnProviderAccessOutcome> {
    const record = await repository.find({
      projectId: input.scope.projectId,
      provider: input.provider,
      tenantId: input.scope.tenantId,
    });
    if (record === undefined) {return { kind: "unavailable", reason: "not_found" };}
    if (record.status !== "active") {return { kind: "unavailable", reason: "revoked" };}
    return { binding: providerAccessView(record), kind: "resolved" };
    },
  };
  return Object.freeze(useCase);
};
