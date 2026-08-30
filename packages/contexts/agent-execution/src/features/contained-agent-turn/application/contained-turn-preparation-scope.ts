import { types as nodeTypes } from "node:util";

import { containedTurnScopeDigest } from "../domain/contained-turn-authority.js";
import { parseContainedTurnCanonicalDigest } from "../domain/contained-turn-codecs.js";
import type { ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type {
  ContainedTurnCleanupPermit,
  ContainedTurnDispatchPreparation,
} from "../domain/contained-turn-dispatch-preparation.js";
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

const PORT_VALUE_MAXIMUM_DEPTH = 32;
const PORT_VALUE_MAXIMUM_NODES = 16_384;
const PORT_VALUE_MAXIMUM_PROPERTIES = 16_384;

type PortScalar = boolean | number | string | null;
type PortValue = PortScalar | readonly PortValue[] | { readonly [key: string]: PortValue };
type PortCloneState = { readonly ancestors: WeakSet<object>; nodes: number; properties: number };

const readBoundedContainedTurnDescriptors = (
  candidate: object,
  state: PortCloneState,
): PropertyDescriptorMap => {
  const keys = Reflect.ownKeys(candidate);
  state.properties += keys.length;
  if (state.properties > PORT_VALUE_MAXIMUM_PROPERTIES) {
    throw new TypeError("owner port value exceeds the bounded property limit");
  }
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined) {throw new TypeError("owner port property changed during projection");}
    return [key, descriptor];
  })) as PropertyDescriptorMap;
};

const cloneContainedTurnPortArray = (
  candidate: unknown[],
  descriptors: PropertyDescriptorMap,
  depth: number,
  state: PortCloneState,
): PortValue[] => {
  const lengthDescriptor = descriptors.length;
  if (Object.getPrototypeOf(candidate) !== Array.prototype || lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0) {
    throw new TypeError("owner port arrays must be ordinary dense arrays");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some(key => typeof key !== "string") ||
      Array.from({ length }, (_item, index) => String(index)).some(key => descriptors[key] === undefined)) {
    throw new TypeError("owner port arrays must be dense and unaugmented");
  }
  const output: PortValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("owner port arrays must contain only enumerable data elements");
    }
    output.push(cloneContainedTurnPortEntry(descriptor.value, depth + 1, state));
  }
  return output;
};

const cloneContainedTurnPortRecord = (
  candidate: object,
  descriptors: PropertyDescriptorMap,
  depth: number,
  state: PortCloneState,
): { readonly [key: string]: PortValue } => {
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    throw new TypeError("owner port records must use the ordinary object prototype");
  }
  const entries: [string, PortValue][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {throw new TypeError("owner port records must not contain symbols");}
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("owner port records must contain only enumerable data properties");
    }
    entries.push([key, cloneContainedTurnPortEntry(descriptor.value, depth + 1, state)]);
  }
  return Object.fromEntries(entries) as { readonly [key: string]: PortValue };
};

const cloneContainedTurnPortEntry = (
  candidate: unknown,
  depth: number,
  state: PortCloneState,
): PortValue => {
  if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number" ||
      typeof candidate === "string") {
    return candidate;
  }
  if (typeof candidate !== "object" || nodeTypes.isProxy(candidate)) {
    throw new TypeError("owner port values must contain only ordinary canonical data");
  }
  state.nodes += 1;
  if (state.nodes > PORT_VALUE_MAXIMUM_NODES || depth > PORT_VALUE_MAXIMUM_DEPTH ||
      state.ancestors.has(candidate)) {
    throw new TypeError("owner port value exceeds the bounded acyclic projection limits");
  }
  state.ancestors.add(candidate);
  try {
    const descriptors = readBoundedContainedTurnDescriptors(candidate, state);
    return Array.isArray(candidate)
      ? cloneContainedTurnPortArray(candidate, descriptors, depth, state)
      : cloneContainedTurnPortRecord(candidate, descriptors, depth, state);
  } finally {
    state.ancestors.delete(candidate);
  }
};

/**
 * Rejects Proxy exotica before any reflective operation and copies only a
 * bounded graph of ordinary, enumerable data properties. Caller accessors are
 * rejected from their descriptors and are never invoked.
 */
export const cloneContainedTurnPortValue = <Value>(value: Value): Value => {
  const state: PortCloneState = { ancestors: new WeakSet<object>(), nodes: 0, properties: 0 };
  return cloneContainedTurnPortEntry(value, 0, state) as Value;
};

const requireOrdinaryRecord = (name: string, value: object, keys: readonly string[]): void => {
  assertContainedTurnExactRecord(name, value, keys);
};

const validatePreparationIdentity = (preparation: ContainedTurnDispatchPreparation): void => {
  validateContainedTurnIdentity("attempt", preparation.attemptId);
  validateContainedTurnIdentity("custody", preparation.custodyId);
  validateContainedTurnIdentity("operation", preparation.operationId);
  validateContainedTurnIdentity("preparation", preparation.preparationToken);
  validateContainedTurnIdentity("workspace", preparation.workspaceId);
  containedTurnOperationCutoffRevision(preparation.operationCutoffRevision);
  if (!Number.isSafeInteger(preparation.preparedOperationRevision) || preparation.preparedOperationRevision < 0) {
    throw new TypeError("dispatch preparation revision must be a non-negative safe integer");
  }
  validateContainedTurnText(
    "Provider Access cleanup grant request ID",
    preparation.providerAccessGrantRequestId,
    CONTAINED_TURN_LIMITS.text.identifier,
  );
  validateContainedTurnText(
    "Runtime Security cleanup grant request ID",
    preparation.runtimeSecurityGrantRequestId,
    CONTAINED_TURN_LIMITS.text.identifier,
  );
};

