import { containedTurnScopeDigest } from "../domain/contained-turn-authority.js";
import { parseContainedTurnCanonicalDigest } from "../domain/contained-turn-codecs.js";
import type { ContainedTurnConsumedGrantReceipt, ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type {
  ContainedTurnCleanupPermit,
  ContainedTurnDispatchPreparation,
} from "../domain/contained-turn-dispatch-preparation.js";
import { CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT } from "../domain/contained-turn-dispatch-preparation.js";
import { validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "../domain/contained-turn-limits.js";
import { containedTurnOperationCutoffRevision } from "../domain/contained-turn-output-authority.js";
import {
  assertContainedTurnCanonicalArray,
  assertContainedTurnExactRecord,
  detachAndFreezeContainedTurnValue,
} from "../domain/contained-turn-record.js";
import { validateContainedTurnOperation } from "../domain/contained-turn-validation.js";
import type { ContainedTurnOwnerStoreAuthority } from "./ports/outbound/contained-turn-ports.js";
import { containedTurnOwnerStoreAuthorityMatches } from "./contained-turn-store-authority.js";

const PERMIT_KEYS = Object.freeze([
  "attemptId", "custodyId", "operationCutoffRevision", "operationId", "permitDigest", "permitId",
  "preparationToken", "preparedOperationRevision", "workspaceId",
]);

const PREPARATION_IDENTITY_KEYS = Object.freeze([
  "attemptId", "custodyId", "operationCutoffRevision", "operationId", "preparationToken",
  "preparedOperationRevision", "providerAccessGrantRequestId", "runtimeSecurityGrantRequestId", "workspaceId",
]);
const preparationIdentityKeys = (preparation: ContainedTurnDispatchPreparation): readonly string[] => {
  const descriptors = Object.getOwnPropertyDescriptors(preparation);
  return Object.freeze([
    ...PREPARATION_IDENTITY_KEYS,
    ...(descriptors.providerAccessConsumptionReceipt === undefined ? [] : ["providerAccessConsumptionReceipt"]),
    ...(descriptors.runtimeSecurityConsumptionReceipt === undefined ? [] : ["runtimeSecurityConsumptionReceipt"]),
  ]);
};

const requireOrdinaryRecord = (name: string, value: object, keys: readonly string[]): void => {
  assertContainedTurnExactRecord(name, value, keys);
};

const validConsumptionWindow = (receipt: ContainedTurnConsumedGrantReceipt): boolean =>
  Number.isSafeInteger(receipt.consumedAtControlTime) && Number.isSafeInteger(receipt.claimBeforeControlTime) &&
  receipt.consumedAtControlTime >= 0 && receipt.claimBeforeControlTime >= receipt.consumedAtControlTime;

const validatePreparationReceipts = (preparation: ContainedTurnDispatchPreparation): void => {
  for (const [owner, receipt, requestId] of [
    ["provider_access", preparation.providerAccessConsumptionReceipt, preparation.providerAccessGrantRequestId],
    ["runtime_security", preparation.runtimeSecurityConsumptionReceipt, preparation.runtimeSecurityGrantRequestId],
  ] as const) {
    if (receipt === undefined) {continue;}
    requireOrdinaryRecord("preparation consumption receipt", receipt, [
      "authorityFacts", "claimBeforeControlTime", "claimBindingDigest", "consumedAtControlTime",
      "consumptionDigest", "grantRequestDigest", "grantRequestId", "operationId", "owner",
      "ownerEvidenceRef", "provider", "purpose", "requestDigest", "scope", "validThroughOperationCutoffRevision",
    ]);
    requireOrdinaryRecord("consumption scope", receipt.scope, ["projectId", "scopeDigest", "tenantId"]);
    requireOrdinaryRecord("consumption authority", receipt.authorityFacts, owner === "provider_access"
      ? ["acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "bindingRevision",
        "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerAccountRef", "providerRouteRef"]
      : ["acceptedAuthorityDigest", "authorityGeneration", "authorityHeadDigest", "authorityRevision",
        "constraintsDigest", "containmentPolicyDigest", "providerBindingDigest", "providerId"]);
    for (const digest of [receipt.claimBindingDigest, receipt.grantRequestDigest, receipt.requestDigest]) {
      parseContainedTurnCanonicalDigest(digest);
    }
    for (const value of [receipt.provider, receipt.consumptionDigest, receipt.ownerEvidenceRef, receipt.scope.tenantId, receipt.scope.projectId]) {
      validateContainedTurnText("consumption identity", value, CONTAINED_TURN_LIMITS.text.identifier);
    }
    for (const [key, value] of Object.entries(receipt.authorityFacts)) {
      if (key === "bindingRevision" || key === "credentialGeneration") {
        if (!Number.isSafeInteger(value) || Number(value) < 0) {throw new TypeError("invalid consumption authority revision");}
      } else {validateContainedTurnText("consumption authority", value as string, CONTAINED_TURN_LIMITS.text.identifier);}
    }
    if (receipt.owner !== owner || receipt.operationId !== preparation.operationId ||
        receipt.grantRequestId !== requestId || receipt.grantRequestId !== `grant-request:${receipt.grantRequestDigest}` ||
        receipt.scope.scopeDigest !== containedTurnScopeDigest(receipt.scope) ||
        receipt.purpose !== "contained-turn.provider-dispatch/v1" ||
        containedTurnOperationCutoffRevision(receipt.validThroughOperationCutoffRevision) < preparation.operationCutoffRevision ||
        !validConsumptionWindow(receipt)) {
      throw new TypeError("preparation consumption receipt identity mismatch");
    }
  }
};

const validatePreparationIdentity = (preparation: ContainedTurnDispatchPreparation): void => {
  validatePreparationReceipts(preparation);
  validateContainedTurnIdentity("attempt", preparation.attemptId);
  validateContainedTurnIdentity("custody", preparation.custodyId);
  validateContainedTurnIdentity("operation", preparation.operationId);
  validateContainedTurnIdentity("preparation", preparation.preparationToken);
  validateContainedTurnIdentity("workspace", preparation.workspaceId);
  containedTurnOperationCutoffRevision(preparation.operationCutoffRevision);
  if (!Number.isSafeInteger(preparation.preparedOperationRevision) || preparation.preparedOperationRevision < 0) {
    throw new TypeError("dispatch preparation revision must be a non-negative safe integer");
  }
  if (preparation.providerAccessGrantRequestId !== null) {
    validateContainedTurnText(
      "Provider Access cleanup grant request ID",
      preparation.providerAccessGrantRequestId,
      CONTAINED_TURN_LIMITS.text.identifier,
    );
    if (!/^grant-request:sha256:[a-f0-9]{64}$/u.test(preparation.providerAccessGrantRequestId)) {
      throw new TypeError("Provider Access cleanup grant request ID must be digest-bound");
    }
  }
  if (preparation.runtimeSecurityGrantRequestId !== null) {
    validateContainedTurnText(
      "Runtime Security cleanup grant request ID",
      preparation.runtimeSecurityGrantRequestId,
      CONTAINED_TURN_LIMITS.text.identifier,
    );
    if (!/^grant-request:sha256:[a-f0-9]{64}$/u.test(preparation.runtimeSecurityGrantRequestId)) {
      throw new TypeError("Runtime Security cleanup grant request ID must be digest-bound");
    }
  }
};

/** Closed, primitive-only permit copied once from the owner-store retirement record. */
export const snapshotContainedTurnCleanupPermit = (
  permit: ContainedTurnCleanupPermit,
): ContainedTurnCleanupPermit => {
  requireOrdinaryRecord("cleanup permit", permit, PERMIT_KEYS);
  const descriptors = Object.getOwnPropertyDescriptors(permit);
  const snapshot = Object.freeze({
    attemptId: descriptors.attemptId?.value as ContainedTurnCleanupPermit["attemptId"],
    custodyId: descriptors.custodyId?.value as ContainedTurnCleanupPermit["custodyId"],
    operationCutoffRevision: descriptors.operationCutoffRevision?.value as ContainedTurnCleanupPermit["operationCutoffRevision"],
    operationId: descriptors.operationId?.value as ContainedTurnCleanupPermit["operationId"],
    permitDigest: descriptors.permitDigest?.value as ContainedTurnCleanupPermit["permitDigest"],
    permitId: descriptors.permitId?.value as ContainedTurnCleanupPermit["permitId"],
    preparationToken: descriptors.preparationToken?.value as ContainedTurnCleanupPermit["preparationToken"],
    preparedOperationRevision: descriptors.preparedOperationRevision?.value as ContainedTurnCleanupPermit["preparedOperationRevision"],
    workspaceId: descriptors.workspaceId?.value as ContainedTurnCleanupPermit["workspaceId"],
  });
  validateContainedTurnIdentity("attempt", snapshot.attemptId);
  validateContainedTurnIdentity("custody", snapshot.custodyId);
  validateContainedTurnIdentity("operation", snapshot.operationId);
  validateContainedTurnIdentity("cleanup_permit", snapshot.permitId);
  validateContainedTurnIdentity("preparation", snapshot.preparationToken);
  validateContainedTurnIdentity("workspace", snapshot.workspaceId);
  parseContainedTurnCanonicalDigest(snapshot.permitDigest);
  containedTurnOperationCutoffRevision(snapshot.operationCutoffRevision);
  if (!Number.isSafeInteger(snapshot.preparedOperationRevision) || snapshot.preparedOperationRevision < 0) {
    throw new TypeError("cleanup permit owner revision must be a non-negative safe integer");
  }
  if (snapshot.permitId !== `cleanup-permit:${snapshot.permitDigest}`) {
    throw new TypeError("cleanup permit ID must bind its exact digest");
  }
  return snapshot;
};

const preparationBase = (
  preparation: ContainedTurnDispatchPreparation,
): Omit<ContainedTurnDispatchPreparation, "kind"> => {
  const descriptors = Object.getOwnPropertyDescriptors(preparation);
  const base = {
    attemptId: descriptors.attemptId?.value as ContainedTurnDispatchPreparation["attemptId"],
    custodyId: descriptors.custodyId?.value as ContainedTurnDispatchPreparation["custodyId"],
    operationCutoffRevision: descriptors.operationCutoffRevision?.value as ContainedTurnDispatchPreparation["operationCutoffRevision"],
    operationId: descriptors.operationId?.value as ContainedTurnDispatchPreparation["operationId"],
    preparationToken: descriptors.preparationToken?.value as ContainedTurnDispatchPreparation["preparationToken"],
    preparedOperationRevision: descriptors.preparedOperationRevision?.value as ContainedTurnDispatchPreparation["preparedOperationRevision"],
    ...(descriptors.providerAccessConsumptionReceipt === undefined ? {} : { providerAccessConsumptionReceipt: detachAndFreezeContainedTurnValue(descriptors.providerAccessConsumptionReceipt.value) }),
    providerAccessGrantRequestId: descriptors.providerAccessGrantRequestId?.value as string | null,
    ...(descriptors.runtimeSecurityConsumptionReceipt === undefined ? {} : { runtimeSecurityConsumptionReceipt: detachAndFreezeContainedTurnValue(descriptors.runtimeSecurityConsumptionReceipt.value) }),
    runtimeSecurityGrantRequestId: descriptors.runtimeSecurityGrantRequestId?.value as string | null,
    workspaceId: descriptors.workspaceId?.value as ContainedTurnDispatchPreparation["workspaceId"],
  };
  validatePreparationIdentity(base as ContainedTurnDispatchPreparation);
  return base;
};

const snapshotSimplePreparation = (
  preparation: ContainedTurnDispatchPreparation,
  kind: "active" | "claimed",
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation", preparation, [...preparationIdentityKeys(preparation), "kind"]);
  return Object.freeze({ ...preparationBase(preparation), kind });
};

const snapshotCleanupPendingPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation", preparation, [
    ...preparationIdentityKeys(preparation), "cleanupEvidenceIds", "cleanupPermit", "custodyReleased", "kind",
    "providerAccessConsumptionEvidenceId", "providerAccessSettled",
    "runtimeSecurityConsumptionEvidenceId", "runtimeSecuritySettled",
  ]);
  const pending = preparation as Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }>;
  if (pending.cleanupEvidenceIds.length > CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT) {
    throw new TypeError("cleanup evidence limit exceeded");
  }
  assertContainedTurnCanonicalArray(pending.cleanupEvidenceIds);
  const cleanupEvidenceIds = Object.freeze(pending.cleanupEvidenceIds.map(evidenceId =>
    validateContainedTurnIdentity("evidence", evidenceId)));
  const providerAccessConsumptionEvidenceId = pending.providerAccessConsumptionEvidenceId === null
    ? null
    : validateContainedTurnIdentity("evidence", pending.providerAccessConsumptionEvidenceId);
  const runtimeSecurityConsumptionEvidenceId = pending.runtimeSecurityConsumptionEvidenceId === null
    ? null
    : validateContainedTurnIdentity("evidence", pending.runtimeSecurityConsumptionEvidenceId);
  if (typeof pending.custodyReleased !== "boolean" || typeof pending.providerAccessSettled !== "boolean" ||
      typeof pending.runtimeSecuritySettled !== "boolean") {
    throw new TypeError("cleanup preparation flags must be primitive booleans");
  }
  if ((pending.providerAccessSettled && pending.providerAccessConsumptionReceipt === undefined) ||
      (pending.runtimeSecuritySettled && pending.runtimeSecurityConsumptionReceipt === undefined)) {
    throw new TypeError("cleanup preparation cannot settle an owner without a consumed receipt");
  }
  if ((providerAccessConsumptionEvidenceId !== null &&
      !cleanupEvidenceIds.includes(providerAccessConsumptionEvidenceId)) ||
      (runtimeSecurityConsumptionEvidenceId !== null &&
      !cleanupEvidenceIds.includes(runtimeSecurityConsumptionEvidenceId))) {
    throw new TypeError("cleanup preparation dropped grant consumption evidence");
  }
  return Object.freeze({
    ...preparationBase(preparation),
    cleanupEvidenceIds,
    cleanupPermit: snapshotContainedTurnCleanupPermit(pending.cleanupPermit),
    custodyReleased: pending.custodyReleased,
    kind: "cleanup_pending",
    providerAccessConsumptionEvidenceId,
    providerAccessSettled: pending.providerAccessSettled,
    runtimeSecurityConsumptionEvidenceId,
    runtimeSecuritySettled: pending.runtimeSecuritySettled,
  });
};

const snapshotCleanupClosedPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation", preparation, [
    ...preparationIdentityKeys(preparation), "cleanupEvidenceIds", "cleanupPermitId", "kind",
    "providerAccessConsumptionEvidenceId", "runtimeSecurityConsumptionEvidenceId",
  ]);
  const closed = preparation as Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_closed" }>;
  if (closed.providerAccessConsumptionReceipt === undefined || closed.runtimeSecurityConsumptionReceipt === undefined) {
    throw new TypeError("closed cleanup requires both consumed owner receipts");
  }
  if (closed.cleanupEvidenceIds.length > CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT) {
    throw new TypeError("cleanup evidence limit exceeded");
  }
  assertContainedTurnCanonicalArray(closed.cleanupEvidenceIds);
  const cleanupEvidenceIds = Object.freeze(closed.cleanupEvidenceIds.map(evidenceId =>
    validateContainedTurnIdentity("evidence", evidenceId)));
  const cleanupPermitId = validateContainedTurnIdentity("cleanup_permit", closed.cleanupPermitId);
  const providerAccessConsumptionEvidenceId = closed.providerAccessConsumptionEvidenceId === null
    ? null
    : validateContainedTurnIdentity("evidence", closed.providerAccessConsumptionEvidenceId);
  const runtimeSecurityConsumptionEvidenceId = closed.runtimeSecurityConsumptionEvidenceId === null
    ? null
    : validateContainedTurnIdentity("evidence", closed.runtimeSecurityConsumptionEvidenceId);
  if ((providerAccessConsumptionEvidenceId !== null &&
      !cleanupEvidenceIds.includes(providerAccessConsumptionEvidenceId)) ||
      (runtimeSecurityConsumptionEvidenceId !== null &&
      !cleanupEvidenceIds.includes(runtimeSecurityConsumptionEvidenceId))) {
    throw new TypeError("closed cleanup preparation dropped grant consumption evidence");
  }
  return Object.freeze({
    ...preparationBase(preparation), cleanupEvidenceIds, cleanupPermitId, kind: "cleanup_closed",
    providerAccessConsumptionEvidenceId, runtimeSecurityConsumptionEvidenceId,
  });
};

