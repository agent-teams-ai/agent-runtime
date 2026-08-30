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
import { exactProviderAccessDataRecord } from "../boundary/exact-provider-access-data.js";

const CONTRACT_BINDING_KEYS = [
  "accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "projectId", "provider",
  "providerAccountRef", "providerRouteRef", "revision", "tenantId",
] as const;

const exactContractBinding = (value: unknown): Record<string, unknown> => {
  try { return exactProviderAccessDataRecord("contract binding", value, CONTRACT_BINDING_KEYS); }
  catch {
    // Route C's accepted ACL carries this duplicate opaque digest on its legacy
    // structural DTO. It is known compatibility data only when it exactly agrees
    // with the published credential-binding digest; every other extra field fails.
    const data = exactProviderAccessDataRecord("contract binding", value, [...CONTRACT_BINDING_KEYS, "ownerAuthorityDigest"]);
    if (data.ownerAuthorityDigest !== data.credentialBindingDigest) {
      throw new TypeError("legacy owner authority digest is inconsistent");
    }
    return data;
  }
};

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
}): ResolveProviderAccessCommand => {
  const data = exactProviderAccessDataRecord("resolve input", input, ["provider", "scope"]);
  return Object.freeze({
    provider: snapshotProviderAccessProvider(data.provider),
    scope: snapshotProviderAccessScope(data.scope as ProviderAccessScope),
  });
};

export const resolveResultToContract = (
  result: ResolveProviderAccessResult,
): ResolveContainedTurnProviderAccessOutcome => {
  const kindDescriptor = result !== null && typeof result === "object"
    ? Object.getOwnPropertyDescriptor(result, "kind") : undefined;
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) { throw new TypeError("resolve result kind is invalid"); }
  if (kindDescriptor.value !== "resolved") {
    const data = exactProviderAccessDataRecord("resolve result", result, ["kind", "reason"]);
    if (data.kind !== "unavailable" || !["indeterminate", "not_found", "revoked", "unavailable"].includes(data.reason as string)) {
      throw new TypeError("resolve result is invalid");
    }
    const reason = data.reason as "indeterminate" | "not_found" | "revoked" | "unavailable";
    return Object.freeze({ evidence: rejectionEvidence(reason, "acceptance"), kind: "unavailable", reason });
  }
  const data = exactProviderAccessDataRecord("resolve result", result, ["binding", "kind"]);
  const binding = bindingToContract(data.binding as never);
  return Object.freeze({ binding, evidence: bindingEvidence(binding, "acceptance"), kind: "resolved" });
};

export const revalidateCommandFromContract = (input: {
  readonly binding: ContainedTurnProviderAccessBinding;
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}): RevalidateProviderAccessCommand => {
  const data = exactProviderAccessDataRecord("revalidate input", input, ["binding", "provider", "scope"]);
  const binding = exactContractBinding(data.binding);
  return Object.freeze({
    binding: snapshotProviderAccessBinding({
    accessRef: binding.accessRef, credentialBindingDigest: binding.credentialBindingDigest,
    credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
    projectId: binding.projectId, provider: binding.provider, providerAccountRef: binding.providerAccountRef,
    providerRouteRef: binding.providerRouteRef, revision: binding.revision, tenantId: binding.tenantId,
    availability: "available",
    revocation: "active",
    } as never),
    provider: snapshotProviderAccessProvider(data.provider),
    scope: snapshotProviderAccessScope(data.scope as ProviderAccessScope),
  });
};

export const revalidateResultToContract = (
  result: RevalidateProviderAccessResult,
): RevalidateContainedTurnProviderAccessOutcome => {
  const kindDescriptor = result !== null && typeof result === "object"
    ? Object.getOwnPropertyDescriptor(result, "kind") : undefined;
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) { throw new TypeError("revalidate result kind is invalid"); }
  if (kindDescriptor.value !== "valid") {
    const data = exactProviderAccessDataRecord("revalidate result", result, ["kind", "reason"]);
    const reasons = [
      "access_changed", "account_changed", "credential_changed", "credential_rotated", "indeterminate", "not_found",
      "provider_mismatch", "revision_changed", "revoked", "route_changed", "scope_mismatch", "unavailable",
    ] as const;
    if (data.kind !== "rejected" || !reasons.includes(data.reason as typeof reasons[number])) {
      throw new TypeError("revalidate result is invalid");
    }
    const reason = data.reason as typeof reasons[number];
    return Object.freeze({ evidence: rejectionEvidence(reason, "dispatch"), kind: "rejected", reason });
  }
  const data = exactProviderAccessDataRecord("revalidate result", result, ["binding", "kind"]);
  const binding = bindingToContract(data.binding as never);
  return Object.freeze({ binding, evidence: bindingEvidence(binding, "dispatch"), kind: "valid" });
};
