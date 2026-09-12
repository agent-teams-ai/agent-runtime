import type { ProviderAccessBindingRepository } from "../../../application/ports/outbound/provider-access-binding-repository.js";
import type { MaterializationAuthorizationBinding } from "../../../application/ports/outbound/materialization-authorization-repository.js";
import { snapshotProviderAccessBinding } from "../../../domain/provider-access-binding.js";
import { snapshotAuthorizationOwnerSelector } from "../../../domain/materialization-authorization.js";
import { exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import type { MaterializationPostgresOwner } from "./materialization-postgres-repository.js";

/** Private PA projection. One operation's scope digest is fixed by PA composition. */
export const createMaterializationBindingRepository = (
  observeBinding: (owner: MaterializationPostgresOwner) => Promise<MaterializationAuthorizationBinding | undefined>,
  input: MaterializationPostgresOwner,
): ProviderAccessBindingRepository => {
  const values = exactDispatchDataRecord("PA binding scope", input, ["tenantId", "projectId", "provider", "scopeDigest"]);
  const {authorizationRequestId: _id, requestDigest: _digest, ...owner} = snapshotAuthorizationOwnerSelector({
    ...values, authorizationRequestId: "database:binding-observation", requestDigest: "database:binding-observation",
  });
  Object.freeze(owner);
  return Object.freeze<ProviderAccessBindingRepository>({
    async observeExact({provider, scope}) {
      if (provider !== owner.provider || scope.tenantId !== owner.tenantId || scope.projectId !== owner.projectId) {
        return Object.freeze({kind: "not_found" as const});
      }
      try {
        const binding = await observeBinding(owner);
        if (binding === undefined) {return Object.freeze({kind: "not_found" as const});}
        if (binding.provider !== owner.provider || binding.tenantId !== owner.tenantId ||
          binding.projectId !== owner.projectId || binding.scopeDigest !== owner.scopeDigest) {
          return Object.freeze({kind: "indeterminate" as const});
        }
        return Object.freeze({kind: "found" as const, record: snapshotProviderAccessBinding({
          accessRef: binding.accessRef, availability: binding.availability,
          credentialBindingDigest: binding.credentialBindingDigest, credentialBindingRef: binding.credentialBindingRef,
          credentialGeneration: binding.credentialGeneration, projectId: binding.projectId, provider: binding.provider,
          providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef,
          revision: binding.bindingRevision, revocation: binding.revocation, tenantId: binding.tenantId,
        })});
      } catch {return Object.freeze({kind: "indeterminate" as const});}
    },
  });
};
