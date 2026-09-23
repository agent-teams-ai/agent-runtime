import { ownerOutputValue } from "./authority-owner-boundary.js";
import { acceptedProviderPreparation, reverseProviderBinding } from "./accepted-authority-anti-corruption.js";
import type { ContainedTurnProviderAccessPort } from "../application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnProviderAccessSnapshotDigest,
  type ContainedTurnIntent, type ContainedTurnAuthorityProvider,
  type ContainedTurnProviderAccessSnapshot, type ContainedTurnAuthorityScope,
} from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { CONTAINED_TURN_OWNER_DISPATCH_PURPOSE } from "../domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "./dispatch-grant-anti-corruption.js";

export interface ContainedTurnProviderAccessOuterEvidence { readonly authorityDigest: string; readonly bindingAuthorityDigest: string; readonly proofRef: string; readonly purpose: "acceptance" | "dispatch" }
export interface OuterBinding extends ContainedTurnAuthorityScope {
  readonly accessRef: string; readonly credentialBindingDigest: string; readonly credentialBindingRef: string;
  readonly credentialGeneration: number; readonly provider: ContainedTurnAuthorityProvider; readonly providerAccountRef: string;
  readonly providerRouteRef: string; readonly revision: number;
}
export type ContainedTurnProviderAccessDispatchScope = Readonly<ContainedTurnAuthorityScope & { readonly scopeDigest: string }>;
export type ContainedTurnProviderAccessDispatchBinding = Parameters<ContainedTurnProviderAccessPort["consumeForDispatch"]>[0]["subject"]["providerAccessExpectation"];
export interface ContainedTurnProviderAccessDispatchReceipt extends Omit<ContainedTurnProviderAccessDispatchBinding, "authorityHeadDigest"> {
  readonly authorityHeadDigestAtConsumption: string; readonly claimBeforeControlTime: number;
  readonly claimBindingDigest: string; readonly consumedAtControlTime: number; readonly consumptionDigest: string;
  readonly grantRequestId: string; readonly opaqueOwnerEvidenceRef: string; readonly operationId: string;
  readonly provider: ContainedTurnAuthorityProvider; readonly purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE;
  readonly requestDigest: string; readonly scope: ContainedTurnProviderAccessDispatchScope;
}
export interface ContainedTurnProviderAccessPrevention {
  readonly grantRequestId: string; readonly observedAtControlTime: number;
  readonly opaqueOwnerEvidenceRef: string; readonly reason: string;
  readonly requestDigest: string; readonly scope: ContainedTurnProviderAccessDispatchScope;
}
export type ContainedTurnProviderAccessConsumeOutcome =
  | { readonly kind: "consumed"; readonly receipt: ContainedTurnProviderAccessDispatchReceipt }
  | { readonly kind: "prevented"; readonly prevention: ContainedTurnProviderAccessPrevention }
  | { readonly kind: "conflict" | "invalid" | "indeterminate" | "not_found"; readonly reason?: string };

/** Exact structural view of Provider Access ContainedTurnDispatchConsumptionV1. */
export interface OuterContainedTurnProviderAccess {
  readonly dispatchConsumptionV1: {
    consumeForDispatch(input: Readonly<{ binding: ContainedTurnProviderAccessDispatchBinding; claimBindingDigest: string; grantRequestId: string; operationId: string; provider: ContainedTurnAuthorityProvider; purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE; requestDigest: string; scope: ContainedTurnProviderAccessDispatchScope }>): Promise<ContainedTurnProviderAccessConsumeOutcome>;
    observeDispatchConsumption(input: Readonly<{ grantRequestId: string; provider: ContainedTurnAuthorityProvider; requestDigest: string; scope: ContainedTurnProviderAccessDispatchScope }>): Promise<ContainedTurnProviderAccessConsumeOutcome>;
    settleDispatchConsumption(input: Readonly<{ consumptionDigest: string; disposition: "abandoned_without_claim" | "claim_committed"; expectedBinding: ContainedTurnProviderAccessDispatchBinding; operationId: string; provider: ContainedTurnAuthorityProvider; scope: ContainedTurnProviderAccessDispatchScope; settlementRequestId: string }>): Promise<Readonly<{ kind: "settled"; receipt: unknown } | { kind: "conflict" | "invalid" | "indeterminate" | "not_found"; reason?: string }>>;
  };
  readonly resolve: { execute(input: Readonly<{ provider: ContainedTurnAuthorityProvider; scope: ContainedTurnAuthorityScope }>): Promise<Readonly<{ binding: OuterBinding; evidence: ContainedTurnProviderAccessOuterEvidence; kind: "resolved" } | { evidence: ContainedTurnProviderAccessOuterEvidence; kind: "unavailable"; reason: string }>> };
  readonly revalidate: { execute(input: Readonly<{ binding: OuterBinding; provider: ContainedTurnAuthorityProvider; scope: ContainedTurnAuthorityScope }>): Promise<Readonly<{ binding: OuterBinding; evidence: ContainedTurnProviderAccessOuterEvidence; kind: "valid" } | { evidence: ContainedTurnProviderAccessOuterEvidence; kind: "rejected"; reason: string }>> };
}

