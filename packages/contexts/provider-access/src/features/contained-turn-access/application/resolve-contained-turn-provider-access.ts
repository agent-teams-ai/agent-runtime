import type {
  ProviderAccessBindingRecord,
  ProviderAccessProviderValue,
  ProviderAccessScopeValue,
} from "../domain/provider-access-binding.js";
import type { ProviderAccessBindingRepository } from "./ports/outbound/provider-access-binding-repository.js";

export interface ResolveProviderAccessCommand {
  readonly provider: ProviderAccessProviderValue;
  readonly scope: ProviderAccessScopeValue;
}

export type ResolveProviderAccessResult =
  | { readonly binding: ProviderAccessBindingRecord; readonly kind: "resolved" }
  | { readonly kind: "unavailable"; readonly reason: "indeterminate" | "not_found" | "revoked" | "unavailable" };

export interface ResolveProviderAccessUseCase {
  execute(command: ResolveProviderAccessCommand): Promise<ResolveProviderAccessResult>;
}

export const createResolveContainedTurnProviderAccess = (
  repository: ProviderAccessBindingRepository,
): ResolveProviderAccessUseCase => Object.freeze({
  async execute(command: ResolveProviderAccessCommand): Promise<ResolveProviderAccessResult> {
    const observation = await repository.observeExact(command);
    if (observation.kind !== "found") {
      return Object.freeze({ kind: "unavailable", reason: observation.kind });
    }
    const binding = observation.record;
    if (
      binding.tenantId !== command.scope.tenantId
      || binding.projectId !== command.scope.projectId
      || binding.provider !== command.provider
    ) {
      return Object.freeze({ kind: "unavailable", reason: "indeterminate" });
    }
    if (binding.revocation === "revoked") {
      return Object.freeze({ kind: "unavailable", reason: "revoked" });
    }
    if (binding.availability !== "available") {
      return Object.freeze({ kind: "unavailable", reason: "unavailable" });
    }
    return Object.freeze({ binding, kind: "resolved" });
  },
});
