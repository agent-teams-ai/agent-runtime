import { snapshotExactDispatchRecord } from "./dispatch-exact-record.js";

export interface DispatchAuthorityScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scopeDigest: string;
}

export interface DispatchConsumeRequest {
  readonly purpose: "contained-turn.provider-dispatch/v1";
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly providerBindingDigest: string;
  readonly claimBindingDigest: string;
  readonly acceptedAuthorityDigest: string;
  readonly expectedAuthorityHeadDigest: string;
  readonly expectedAuthorityRevision: string;
  readonly expectedConstraintsDigest: string;
  readonly expectedContainmentPolicyDigest: string;
}

export type DispatchPreventionReason =
  | "accepted_authority_changed"
  | "already_consumed"
  | "authority_revision_stale"
  | "claim_binding_mismatch"
  | "constraints_drift"
  | "containment_policy_drift"
  | "expired"
  | "invalid_request"
  | "provider_binding_mismatch"
  | "request_digest_mismatch"
  | "revoked";

export interface DispatchAuthorityHead {
  readonly decision: "accepted";
  readonly purpose: "contained-turn.provider-dispatch/v1";
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly authorityRevision: string;
  readonly acceptedAuthorityDigest: string;
  readonly authorityHeadDigest: string;
  readonly constraintsDigest: string;
  readonly containmentPolicyDigest: string;
  readonly requestDigest: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly providerBindingDigest: string;
  readonly claimBindingDigest: string;
  readonly claimBeforeControlTime: number;
  readonly revoked: boolean;
  readonly ownerEvidenceRef: string;
}

const authorityFieldNames = [
  "decision", "purpose", "operationId", "scope", "authorityRevision",
  "acceptedAuthorityDigest", "authorityHeadDigest", "constraintsDigest",
  "containmentPolicyDigest", "requestDigest", "providerId", "authorityGeneration",
  "providerBindingDigest", "claimBindingDigest",
  "claimBeforeControlTime", "revoked", "ownerEvidenceRef",
] as const;

const scopeFieldNames = ["tenantId", "projectId", "scopeDigest"] as const;

/** Captures an untrusted persisted head once before any semantic reads. */
export const snapshotDispatchAuthorityHead = (
  value: unknown,
): DispatchAuthorityHead | undefined => {
  const head = snapshotExactDispatchRecord(value, authorityFieldNames);
  if (head === undefined) {return undefined;}
  const scope = snapshotExactDispatchRecord(head.scope, scopeFieldNames);
  if (scope === undefined) {return undefined;}
  const snapshot: DispatchAuthorityHead = {
    decision: head.decision as DispatchAuthorityHead["decision"],
    purpose: head.purpose as DispatchAuthorityHead["purpose"],
    operationId: head.operationId as string,
    scope: Object.freeze({
      tenantId: scope.tenantId as string,
      projectId: scope.projectId as string,
      scopeDigest: scope.scopeDigest as string,
    }),
    authorityRevision: head.authorityRevision as string,
    acceptedAuthorityDigest: head.acceptedAuthorityDigest as string,
    authorityHeadDigest: head.authorityHeadDigest as string,
    constraintsDigest: head.constraintsDigest as string,
    containmentPolicyDigest: head.containmentPolicyDigest as string,
    requestDigest: head.requestDigest as string,
    providerId: head.providerId as string,
    authorityGeneration: head.authorityGeneration as string,
    providerBindingDigest: head.providerBindingDigest as string,
    claimBindingDigest: head.claimBindingDigest as string,
    claimBeforeControlTime: head.claimBeforeControlTime as number,
    revoked: head.revoked as boolean,
    ownerEvidenceRef: head.ownerEvidenceRef as string,
  };
  return validAuthorityHead(snapshot) ? Object.freeze(snapshot) : undefined;
};

const boundedOpaque = (value: string): boolean =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");

export const validDispatchOwnerEvidenceRef = (value: unknown): value is string =>
  typeof value === "string" &&
  boundedOpaque(value) &&
  value.startsWith("runtime-security-evidence:v1:") &&
  !value.includes("/") &&
  !value.includes("\\");

export const validConsumeInput = (input: DispatchConsumeRequest): boolean =>
  input.purpose === "contained-turn.provider-dispatch/v1" &&
  [
    input.operationId,
    input.scope.tenantId,
    input.scope.projectId,
    input.scope.scopeDigest,
    input.grantRequestId,
    input.requestDigest,
    input.providerId,
    input.authorityGeneration,
    input.providerBindingDigest,
    input.claimBindingDigest,
    input.acceptedAuthorityDigest,
    input.expectedAuthorityHeadDigest,
    input.expectedAuthorityRevision,
    input.expectedConstraintsDigest,
    input.expectedContainmentPolicyDigest,
  ].every(boundedOpaque);

export const validAuthorityHead = (head: DispatchAuthorityHead): boolean => {
  const revoked = Object.getOwnPropertyDescriptor(head, "revoked");
  return revoked !== undefined &&
  "value" in revoked &&
  typeof revoked.value === "boolean" &&
  head.decision === "accepted" &&
  head.purpose === "contained-turn.provider-dispatch/v1" &&
  Number.isSafeInteger(head.claimBeforeControlTime) &&
  head.claimBeforeControlTime >= 0 &&
  validDispatchOwnerEvidenceRef(head.ownerEvidenceRef) &&
  [
    head.operationId,
    head.scope.tenantId,
    head.scope.projectId,
    head.scope.scopeDigest,
    head.authorityRevision,
    head.acceptedAuthorityDigest,
    head.authorityHeadDigest,
    head.constraintsDigest,
    head.containmentPolicyDigest,
    head.requestDigest,
    head.providerId,
    head.authorityGeneration,
    head.providerBindingDigest,
    head.claimBindingDigest,
  ].every(boundedOpaque);
};

export const sameScope = (
  left: DispatchAuthorityScope,
  right: DispatchAuthorityScope,
): boolean =>
  left.tenantId === right.tenantId &&
  left.projectId === right.projectId &&
  left.scopeDigest === right.scopeDigest;

export const preventionReason = (
  input: DispatchConsumeRequest,
  head: DispatchAuthorityHead,
  controlTime: number,
): DispatchPreventionReason | undefined => {
  if (!validConsumeInput(input) || !validAuthorityHead(head)) {return "invalid_request";}
  if (head.revoked) {return "revoked";}
  if (controlTime >= head.claimBeforeControlTime) {return "expired";}
  if (input.expectedAuthorityRevision !== head.authorityRevision) {
    return "authority_revision_stale";
  }
  if (
    input.acceptedAuthorityDigest !== head.acceptedAuthorityDigest ||
    input.expectedAuthorityHeadDigest !== head.authorityHeadDigest
  ) {
    return "accepted_authority_changed";
  }
  if (input.expectedConstraintsDigest !== head.constraintsDigest) {
    return "constraints_drift";
  }
  if (input.expectedContainmentPolicyDigest !== head.containmentPolicyDigest) {
    return "containment_policy_drift";
  }
  if (input.requestDigest !== head.requestDigest) {return "request_digest_mismatch";}
  if (input.providerId !== head.providerId ||
      input.authorityGeneration !== head.authorityGeneration) {
    return "accepted_authority_changed";
  }
  if (input.providerBindingDigest !== head.providerBindingDigest) {
    return "provider_binding_mismatch";
  }
  if (input.claimBindingDigest !== head.claimBindingDigest) {
    return "claim_binding_mismatch";
  }
  return undefined;
};