export type ProviderAccessRouteCOwnerDiagnostic =
  | "accessor_backed"
  | "invalid_method"
  | "invalid_prototype"
  | "invalid_shape"
  | "mutable_shape"
  | "not_data_record";

/** Bounded composition diagnostic. It contains no owner values or ambient details. */
export class ProviderAccessRouteCOwnerError extends TypeError {
  public readonly code = "ERR_PROVIDER_ACCESS_ROUTE_C_OWNER";
  public readonly diagnostic: ProviderAccessRouteCOwnerDiagnostic;
  public constructor(diagnostic: ProviderAccessRouteCOwnerDiagnostic) {
    super(`Provider Access Route C owner rejected: ${diagnostic}`);
    this.diagnostic = diagnostic;
    this.name = "ProviderAccessRouteCOwnerError";
  }
}

export type ContainedTurnProviderAccessCapturedOwner = Readonly<{
  consumeForDispatch: OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["consumeForDispatch"];
  observeDispatchConsumption: OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["observeDispatchConsumption"];
  resolve: OuterContainedTurnProviderAccess["resolve"]["execute"];
  revalidate: OuterContainedTurnProviderAccess["revalidate"]["execute"];
  settleDispatchConsumption: OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["settleDispatchConsumption"];
}>;

const trustedApply = Reflect.apply;
const trustedFreeze = Object.freeze;
const trustedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const trustedGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const trustedGetPrototypeOf = Object.getPrototypeOf;
const trustedIsExtensible = Object.isExtensible;
const trustedIsFrozen = Object.isFrozen;
const trustedOwnKeys = Reflect.ownKeys;
const trustedObjectPrototype = Object.prototype;
type NodeUtilTypes = Readonly<{ isProxy(value: unknown): boolean }>;
const trustedIsProxy = (process.getBuiltinModule("node:util") as Readonly<{ types: NodeUtilTypes }>).types.isProxy;

export const exactStableDataRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    throw new ProviderAccessRouteCOwnerError("not_data_record");
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (trustedIsProxy(value)) {
      throw new ProviderAccessRouteCOwnerError("invalid_shape");
    }
    const prototype = trustedGetPrototypeOf(value) as unknown;
    if (prototype !== trustedObjectPrototype && prototype !== null) {
      throw new ProviderAccessRouteCOwnerError("invalid_prototype");
    }
    descriptors = trustedGetOwnPropertyDescriptors(value);
    if (trustedIsExtensible(value)) {
      throw new ProviderAccessRouteCOwnerError("mutable_shape");
    }
  } catch (error) {
    if (error instanceof ProviderAccessRouteCOwnerError) { throw error; }
    throw new ProviderAccessRouteCOwnerError("invalid_shape");
  }
  const ownKeys = trustedOwnKeys(descriptors);
  let exactKeys = ownKeys.length === keys.length;
  for (let index = 0; exactKeys && index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    exactKeys = typeof key === "string" && keys.includes(key);
  }
  if (!exactKeys) {
    throw new ProviderAccessRouteCOwnerError("invalid_shape");
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ProviderAccessRouteCOwnerError("accessor_backed");
    }
    if (descriptor.configurable !== false) {
      throw new ProviderAccessRouteCOwnerError("mutable_shape");
    }
    record[key] = descriptor.value;
  }
  return record;
};

const exactFrozenDataRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = exactStableDataRecord(value, keys);
  if (!trustedIsFrozen(value)) {throw new TypeError("Provider Access owner output must be frozen data");}
  return record;
};

export const capturedMethod = (owner: object, value: unknown): ((...args: unknown[]) => unknown) => {
  try {
    if (typeof value !== "function" || trustedIsProxy(value) ||
        trustedGetOwnPropertyDescriptor(value, "bind") !== undefined) {
      throw new ProviderAccessRouteCOwnerError("invalid_method");
    }
    // Native bind reads callable name/length accessors even on frozen methods.
    return trustedFreeze((...args: unknown[]): unknown => trustedApply(value, owner, args));
  } catch {
    throw new ProviderAccessRouteCOwnerError("invalid_method");
  }
};

const captureProviderAccessOwner = (value: unknown): ContainedTurnProviderAccessCapturedOwner => {
  const outer = exactStableDataRecord(value, ["dispatchConsumptionV1", "resolve", "revalidate"]);
  const dispatchOwner = exactStableDataRecord(outer.dispatchConsumptionV1, [
    "consumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption",
  ]);
  const resolveOwner = exactStableDataRecord(outer.resolve, ["execute"]);
  const revalidateOwner = exactStableDataRecord(outer.revalidate, ["execute"]);
  try {
    return trustedFreeze({
      consumeForDispatch: capturedMethod(outer.dispatchConsumptionV1 as object, dispatchOwner.consumeForDispatch) as ContainedTurnProviderAccessCapturedOwner["consumeForDispatch"],
      observeDispatchConsumption: capturedMethod(outer.dispatchConsumptionV1 as object, dispatchOwner.observeDispatchConsumption) as ContainedTurnProviderAccessCapturedOwner["observeDispatchConsumption"],
      resolve: capturedMethod(outer.resolve as object, resolveOwner.execute) as ContainedTurnProviderAccessCapturedOwner["resolve"],
      revalidate: capturedMethod(outer.revalidate as object, revalidateOwner.execute) as ContainedTurnProviderAccessCapturedOwner["revalidate"],
      settleDispatchConsumption: capturedMethod(outer.dispatchConsumptionV1 as object, dispatchOwner.settleDispatchConsumption) as ContainedTurnProviderAccessCapturedOwner["settleDispatchConsumption"],
    });
  } catch {
    throw new ProviderAccessRouteCOwnerError("invalid_method");
  }
};

const opaqueEvidenceDigest = (evidence: ContainedTurnProviderAccessOuterEvidence): string => digestContainedTurnCanonicalValue(evidence as never);
const proofId = (evidence: ContainedTurnProviderAccessOuterEvidence, purpose: ContainedTurnProviderAccessOuterEvidence["purpose"]) => containedTurnIdentity("proof", `proof:provider-access:${purpose}:${opaqueEvidenceDigest(evidence)}`);
const evidenceId = (evidence: ContainedTurnProviderAccessOuterEvidence, purpose: ContainedTurnProviderAccessOuterEvidence["purpose"]) => containedTurnIdentity("evidence", `evidence:provider-access:${purpose}:${opaqueEvidenceDigest(evidence)}`);
const snapshot = (binding: OuterBinding, evidence: ContainedTurnProviderAccessOuterEvidence): ContainedTurnProviderAccessSnapshot => {
  exactFrozenDataRecord(binding, ["accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId"]);
  exactFrozenDataRecord(evidence, ["authorityDigest", "bindingAuthorityDigest", "proofRef", "purpose"]);
  if (binding.credentialBindingDigest !== evidence.bindingAuthorityDigest ||
      ![binding.accessRef, binding.credentialBindingDigest, binding.credentialBindingRef, binding.projectId, binding.provider, binding.providerAccountRef, binding.providerRouteRef, binding.tenantId, evidence.authorityDigest, evidence.proofRef].every(exactBoundedToken) ||
      !Number.isSafeInteger(binding.credentialGeneration) || binding.credentialGeneration < 1 || !Number.isSafeInteger(binding.revision) || binding.revision < 1) {throw new TypeError("PA owner binding mismatch");}
  return Object.freeze({
  accessRef: binding.accessRef,
  credentialBindingDigest: digestContainedTurnCanonicalValue({ ownerDigest: binding.credentialBindingDigest }),
  credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
  ownerAuthorityDigest: evidence.bindingAuthorityDigest, projectId: binding.projectId, provider: binding.provider,
  providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef,
  revision: binding.revision, tenantId: binding.tenantId,
});
};
const resolutionDigest = (binding: ContainedTurnProviderAccessSnapshot, evidence: ContainedTurnProviderAccessOuterEvidence, phase: "acceptance" | "dispatch") => digestContainedTurnCanonicalValue({
  bindingDigest: containedTurnProviderAccessSnapshotDigest(binding), ownerAuthorityDigest: evidence.authorityDigest,
  phase, proofPurpose: evidence.purpose, proofRef: evidence.proofRef,
});
const grantEvidenceId = (phase: "consume" | "settle", value: unknown) => containedTurnIdentity(
  "evidence", `evidence:provider-access:${phase}:${digestContainedTurnCanonicalValue(value as never)}`,
);
const boundaryFailureEvidenceId = (
  phase: "consume" | "resolve" | "revalidate" | "settle",
  value: unknown,
) => containedTurnIdentity(
  "evidence", `evidence:provider-access:boundary:${phase}:${digestContainedTurnCanonicalValue(value as never)}`,
);

