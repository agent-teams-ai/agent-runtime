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

const bindingEvidence = (
  binding: ContainedTurnProviderAccessBinding,
  purpose: "acceptance" | "dispatch",
) => Object.freeze({
  authorityDigest: JSON.stringify({
    binding: {
      accessRef: binding.accessRef,
      credentialBindingDigest: binding.credentialBindingDigest,
      credentialBindingRef: binding.credentialBindingRef,
      credentialGeneration: binding.credentialGeneration,
      projectId: binding.projectId,
      provider: binding.provider,
      providerAccountRef: binding.providerAccountRef,
      providerRouteRef: binding.providerRouteRef,
      revision: binding.revision,
      tenantId: binding.tenantId,
    },
    purpose,
    version: 1,
  }),
  bindingAuthorityDigest: binding.credentialBindingDigest,
  proofRef: `binding:${binding.accessRef}:revision:${binding.revision}:purpose:${purpose}`,
  purpose,
});

const rejectionEvidence = (reason: string, purpose: "acceptance" | "dispatch") => Object.freeze({
  authorityDigest: JSON.stringify({ purpose, reason, version: 1 }),
  bindingAuthorityDigest: `authority-observation:${reason}`,
  proofRef: `observation:${reason}:purpose:${purpose}`,
  purpose,
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
    return Object.freeze({ evidence: rejectionEvidence(result.reason, "acceptance"), kind: "unavailable", reason: result.reason });
  }
  const binding = bindingToContract(result.binding);
  return Object.freeze({ binding, evidence: bindingEvidence(binding, "acceptance"), kind: "resolved" });
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
    return Object.freeze({ evidence: rejectionEvidence(result.reason, "dispatch"), kind: "rejected", reason: result.reason });
  }
  const binding = bindingToContract(result.binding);
  return Object.freeze({ binding, evidence: bindingEvidence(binding, "dispatch"), kind: "valid" });
};