/** Variant-specific Kernel projection; no owner-store preparation aggregate escapes. */
export const snapshotContainedTurnDispatchPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation envelope", preparation, Object.keys(preparation));
  const kind = preparation.kind;
  if (kind === "active" || kind === "claimed") {
    return snapshotSimplePreparation(preparation, kind);
  }
  if (kind === "cleanup_pending") {return snapshotCleanupPendingPreparation(preparation);}
  if (kind === "cleanup_closed") {return snapshotCleanupClosedPreparation(preparation);}
  throw new TypeError("unknown dispatch preparation kind");
};

/** Validated, detached Kernel operation projection for accepted owner-store branches. */
export const snapshotContainedTurnOwnedOperation = (
  operation: ContainedTurnKernelOperation,
): ContainedTurnKernelOperation => {
  validateContainedTurnOperation(operation);
  return detachAndFreezeContainedTurnValue(operation);
};

const cleanupPermitMatchesPreparation = (
  permit: ContainedTurnCleanupPermit,
  preparation: ContainedTurnDispatchPreparation,
): boolean => permit.operationId === preparation.operationId &&
  permit.preparationToken === preparation.preparationToken &&
  permit.attemptId === preparation.attemptId && permit.custodyId === preparation.custodyId &&
  permit.workspaceId === preparation.workspaceId &&
  permit.preparedOperationRevision === preparation.preparedOperationRevision &&
  permit.operationCutoffRevision === preparation.operationCutoffRevision;

