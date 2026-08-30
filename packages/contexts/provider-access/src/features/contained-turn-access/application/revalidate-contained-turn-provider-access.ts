import {
  type ProviderAccessBindingRecord,
  type ProviderAccessProviderValue,
  type ProviderAccessScopeValue,
} from "../domain/provider-access-binding.js";
import type { ProviderAccessBindingRepository } from "./ports/outbound/provider-access-binding-repository.js";
import { observeCanonicalProviderAccessBinding } from "./observe-provider-access-binding.js";

export interface RevalidateProviderAccessCommand {
  readonly binding: ProviderAccessBindingRecord;
  readonly provider: ProviderAccessProviderValue;
  readonly scope: ProviderAccessScopeValue;
}

export type RevalidateProviderAccessRejection =
  | "access_changed" | "account_changed" | "credential_changed" | "credential_rotated"
  | "indeterminate" | "not_found" | "provider_mismatch" | "revision_changed"
  | "revoked" | "route_changed" | "scope_mismatch" | "unavailable";

export type RevalidateProviderAccessResult =
  | { readonly binding: ProviderAccessBindingRecord; readonly kind: "valid" }
  | { readonly kind: "rejected"; readonly reason: RevalidateProviderAccessRejection };

export interface RevalidateProviderAccessUseCase {
  execute(command: RevalidateProviderAccessCommand): Promise<RevalidateProviderAccessResult>;
}

const rejected = (reason: RevalidateProviderAccessRejection): RevalidateProviderAccessResult =>
  Object.freeze({ kind: "rejected", reason });

export const createRevalidateContainedTurnProviderAccess = (
  repository: ProviderAccessBindingRepository,
): RevalidateProviderAccessUseCase => Object.freeze({
  async execute(command: RevalidateProviderAccessCommand): Promise<RevalidateProviderAccessResult> {
    const expected = command.binding;
    if (expected.tenantId !== command.scope.tenantId || expected.projectId !== command.scope.projectId) {
      return rejected("scope_mismatch");
    }
    if (expected.provider !== command.provider) {
      return rejected("provider_mismatch");
    }

    const observation = await observeCanonicalProviderAccessBinding(repository, {
      provider: command.provider,
      scope: command.scope,
    });
    if (observation.kind !== "found") {
      return rejected(observation.kind);
    }
    const current = observation.record;
    if (current.tenantId !== command.scope.tenantId || current.projectId !== command.scope.projectId) {
      return rejected("scope_mismatch");
    }
    if (current.provider !== command.provider) {
      return rejected("provider_mismatch");
    }
    if (current.revocation !== "active") { return rejected("revoked"); }
    if (current.availability !== "available") { return rejected("unavailable"); }
    if (current.accessRef !== expected.accessRef) { return rejected("access_changed"); }
    if (current.revision !== expected.revision) { return rejected("revision_changed"); }
    if (current.providerAccountRef !== expected.providerAccountRef) { return rejected("account_changed"); }
    if (current.providerRouteRef !== expected.providerRouteRef) { return rejected("route_changed"); }
    if (current.credentialGeneration !== expected.credentialGeneration) { return rejected("credential_rotated"); }
    if (
      current.credentialBindingRef !== expected.credentialBindingRef
      || current.credentialBindingDigest !== expected.credentialBindingDigest
    ) {
      return rejected("credential_changed");
    }
    return Object.freeze({ binding: current, kind: "valid" });
  },
});
