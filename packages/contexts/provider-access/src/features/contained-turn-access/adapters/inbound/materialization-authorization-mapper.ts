import type {
  AuthorizeCredentialMaterializationInput, AuthorizeCredentialMaterializationOutcome,
  CredentialMaterializationAuthorizationReceipt, CredentialMaterializationAuthorizationV1,
  ObserveCredentialMaterializationAuthorizationInput, ObserveCredentialMaterializationAuthorizationOutcome,
} from "../../contracts/materialization-authorization-v1.js";
import type {
  AuthorizationOutcome, MaterializationAuthorizationUseCase, ObservationOutcome,
} from "../../application/materialization-authorization-v1.js";
import {
  UnsupportedAuthorizationInputError, snapshotAuthorizationCommand, snapshotAuthorizationOwnerSelector,
  type AuthorizationRecord,
} from "../../domain/materialization-authorization.js";
import { detachedDispatchData } from "../dispatch-consumption-data.js";

/** Fresh public projection: domain records never cross the inbound boundary directly. */
const receiptDto = (record: AuthorizationRecord): CredentialMaterializationAuthorizationReceipt => Object.freeze({
  accessRef: record.accessRef, authorizationRequestId: record.authorizationRequestId, availability: record.availability,
  bindingRevision: record.bindingRevision, credentialBindingDigest: record.credentialBindingDigest,
  credentialBindingRef: record.credentialBindingRef, credentialGeneration: record.credentialGeneration,
  decision: record.decision, projectId: record.projectId, provider: record.provider,
  providerAccountRef: record.providerAccountRef, providerRouteRef: record.providerRouteRef, purpose: record.purpose,
  rejectionReason: record.rejectionReason, requestDigest: record.requestDigest, revocation: record.revocation,
  schemaVersion: record.schemaVersion, scopeDigest: record.scopeDigest, tenantId: record.tenantId,
});

const authorizationDto = (outcome: AuthorizationOutcome): AuthorizeCredentialMaterializationOutcome => {
  if (outcome.kind === "authorized" || outcome.kind === "observed") {
    return Object.freeze({ kind: outcome.kind, receipt: receiptDto(outcome.receipt) });
  }
  if (outcome.kind === "rejected") {
    return Object.freeze({ kind: "rejected", reason: outcome.reason, receipt: receiptDto(outcome.receipt) });
  }
  if (outcome.kind === "conflict") {return Object.freeze({ kind: "conflict", reason: outcome.reason });}
  if (outcome.kind === "invalid") {return Object.freeze({ kind: "invalid", reason: outcome.reason });}
  return Object.freeze({ kind: "indeterminate" });
};

const observationDto = (outcome: ObservationOutcome): ObserveCredentialMaterializationAuthorizationOutcome =>
  outcome.kind === "observed"
    ? Object.freeze({ kind: "observed", receipt: receiptDto(outcome.receipt) })
    : Object.freeze({ kind: "indeterminate" });

export const createCredentialMaterializationAuthorizationAdapter = (
  useCase: MaterializationAuthorizationUseCase,
): CredentialMaterializationAuthorizationV1 => Object.freeze({
  async authorize(input: AuthorizeCredentialMaterializationInput): Promise<AuthorizeCredentialMaterializationOutcome> {
    try {
      const command = snapshotAuthorizationCommand(detachedDispatchData("authorization command", input));
      return authorizationDto(await useCase.authorize(command));
    } catch (error) {
      if (error instanceof UnsupportedAuthorizationInputError) {
        return Object.freeze({ kind: "unsupported", reason: error.reason });
      }
      return Object.freeze({ kind: "invalid", reason: "invalid_request" });
    }
  },
  async observe(input: ObserveCredentialMaterializationAuthorizationInput): Promise<ObserveCredentialMaterializationAuthorizationOutcome> {
    try {
      return observationDto(await useCase.observe(snapshotAuthorizationOwnerSelector(
        detachedDispatchData("authorization selector", input),
      )));
    } catch (error) {
      if (error instanceof UnsupportedAuthorizationInputError) {
        return Object.freeze({ kind: "unsupported", reason: "unsupported_provider" });
      }
      return Object.freeze({ kind: "indeterminate" });
    }
  },
});
