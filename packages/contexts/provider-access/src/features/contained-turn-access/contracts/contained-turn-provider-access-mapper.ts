import type {
  ContainedTurnProviderAccessBinding,
  ProviderAccessProvider,
  ProviderAccessScope,
  RevalidateContainedTurnProviderAccessOutcome,
  ResolveContainedTurnProviderAccessOutcome,
} from "./contained-turn-provider-access.js";
import type {
  RevalidateProviderAccessCommand,
  RevalidateProviderAccessResult,
} from "../application/revalidate-contained-turn-provider-access.js";
import type {
  ResolveProviderAccessCommand,
  ResolveProviderAccessResult,
} from "../application/resolve-contained-turn-provider-access.js";
import {
  snapshotProviderAccessBinding,
  snapshotProviderAccessProvider,
  snapshotProviderAccessScope,
} from "../domain/provider-access-binding.js";

const bindingToContract = (
  binding: ReturnType<typeof snapshotProviderAccessBinding>,
): ContainedTurnProviderAccessBinding => {
  const snapshot = snapshotProviderAccessBinding(binding);
  return Object.freeze({
    accessRef: snapshot.accessRef,
    credentialBindingDigest: snapshot.credentialBindingDigest,
    credentialBindingRef: snapshot.credentialBindingRef,
    credentialGeneration: snapshot.credentialGeneration,
    projectId: snapshot.projectId,
    provider: snapshot.provider,
    providerAccountRef: snapshot.providerAccountRef,
    providerRouteRef: snapshot.providerRouteRef,
    revision: snapshot.revision,
    tenantId: snapshot.tenantId,
  });
};

export const resolveCommandFromContract = (input: {
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}): ResolveProviderAccessCommand => Object.freeze({
  provider: snapshotProviderAccessProvider(input.provider),
  scope: snapshotProviderAccessScope(input.scope),
});

export const resolveResultToContract = (
  result: ResolveProviderAccessResult,
): ResolveContainedTurnProviderAccessOutcome => result.kind === "resolved"
  ? Object.freeze({ binding: bindingToContract(result.binding), kind: "resolved" })
  : Object.freeze({ kind: "unavailable", reason: result.reason });

export const revalidateCommandFromContract = (input: {
  readonly binding: ContainedTurnProviderAccessBinding;
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}): RevalidateProviderAccessCommand => Object.freeze({
  binding: snapshotProviderAccessBinding({
    ...input.binding,
    availability: "available",
    revocation: "active",
  }),
  provider: snapshotProviderAccessProvider(input.provider),
  scope: snapshotProviderAccessScope(input.scope),
});

export const revalidateResultToContract = (
  result: RevalidateProviderAccessResult,
): RevalidateContainedTurnProviderAccessOutcome => result.kind === "valid"
  ? Object.freeze({ binding: bindingToContract(result.binding), kind: "valid" })
  : Object.freeze({ kind: "rejected", reason: result.reason });