/** Exact operation and dispatch-owner predicate for prepared claim outcomes. */
export const isContainedTurnPreparedClaimOperation = (
  authority: ContainedTurnOwnerStoreAuthority,
  subject: ContainedTurnDispatchGrantSubject,
  operation: ContainedTurnKernelOperation,
): boolean => containedTurnOwnerStoreAuthorityMatches(authority, operation) &&
  subject.scopeDigest === containedTurnScopeDigest(authority.scope) &&
  operation.dispatch.kind === "claimed" &&
  operation.dispatch.attemptId === subject.attemptId &&
  operation.dispatch.executionGenerationId === subject.executionGenerationId &&
  operation.dispatch.operationCutoffRevision === subject.operationCutoffRevision &&
  operation.dispatch.preparationToken === subject.preparationToken &&
  operation.custodyId === subject.custodyId && operation.effectId === subject.effectId &&
  operation.hostBootId === subject.hostBootId && operation.hostInstanceId === subject.hostInstanceId &&
  operation.operationId === subject.operationId && operation.workspaceId === subject.workspaceId;

/** Exact operation owner and preparation identity for a retirement claim winner. */
export const isContainedTurnClaimedPreparation = (
  authority: ContainedTurnOwnerStoreAuthority,
  owner: ContainedTurnDispatchGrantSubject,
  actual: ContainedTurnKernelOperation,
): boolean => isContainedTurnPreparedClaimOperation(authority, owner, actual);