const dispatchBindingKeys = [
  "acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "bindingRevision",
  "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerAccountRef", "providerRouteRef",
] as const;
const dispatchScopeKeys = ["projectId", "scopeDigest", "tenantId"] as const;

export const exactBoundedToken = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {return false;}
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {return false;}
  }
  return true;
};

const scopeMatches = (value: unknown, expected: ContainedTurnProviderAccessDispatchScope): boolean => {
  const scope = exactFrozenDataRecord(value, dispatchScopeKeys);
  return scope.projectId === expected.projectId && scope.scopeDigest === expected.scopeDigest &&
    scope.tenantId === expected.tenantId;
};

const bindingMatches = (value: unknown, expected: ContainedTurnProviderAccessDispatchBinding): boolean => {
  const binding = exactFrozenDataRecord(value, dispatchBindingKeys);
  for (const key of dispatchBindingKeys) {
    if (binding[key] !== expected[key]) {return false;}
  }
  return true;
};

const preventionReason = (value: unknown): value is string => {
  switch (value) {
    case "accepted_authority_changed": case "access_changed": case "account_changed":
    case "already_consumed": case "authority_head_changed": case "binding_changed":
    case "claim_binding_mismatch": case "credential_changed": case "credential_rotated":
    case "expired": case "invalid_request": case "provider_mismatch":
    case "request_digest_mismatch": case "revision_changed": case "revoked":
    case "route_changed": case "scope_mismatch": case "unavailable": return true;
    default: return false;
  }
};

const snapshotBoundPrevention = (
  value: unknown,
  request: Readonly<{grantRequestId: string; requestDigest: string; scope: ContainedTurnProviderAccessDispatchScope}>,
): ContainedTurnProviderAccessPrevention => {
  const data = exactFrozenDataRecord(value, [
    "grantRequestId", "observedAtControlTime", "opaqueOwnerEvidenceRef", "reason", "requestDigest", "scope",
  ]);
  if (data.grantRequestId !== request.grantRequestId || data.requestDigest !== request.requestDigest ||
      !Number.isSafeInteger(data.observedAtControlTime) || (data.observedAtControlTime as number) < 1 ||
      !exactBoundedToken(data.opaqueOwnerEvidenceRef) || !preventionReason(data.reason) ||
      !scopeMatches(data.scope, request.scope)) {
    throw new TypeError("Provider Access prevention is not bound to the request");
  }
  return trustedFreeze({
    grantRequestId: data.grantRequestId,
    observedAtControlTime: data.observedAtControlTime as number,
    opaqueOwnerEvidenceRef: data.opaqueOwnerEvidenceRef,
    reason: data.reason,
    requestDigest: data.requestDigest,
    scope: request.scope,
  });
};

