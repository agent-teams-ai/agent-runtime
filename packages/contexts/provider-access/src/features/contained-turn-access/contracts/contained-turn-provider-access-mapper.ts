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

const bindingEvidence = (binding: ContainedTurnProviderAccessBinding) => Object.freeze({
  authorityDigest: binding.credentialBindingDigest,
  proofRef: `binding:${binding.accessRef}:revision:${binding.revision}`,
});

const rejectionEvidence = (reason: string) => Object.freeze({
  authorityDigest: `authority-observation:${reason}`,
  proofRef: `observation:${reason}`,
});

export const resolveCommandFromContract = (input: {
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}): ResolveProviderAccessCommand => Object.freeze({
  provider: snapshotProviderAccessProvider(input.provider),
  scope: snapshotProviderAccessScope(input.scope),
});

export const resolveResultToContract = (
  result: ResolveProviderAccessResult,
): ResolveContainedTurnProviderAccessOutcome => {
  if (result.kind !== "resolved") {
    return Object.freeze({ evidence: rejectionEvidence(result.reason), kind: "unavailable", reason: result.reason });
  }
  const binding = bindingToContract(result.binding);
  return Object.freeze({ binding, evidence: bindingEvidence(binding), kind: "resolved" });
};

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
): RevalidateContainedTurnProviderAccessOutcome => {
  if (result.kind !== "valid") {
    return Object.freeze({ evidence: rejectionEvidence(result.reason), kind: "rejected", reason: result.reason });
  }
  const binding = bindingToContract(result.binding);
  return Object.freeze({ binding, evidence: bindingEvidence(binding), kind: "valid" });
};