/** Exact owner predicate for an operation returned by retirement reconciliation. */
export const isContainedTurnRetirementCurrent = (
  authority: ContainedTurnOwnerStoreAuthority,
  expected: ContainedTurnKernelOperation,
  owner: ContainedTurnDispatchGrantSubject,
  actual: ContainedTurnKernelOperation,
): boolean => containedTurnOwnerStoreAuthorityMatches(authority, actual) &&
  actual.workspaceId === expected.workspaceId &&
  (actual.dispatch.kind !== "claimed" ||
    isContainedTurnPreparedClaimOperation(authority, owner, actual));

/** Exact operation/preparation-owner predicate for retirement outcomes. */
export const isContainedTurnRetiredPreparation = (
  authority: ContainedTurnOwnerStoreAuthority,
  operation: ContainedTurnKernelOperation,
  owner: ContainedTurnDispatchGrantSubject,
  preparation: ContainedTurnDispatchPreparation,
): preparation is Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }> =>
  containedTurnOwnerStoreAuthorityMatches(authority, operation) &&
  preparation.kind === "cleanup_pending" && operation.workspaceId !== undefined &&
  preparation.operationId === operation.operationId && preparation.operationId === owner.operationId &&
  preparation.preparationToken === owner.preparationToken &&
  preparation.attemptId === owner.attemptId && preparation.custodyId === owner.custodyId &&
  preparation.workspaceId === operation.workspaceId && preparation.workspaceId === owner.workspaceId &&
  preparation.preparedOperationRevision <= operation.revision &&
  preparation.operationCutoffRevision === operation.operationCutoff.revision &&
  preparation.operationCutoffRevision === owner.operationCutoffRevision &&
  cleanupPermitMatchesPreparation(preparation.cleanupPermit, preparation);