/** Closed, primitive-only permit copied once from the owner-store retirement record. */
export const snapshotContainedTurnCleanupPermit = (
  permit: ContainedTurnCleanupPermit,
): ContainedTurnCleanupPermit => {
  const safePermit = cloneContainedTurnPortValue(permit);
  requireOrdinaryRecord("cleanup permit", safePermit, PERMIT_KEYS);
  const descriptors = Object.getOwnPropertyDescriptors(safePermit);
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
    providerAccessGrantRequestId: descriptors.providerAccessGrantRequestId?.value as string,
    runtimeSecurityGrantRequestId: descriptors.runtimeSecurityGrantRequestId?.value as string,
    workspaceId: descriptors.workspaceId?.value as ContainedTurnDispatchPreparation["workspaceId"],
  };
  validatePreparationIdentity(base as ContainedTurnDispatchPreparation);
  return base;
};

const snapshotSimplePreparation = (
  preparation: ContainedTurnDispatchPreparation,
  kind: "active" | "claimed",
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation", preparation, [...PREPARATION_IDENTITY_KEYS, "kind"]);
  return Object.freeze({ ...preparationBase(preparation), kind });
};

const snapshotCleanupPendingPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation", preparation, [
    ...PREPARATION_IDENTITY_KEYS, "cleanupEvidenceIds", "cleanupPermit", "custodyReleased", "kind",
    "providerAccessSettled", "runtimeSecuritySettled",
  ]);
  const pending = preparation as Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }>;
  assertContainedTurnCanonicalArray(pending.cleanupEvidenceIds);
  const cleanupEvidenceIds = Object.freeze(pending.cleanupEvidenceIds.map(evidenceId =>
    validateContainedTurnIdentity("evidence", evidenceId)));
  if (typeof pending.custodyReleased !== "boolean" || typeof pending.providerAccessSettled !== "boolean" ||
      typeof pending.runtimeSecuritySettled !== "boolean") {
    throw new TypeError("cleanup preparation flags must be primitive booleans");
  }
  return Object.freeze({
    ...preparationBase(preparation),
    cleanupEvidenceIds,
    cleanupPermit: snapshotContainedTurnCleanupPermit(pending.cleanupPermit),
    custodyReleased: pending.custodyReleased,
    kind: "cleanup_pending",
    providerAccessSettled: pending.providerAccessSettled,
    runtimeSecuritySettled: pending.runtimeSecuritySettled,
  });
};

const snapshotCleanupClosedPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  requireOrdinaryRecord("dispatch preparation", preparation, [
    ...PREPARATION_IDENTITY_KEYS, "cleanupPermitId", "kind",
  ]);
  const closed = preparation as Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_closed" }>;
  const cleanupPermitId = validateContainedTurnIdentity("cleanup_permit", closed.cleanupPermitId);
  return Object.freeze({ ...preparationBase(preparation), cleanupPermitId, kind: "cleanup_closed" });
};

/** Variant-specific Kernel projection; no owner-store preparation aggregate escapes. */
export const snapshotContainedTurnDispatchPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  const safePreparation = cloneContainedTurnPortValue(preparation);
  requireOrdinaryRecord("dispatch preparation envelope", safePreparation, Object.keys(safePreparation));
  const kind = safePreparation.kind;
  if (kind === "active" || kind === "claimed") {
    return snapshotSimplePreparation(safePreparation, kind);
  }
  if (kind === "cleanup_pending") {return snapshotCleanupPendingPreparation(safePreparation);}
  if (kind === "cleanup_closed") {return snapshotCleanupClosedPreparation(safePreparation);}
  throw new TypeError("unknown dispatch preparation kind");
};

/** Validated, detached Kernel operation projection for accepted owner-store branches. */
export const snapshotContainedTurnOwnedOperation = (
  operation: ContainedTurnKernelOperation,
): ContainedTurnKernelOperation => {
  const detached = cloneContainedTurnPortValue(operation);
  validateContainedTurnOperation(detached);
  return detachAndFreezeContainedTurnValue(detached);
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
  preparation.preparedOperationRevision === operation.revision &&
  preparation.operationCutoffRevision === operation.operationCutoff.revision &&
  preparation.operationCutoffRevision === owner.operationCutoffRevision &&
  cleanupPermitMatchesPreparation(preparation.cleanupPermit, preparation);

/** Exact permit and owner identities for each cleanup-store continuation. */
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
  (expected.kind === "cleanup_closed"
    ? actual.kind === "cleanup_closed" && actual.cleanupPermitId === expected.cleanupPermitId
    : actual.kind === "cleanup_pending"
      ? actual.cleanupPermit.permitId === expected.cleanupPermit.permitId &&
        actual.cleanupPermit.permitDigest === expected.cleanupPermit.permitDigest &&
        cleanupPermitMatchesPreparation(actual.cleanupPermit, actual)
      : actual.cleanupPermitId === expected.cleanupPermit.permitId);