const settlementMatches = (
  value: unknown,
  request: Readonly<{
    consumptionDigest: string; disposition: "abandoned_without_claim" | "claim_committed";
    expectedBinding: ContainedTurnProviderAccessDispatchBinding; operationId: string; provider: ContainedTurnAuthorityProvider;
    scope: ContainedTurnProviderAccessDispatchScope; settlementRequestId: string;
  }>,
): boolean => {
  const outcome = exactFrozenDataRecord(value, ["kind", "receipt"]);
  if (outcome.kind !== "settled") {return false;}
  const receipt = exactFrozenDataRecord(outcome.receipt, [
    "consumptionDigest", "disposition", "expectedBinding", "operationId", "provider", "scope",
    "settledAtControlTime", "settlementDigest", "settlementRequestId",
  ]);
  return receipt.consumptionDigest === request.consumptionDigest &&
    receipt.disposition === request.disposition && receipt.operationId === request.operationId &&
    receipt.provider === request.provider && receipt.settlementRequestId === request.settlementRequestId &&
    Number.isSafeInteger(receipt.settledAtControlTime) && (receipt.settledAtControlTime as number) > 0 &&
    exactBoundedToken(receipt.settlementDigest) &&
    bindingMatches(receipt.expectedBinding, request.expectedBinding) && scopeMatches(receipt.scope, request.scope);
};

/** Real ACL from both Provider Access V1 owner contracts into the single Agent Execution port. */
export const createContainedTurnProviderAccessPort = (outer: OuterContainedTurnProviderAccess): ContainedTurnProviderAccessPort => {
  const owner = captureProviderAccessOwner(outer);
  return providerAccessPort(owner);
};