/** Exact permit and owner identities for each cleanup-store continuation. */
// oxlint-disable-next-line complexity -- exact monotone cleanup continuation checks stay explicit.
export const isContainedTurnPreparationCleanupContinuation = (
  expected: ContainedTurnDispatchPreparation,
  actual: ContainedTurnDispatchPreparation,
): boolean => (expected.kind === "cleanup_pending" || expected.kind === "cleanup_closed") &&
  (actual.kind === "cleanup_pending" || actual.kind === "cleanup_closed") &&
  actual.operationId === expected.operationId &&
  actual.preparationToken === expected.preparationToken && actual.attemptId === expected.attemptId &&
  actual.custodyId === expected.custodyId && actual.workspaceId === expected.workspaceId &&
  actual.preparedOperationRevision === expected.preparedOperationRevision &&
  actual.operationCutoffRevision === expected.operationCutoffRevision &&
  actual.providerAccessGrantRequestId === expected.providerAccessGrantRequestId &&
  actual.runtimeSecurityGrantRequestId === expected.runtimeSecurityGrantRequestId &&
  actual.providerAccessConsumptionEvidenceId === expected.providerAccessConsumptionEvidenceId &&
  actual.runtimeSecurityConsumptionEvidenceId === expected.runtimeSecurityConsumptionEvidenceId &&
  expected.cleanupEvidenceIds.every(evidenceId => actual.cleanupEvidenceIds.includes(evidenceId)) &&
  (expected.kind === "cleanup_closed"
    ? actual.kind === "cleanup_closed" && actual.cleanupPermitId === expected.cleanupPermitId
    : actual.kind === "cleanup_pending"
      ? actual.cleanupPermit.permitId === expected.cleanupPermit.permitId &&
        actual.cleanupPermit.permitDigest === expected.cleanupPermit.permitDigest &&
        cleanupPermitMatchesPreparation(actual.cleanupPermit, actual)
      : actual.cleanupPermitId === expected.cleanupPermit.permitId);
