import type { MaterializationAuthorizationDigest } from "./ports/outbound/materialization-authorization-digest.js";
import type {
  MaterializationAuthorizationBinding, MaterializationAuthorizationRepository, MaterializationAuthorizationRequestSelector,
  MaterializationAuthorizationTransaction,
} from "./ports/outbound/materialization-authorization-repository.js";
import {
  AUTHORIZATION_COMMAND_KEYS, authorizationRequestPayload, sameAuthorizationOwner, snapshotAuthorizationRecord,
  type AuthorizationCommand, type AuthorizationOwnerSelector, type AuthorizationRecord, type AuthorizationRejectionReason,
} from "../domain/materialization-authorization.js";

export interface MaterializationAuthorizationDependencies {
  readonly digest: MaterializationAuthorizationDigest;
  readonly repository: MaterializationAuthorizationRepository;
}

export type AuthorizationOutcome =
  | { readonly kind: "authorized" | "observed"; readonly receipt: AuthorizationRecord }
  | { readonly kind: "conflict"; readonly reason: "authorization_request_digest_conflict" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "rejected"; readonly reason: AuthorizationRejectionReason; readonly receipt: AuthorizationRecord };
export type ObservationOutcome =
  | { readonly kind: "indeterminate" }
  | { readonly kind: "observed"; readonly receipt: AuthorizationRecord }
  | { readonly kind: "rejected"; readonly reason: AuthorizationRejectionReason; readonly receipt: AuthorizationRecord };

export interface MaterializationAuthorizationUseCase {
  authorize(command: AuthorizationCommand): Promise<AuthorizationOutcome>;
  observe(selector: AuthorizationOwnerSelector): Promise<ObservationOutcome>;
}

const unsigned = (command: AuthorizationCommand): Omit<AuthorizationCommand, "requestDigest"> => {
  const copy = Object.fromEntries(AUTHORIZATION_COMMAND_KEYS.map(key => [key, command[key]]));
  delete copy.requestDigest;
  return copy as Omit<AuthorizationCommand, "requestDigest">;
};
const validDigest = async (digest: MaterializationAuthorizationDigest, command: AuthorizationCommand): Promise<boolean> => {
  const value = await digest.digest(authorizationRequestPayload(unsigned(command)));
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {throw new TypeError("digest result is invalid");}
  return value === command.requestDigest;
};
const recordMatchesRequest = (record: AuthorizationRecord, command: AuthorizationCommand): boolean =>
  authorizationRequestPayload(unsigned(record)) === authorizationRequestPayload(unsigned(command)) && record.requestDigest === command.requestDigest;

const rejectionFor = (command: AuthorizationCommand, binding: MaterializationAuthorizationBinding | undefined): AuthorizationRejectionReason | undefined => {
  if (binding === undefined) {return "access_not_available";}
  if (binding.accessRef !== command.accessRef) {return "access_changed";}
  if (binding.providerAccountRef !== command.providerAccountRef) {return "account_changed";}
  if (binding.providerRouteRef !== command.providerRouteRef) {return "route_changed";}
  if (binding.bindingRevision !== command.bindingRevision) {return "binding_revision_changed";}
  if (binding.credentialBindingRef !== command.credentialBindingRef || binding.credentialBindingDigest !== command.credentialBindingDigest) {
    return "credential_binding_changed";
  }
  if (binding.credentialGeneration !== command.credentialGeneration) {return "credential_generation_changed";}
  if (binding.revocation !== "active" || command.revocation !== "active") {return "revoked";}
  if (binding.availability !== "available" || command.availability !== "available") {return "availability_changed";}
  return undefined;
};

const requestSelector = (selector: AuthorizationOwnerSelector): MaterializationAuthorizationRequestSelector => Object.freeze({
  authorizationRequestId: selector.authorizationRequestId, projectId: selector.projectId, provider: selector.provider,
  scopeDigest: selector.scopeDigest, tenantId: selector.tenantId,
});
const bindingOwnerMatches = (binding: MaterializationAuthorizationBinding, owner: AuthorizationOwnerSelector): boolean =>
  binding.tenantId === owner.tenantId && binding.projectId === owner.projectId && binding.provider === owner.provider &&
  binding.scopeDigest === owner.scopeDigest;