const providerAccessPort = (owner: ContainedTurnProviderAccessCapturedOwner, publish?: (input: Parameters<ContainedTurnProviderAccessPort["consumeForDispatch"]>[0], request: Parameters<ContainedTurnProviderAccessCapturedOwner["consumeForDispatch"]>[0]) => ReturnType<ContainedTurnProviderAccessCapturedOwner["consumeForDispatch"]>): ContainedTurnProviderAccessPort => {
  const port: ContainedTurnProviderAccessPort = {
  async consumeForDispatch(input) {
    const subject = input.subject;
    if (input.grantRequestId !== subject.providerAccessRequest.grantRequestId) {throw new TypeError("Provider Access request identity does not bind the final claim");}
    const scope = Object.freeze({ ...subject.scope, scopeDigest: subject.scopeDigest });
    const request = Object.freeze({
      binding: subject.providerAccessExpectation, claimBindingDigest: subject.providerAccessRequest.claimBindingDigest,
      grantRequestId: input.grantRequestId, operationId: subject.operationId, provider: subject.provider,
      purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE, requestDigest: subject.providerAccessRequest.requestDigest, scope,
    });
    try {
      let outcome = await ownerOutputValue(publish === undefined ? owner.consumeForDispatch(request) : publish(input, request));
      if (outcome.kind === "indeterminate") {
        outcome = await ownerOutputValue(owner.observeDispatchConsumption({
          grantRequestId: request.grantRequestId, provider: request.provider,
          requestDigest: request.requestDigest, scope,
        }));
      }
      if (outcome.kind === "consumed") {
        exactFrozenDataRecord(outcome, ["kind", "receipt"]);
        const receipt = outcome.receipt;
        exactFrozenDataRecord(receipt, ["acceptedAuthorityDigest", "accessRef", "authorityHeadDigestAtConsumption", "bindingDigest", "bindingRevision", "claimBeforeControlTime", "claimBindingDigest", "consumedAtControlTime", "consumptionDigest", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "grantRequestId", "opaqueOwnerEvidenceRef", "operationId", "provider", "providerAccountRef", "providerRouteRef", "purpose", "requestDigest", "scope", ...(publish === undefined && Object.hasOwn(receipt, "authorityHeadDigest") ? ["authorityHeadDigest"] : [])]);
        if (!scopeMatches(receipt.scope, scope)) {throw new TypeError("PA consumed scope mismatch");}
        return { kind: "consumed", receipt: normalizeContainedTurnConsumedGrantReceipt("provider_access", subject, {
          authorityFacts: Object.freeze({
            acceptedAuthorityDigest: receipt.acceptedAuthorityDigest, accessRef: receipt.accessRef,
            authorityHeadDigest: receipt.authorityHeadDigestAtConsumption, bindingDigest: receipt.bindingDigest,
            bindingRevision: receipt.bindingRevision, credentialBindingDigest: receipt.credentialBindingDigest,
            credentialBindingRef: receipt.credentialBindingRef, credentialGeneration: receipt.credentialGeneration,
            providerAccountRef: receipt.providerAccountRef, providerRouteRef: receipt.providerRouteRef,
          }),
          claimBeforeControlTime: receipt.claimBeforeControlTime, claimBindingDigest: receipt.claimBindingDigest as never,
          consumedAtControlTime: receipt.consumedAtControlTime, consumptionDigest: receipt.consumptionDigest,
          grantRequestId: receipt.grantRequestId, operationId: receipt.operationId as never,
          ownerEvidenceRef: receipt.opaqueOwnerEvidenceRef, provider: receipt.provider, purpose: receipt.purpose,
          requestDigest: receipt.requestDigest as never, scope: receipt.scope as never,
        }) };
      }
      if (outcome.kind === "prevented") {
        exactFrozenDataRecord(outcome, ["kind", "prevention"]);
        const prevention = snapshotBoundPrevention(outcome.prevention, request);
        return { kind: "prevented", preventionProofId: containedTurnIdentity("proof", `proof:provider-access:dispatch:${digestContainedTurnCanonicalValue(prevention as never)}`) };
      }
      return { evidenceId: boundaryFailureEvidenceId("consume", request), kind: "indeterminate" };
    } catch {
      return { evidenceId: boundaryFailureEvidenceId("consume", request), kind: "indeterminate" };
    }
  },
  async settleConsumedGrant(input) {
    const receipt = input.receipt;
    try {
      const request = Object.freeze({
        consumptionDigest: receipt.consumptionDigest, disposition: input.disposition,
        expectedBinding: receipt.authorityFacts, operationId: receipt.operationId, provider: receipt.provider,
        scope: receipt.scope, settlementRequestId: input.settlementRequestId,
      });
      const outcome = await ownerOutputValue(owner.settleDispatchConsumption(request));
      return settlementMatches(outcome, request) ? { kind: "settled" } :
        { evidenceId: grantEvidenceId("settle", { input, outcome }), kind: "indeterminate" };
    } catch {return { evidenceId: boundaryFailureEvidenceId("settle", input), kind: "indeterminate" };}
  },
  async resolveForAcceptance(input: Readonly<{ intent: ContainedTurnIntent; provider: ContainedTurnAuthorityProvider; scope: ContainedTurnAuthorityScope }>) {
    const request = Object.freeze({ provider: input.provider, scope: input.scope });
    try {
      const outcome = await ownerOutputValue(owner.resolve(request));
      if (outcome.evidence.purpose !== "acceptance") {return { evidenceId: evidenceId(outcome.evidence, "acceptance"), kind: "indeterminate", reason: "authority_unknown" };}
      if (outcome.kind === "resolved") {exactFrozenDataRecord(outcome, ["kind", "binding", "evidence"]); const binding = snapshot(outcome.binding, outcome.evidence); if (binding.provider !== input.provider || binding.tenantId !== input.scope.tenantId || binding.projectId !== input.scope.projectId) {throw new TypeError("PA current selector mismatch");} return { acceptanceProofId: proofId(outcome.evidence, "acceptance"), acceptanceResolutionDigest: resolutionDigest(binding, outcome.evidence, "acceptance"), kind: "resolved", snapshot: binding };}
      const remainingKind: unknown = outcome.kind;
      if (remainingKind !== "unavailable") {throw new TypeError("PA invalid resolution kind");}
      exactFrozenDataRecord(outcome, ["kind", "reason", "evidence"]);
      exactFrozenDataRecord(outcome.evidence, ["authorityDigest", "bindingAuthorityDigest", "proofRef", "purpose"]);
      if (outcome.reason === "revoked" || outcome.reason === "not_found") {return { kind: "prevented", preventionProofId: proofId(outcome.evidence, "acceptance"), reason: "access_denied" };}
      return { evidenceId: boundaryFailureEvidenceId("resolve", request), kind: "indeterminate", reason: "authority_unknown" };
    } catch {
      return { evidenceId: boundaryFailureEvidenceId("resolve", request), kind: "indeterminate", reason: "authority_unknown" };
    }
  },
  async revalidateForDispatch(input) {
    const outerBinding: OuterBinding = reverseProviderBinding(input.acceptedSnapshot);
    const request = Object.freeze({ binding: outerBinding, provider: input.acceptedSnapshot.provider, scope: input.scope });
    try {
      const outcome = await ownerOutputValue(owner.revalidate(request));
      if (outcome.evidence.purpose !== "dispatch") {return { evidenceId: evidenceId(outcome.evidence, "dispatch"), kind: "indeterminate", reason: "authority_unknown" };}
      if (outcome.kind === "valid") {exactFrozenDataRecord(outcome, ["kind", "binding", "evidence"]); const binding = snapshot(outcome.binding, outcome.evidence); if (containedTurnProviderAccessSnapshotDigest(binding) !== containedTurnProviderAccessSnapshotDigest(input.acceptedSnapshot)) {throw new TypeError("PA current binding changed");} return { dispatchProofId: proofId(outcome.evidence, "dispatch"), dispatchResolutionDigest: resolutionDigest(binding, outcome.evidence, "dispatch"), kind: "current", snapshot: binding };}
      const remainingKind: unknown = outcome.kind;
      if (remainingKind !== "rejected") {throw new TypeError("PA invalid revalidation kind");}
      exactFrozenDataRecord(outcome, ["kind", "reason", "evidence"]);
      exactFrozenDataRecord(outcome.evidence, ["authorityDigest", "bindingAuthorityDigest", "proofRef", "purpose"]);
      if (outcome.reason === "revoked" || outcome.reason.endsWith("_changed") || outcome.reason === "credential_rotated" || outcome.reason === "revision_changed") {return { kind: "prevented", preventionProofId: proofId(outcome.evidence, "dispatch"), reason: "access_revoked" };}
      return { evidenceId: boundaryFailureEvidenceId("revalidate", request), kind: "indeterminate", reason: "authority_unknown" };
    } catch {
      return { evidenceId: boundaryFailureEvidenceId("revalidate", request), kind: "indeterminate", reason: "authority_unknown" };
    }
  },
  };
  return Object.freeze(port);
};

/** Operation-scoped PA v2 publisher plus independently current materialization resolver. */
export interface OuterContainedTurnProviderAccessOperation {
  readonly resolve: OuterContainedTurnProviderAccess["resolve"];
  readonly revalidate: OuterContainedTurnProviderAccess["revalidate"];
  readonly dispatchConsumption: OuterContainedTurnProviderAccess["dispatchConsumptionV1"] & {
    publishAndConsumeForDispatch(prepared: ReturnType<typeof acceptedProviderPreparation>, request: Parameters<ContainedTurnProviderAccessCapturedOwner["consumeForDispatch"]>[0]): ReturnType<ContainedTurnProviderAccessCapturedOwner["consumeForDispatch"]>;
  };
}
export const createContainedTurnOperationProviderAccessPort = (outer: OuterContainedTurnProviderAccessOperation): ContainedTurnProviderAccessPort => {
  const fields = exactStableDataRecord(outer, ["resolve", "revalidate", "dispatchConsumption"]);
  const dispatch = exactStableDataRecord(fields.dispatchConsumption, ["consumeForDispatch", "publishAndConsumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption"]);
  const captured = Object.freeze(Object.fromEntries(["consumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption"].map(key =>
    [key, capturedMethod(fields.dispatchConsumption as object, dispatch[key])])));
  const legacy = Object.freeze({resolve: fields.resolve, revalidate: fields.revalidate, dispatchConsumptionV1: captured}) as unknown as OuterContainedTurnProviderAccess;
  const publisher = capturedMethod(fields.dispatchConsumption as object, dispatch.publishAndConsumeForDispatch) as OuterContainedTurnProviderAccessOperation["dispatchConsumption"]["publishAndConsumeForDispatch"];
  return providerAccessPort(captureProviderAccessOwner(legacy), (input, request) => publisher(acceptedProviderPreparation(input), request));
};