const currentMeaning = (
  existing: AuthorizationRecord, binding: MaterializationAuthorizationBinding | undefined,
): Exclude<ObservationOutcome, { readonly kind: "indeterminate" }> => {
  if (existing.decision === "rejected") {
    return Object.freeze({ kind: "rejected", reason: existing.rejectionReason as AuthorizationRejectionReason, receipt: existing });
  }
  const reason = rejectionFor(existing, binding);
  return reason === undefined
    ? Object.freeze({ kind: "observed", receipt: existing })
    : Object.freeze({ kind: "rejected", reason, receipt: existing });
};

const decide = async (
  command: AuthorizationCommand, transaction: MaterializationAuthorizationTransaction,
  dependencies: MaterializationAuthorizationDependencies,
): Promise<AuthorizationOutcome> => {
  const rawExisting = await transaction.findAuthorizationRequest();
  if (rawExisting !== undefined) {
    const existing = snapshotAuthorizationRecord(rawExisting);
    const ownerSelector: AuthorizationOwnerSelector = command;
    // Ownership precedes request-digest comparison to close the cross-owner existence oracle.
    if (!sameAuthorizationOwner(existing, ownerSelector)) {return Object.freeze({ kind: "indeterminate" });}
    if (!await validDigest(dependencies.digest, existing)) {throw new TypeError("authorization record digest mismatch");}
    if (!recordMatchesRequest(existing, command)) {
      return Object.freeze({ kind: "conflict", reason: "authorization_request_digest_conflict" });
    }
    const binding = await transaction.findBinding();
    if (binding !== undefined && !bindingOwnerMatches(binding, command)) {throw new TypeError("authorization binding owner mismatch");}
    return currentMeaning(existing, binding);
  }
  if (!await validDigest(dependencies.digest, command)) {return Object.freeze({ kind: "invalid", reason: "invalid_request" });}
  const binding = await transaction.findBinding();
  if (binding !== undefined && !bindingOwnerMatches(binding, command)) {
    throw new TypeError("authorization binding owner mismatch");
  }
  const reason = rejectionFor(command, binding);
  const record = snapshotAuthorizationRecord({
    ...command, decision: reason === undefined ? "authorized" : "rejected", rejectionReason: reason ?? null,
  });
  await transaction.saveAuthorization(record);
  return reason === undefined
    ? Object.freeze({ kind: "authorized", receipt: record })
    : Object.freeze({ kind: "rejected", reason, receipt: record });
};

export const createCredentialMaterializationAuthorizationV1 = (
  dependencies: MaterializationAuthorizationDependencies,
): MaterializationAuthorizationUseCase => Object.freeze({
  async authorize(command: AuthorizationCommand): Promise<AuthorizationOutcome> {
    try {
      return await dependencies.repository.transact({
        authorizationRequestId: command.authorizationRequestId, projectId: command.projectId, provider: command.provider,
        scopeDigest: command.scopeDigest, tenantId: command.tenantId,
      }, transaction => decide(command, transaction, dependencies));
    } catch {return Object.freeze({ kind: "indeterminate" });}
  },
  async observe(selector: AuthorizationOwnerSelector): Promise<ObservationOutcome> {
    try {
      return await dependencies.repository.transact(requestSelector(selector), async transaction => {
        const raw = await transaction.findAuthorizationRequest();
        if (raw === undefined) {return Object.freeze({ kind: "indeterminate" });}
        const found = snapshotAuthorizationRecord(raw);
        // Repository scoping is authoritative; retain the owner check as a corrupt-adapter guard.
        if (!sameAuthorizationOwner(found, selector)) {throw new TypeError("authorization record owner mismatch");}
        if (!await validDigest(dependencies.digest, found) || found.requestDigest !== selector.requestDigest) {
          return Object.freeze({ kind: "indeterminate" });
        }
        const binding = await transaction.findBinding();
        if (binding !== undefined && !bindingOwnerMatches(binding, selector)) {throw new TypeError("authorization binding owner mismatch");}
        return currentMeaning(found, binding);
      });
    } catch {return Object.freeze({ kind: "indeterminate" });}
  },
});
