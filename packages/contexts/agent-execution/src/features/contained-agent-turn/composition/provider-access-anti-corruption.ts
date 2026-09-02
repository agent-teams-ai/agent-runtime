import type { ContainedTurnProviderAccessPort } from "../application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnProviderAccessSnapshotDigest,
  type ContainedTurnIntent, type ContainedTurnProvider,
  type ContainedTurnProviderAccessSnapshot, type ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { CONTAINED_TURN_OWNER_DISPATCH_PURPOSE } from "../domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "./dispatch-grant-anti-corruption.js";

interface OuterEvidence { readonly authorityDigest: string; readonly bindingAuthorityDigest: string; readonly proofRef: string; readonly purpose: "acceptance" | "dispatch" }
interface OuterBinding extends ContainedTurnScope {
  readonly accessRef: string; readonly credentialBindingDigest: string; readonly credentialBindingRef: string;
  readonly credentialGeneration: number; readonly provider: ContainedTurnProvider; readonly providerAccountRef: string;
  readonly providerRouteRef: string; readonly revision: number;
}
type DispatchScope = Readonly<ContainedTurnScope & { readonly scopeDigest: string }>;
type DispatchBinding = Parameters<ContainedTurnProviderAccessPort["consumeForDispatch"]>[0]["subject"]["providerAccessExpectation"];
interface ProviderAccessDispatchReceipt extends DispatchBinding {
  readonly authorityHeadDigestAtConsumption: string; readonly claimBeforeControlTime: number;
  readonly claimBindingDigest: string; readonly consumedAtControlTime: number; readonly consumptionDigest: string;
  readonly grantRequestId: string; readonly opaqueOwnerEvidenceRef: string; readonly operationId: string;
  readonly provider: ContainedTurnProvider; readonly purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE;
  readonly requestDigest: string; readonly scope: DispatchScope;
}
type ProviderAccessConsumeOutcome =
  | { readonly kind: "consumed"; readonly receipt: ProviderAccessDispatchReceipt }
  | { readonly kind: "prevented"; readonly prevention: Readonly<{ grantRequestId: string; observedAtControlTime: number; opaqueOwnerEvidenceRef: string; reason: string; requestDigest: string; scope: DispatchScope }> }
  | { readonly kind: "conflict" | "invalid" | "indeterminate" | "not_found"; readonly reason?: string };

/** Exact structural view of Provider Access ContainedTurnDispatchConsumptionV1. */
export interface OuterContainedTurnProviderAccess {
  readonly dispatchConsumptionV1: {
    consumeForDispatch(input: Readonly<{ binding: DispatchBinding; claimBindingDigest: string; grantRequestId: string; operationId: string; provider: ContainedTurnProvider; purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE; requestDigest: string; scope: DispatchScope }>): Promise<ProviderAccessConsumeOutcome>;
    observeDispatchConsumption(input: Readonly<{ grantRequestId: string; provider: ContainedTurnProvider; requestDigest: string; scope: DispatchScope }>): Promise<ProviderAccessConsumeOutcome>;
    settleDispatchConsumption(input: Readonly<{ consumptionDigest: string; disposition: "abandoned_without_claim" | "claim_committed"; expectedBinding: DispatchBinding; operationId: string; provider: ContainedTurnProvider; scope: DispatchScope; settlementRequestId: string }>): Promise<Readonly<{ kind: "settled"; receipt: unknown } | { kind: "conflict" | "invalid" | "indeterminate" | "not_found"; reason?: string }>>;
  };
  readonly resolve: { execute(input: Readonly<{ provider: ContainedTurnProvider; scope: ContainedTurnScope }>): Promise<Readonly<{ binding: OuterBinding; evidence: OuterEvidence; kind: "resolved" } | { evidence: OuterEvidence; kind: "unavailable"; reason: string }>> };
  readonly revalidate: { execute(input: Readonly<{ binding: OuterBinding; provider: ContainedTurnProvider; scope: ContainedTurnScope }>): Promise<Readonly<{ binding: OuterBinding; evidence: OuterEvidence; kind: "valid" } | { evidence: OuterEvidence; kind: "rejected"; reason: string }>> };
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

type CapturedOwner = Readonly<{
  consumeForDispatch: OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["consumeForDispatch"];
  observeDispatchConsumption: OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["observeDispatchConsumption"];
  resolve: OuterContainedTurnProviderAccess["resolve"]["execute"];
  revalidate: OuterContainedTurnProviderAccess["revalidate"]["execute"];
  settleDispatchConsumption: OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["settleDispatchConsumption"];
}>;

const exactStableDataRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    throw new ProviderAccessRouteCOwnerError("not_data_record");
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProviderAccessRouteCOwnerError("invalid_prototype");
    }
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
    if (Object.isExtensible(value)) {
      throw new ProviderAccessRouteCOwnerError("mutable_shape");
    }
  } catch (error) {
    if (error instanceof ProviderAccessRouteCOwnerError) { throw error; }
    throw new ProviderAccessRouteCOwnerError("invalid_shape");
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some(key => typeof key !== "string") ||
    ownKeys.map(String).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new ProviderAccessRouteCOwnerError("invalid_shape");
  }
  const record: Record<string, unknown> = {};
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

const capturedMethod = <Method>(owner: object, value: unknown): Method => {
  if (typeof value !== "function") {
    throw new ProviderAccessRouteCOwnerError("invalid_method");
  }
  return value.bind(owner) as Method;
};

const captureProviderAccessOwner = (value: unknown): CapturedOwner => {
  const outer = exactStableDataRecord(value, ["dispatchConsumptionV1", "resolve", "revalidate"]);
  const dispatchOwner = exactStableDataRecord(outer.dispatchConsumptionV1, [
    "consumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption",
  ]);
  const resolveOwner = exactStableDataRecord(outer.resolve, ["execute"]);
  const revalidateOwner = exactStableDataRecord(outer.revalidate, ["execute"]);
  return Object.freeze({
    consumeForDispatch: capturedMethod<CapturedOwner["consumeForDispatch"]>(dispatchOwner, dispatchOwner.consumeForDispatch),
    observeDispatchConsumption: capturedMethod<CapturedOwner["observeDispatchConsumption"]>(dispatchOwner, dispatchOwner.observeDispatchConsumption),
    resolve: capturedMethod<CapturedOwner["resolve"]>(resolveOwner, resolveOwner.execute),
    revalidate: capturedMethod<CapturedOwner["revalidate"]>(revalidateOwner, revalidateOwner.execute),
    settleDispatchConsumption: capturedMethod<CapturedOwner["settleDispatchConsumption"]>(dispatchOwner, dispatchOwner.settleDispatchConsumption),
  });
};

const opaqueEvidenceDigest = (evidence: OuterEvidence): string => digestContainedTurnCanonicalValue(evidence as never);
const proofId = (evidence: OuterEvidence, purpose: OuterEvidence["purpose"]) => containedTurnIdentity("proof", `proof:provider-access:${purpose}:${opaqueEvidenceDigest(evidence)}`);
const evidenceId = (evidence: OuterEvidence, purpose: OuterEvidence["purpose"]) => containedTurnIdentity("evidence", `evidence:provider-access:${purpose}:${opaqueEvidenceDigest(evidence)}`);
const snapshot = (binding: OuterBinding, evidence: OuterEvidence): ContainedTurnProviderAccessSnapshot => Object.freeze({
  accessRef: binding.accessRef,
  credentialBindingDigest: digestContainedTurnCanonicalValue({ ownerDigest: binding.credentialBindingDigest }),
  credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
  ownerAuthorityDigest: evidence.bindingAuthorityDigest, projectId: binding.projectId, provider: binding.provider,
  providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef,
  revision: binding.revision, tenantId: binding.tenantId,
});
const resolutionDigest = (binding: ContainedTurnProviderAccessSnapshot, evidence: OuterEvidence, phase: "acceptance" | "dispatch") => digestContainedTurnCanonicalValue({
  bindingDigest: containedTurnProviderAccessSnapshotDigest(binding), ownerAuthorityDigest: evidence.authorityDigest,
  phase, proofPurpose: evidence.purpose, proofRef: evidence.proofRef,
});
const grantEvidenceId = (phase: "consume" | "settle", value: unknown) => containedTurnIdentity(
  "evidence", `evidence:provider-access:${phase}:${digestContainedTurnCanonicalValue(value as never)}`,
);

/** Real ACL from both Provider Access V1 owner contracts into the single Agent Execution port. */
export const createContainedTurnProviderAccessPort = (outer: OuterContainedTurnProviderAccess): ContainedTurnProviderAccessPort => {
  const owner = captureProviderAccessOwner(outer);
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
    let outcome: ProviderAccessConsumeOutcome;
    try {outcome = await owner.consumeForDispatch(request);} catch {return { evidenceId: grantEvidenceId("consume", request), kind: "indeterminate" };}
    if (outcome.kind === "indeterminate") {
      try {outcome = await owner.observeDispatchConsumption({ grantRequestId: request.grantRequestId, provider: request.provider, requestDigest: request.requestDigest, scope });}
      catch {return { evidenceId: grantEvidenceId("consume", request), kind: "indeterminate" };}
    }
    if (outcome.kind === "consumed") {
      const receipt = outcome.receipt;
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
      return { kind: "prevented", preventionProofId: containedTurnIdentity("proof", `proof:provider-access:dispatch:${digestContainedTurnCanonicalValue(outcome.prevention as never)}`) };
    }
    return { evidenceId: grantEvidenceId("consume", outcome), kind: "indeterminate" };
  },
  async settleConsumedGrant(input) {
    const receipt = input.receipt;
    try {
      const outcome = await owner.settleDispatchConsumption({
        consumptionDigest: receipt.consumptionDigest, disposition: input.disposition,
        expectedBinding: receipt.authorityFacts, operationId: receipt.operationId, provider: receipt.provider,
        scope: receipt.scope, settlementRequestId: input.settlementRequestId,
      });
      return outcome.kind === "settled" ? { kind: "settled" } : { evidenceId: grantEvidenceId("settle", { input, outcome }), kind: "indeterminate" };
    } catch {return { evidenceId: grantEvidenceId("settle", input), kind: "indeterminate" };}
  },
  async resolveForAcceptance(input: Readonly<{ intent: ContainedTurnIntent; provider: ContainedTurnProvider; scope: ContainedTurnScope }>) {
    const outcome = await owner.resolve({ provider: input.provider, scope: input.scope });
    if (outcome.evidence.purpose !== "acceptance") {return { evidenceId: evidenceId(outcome.evidence, "acceptance"), kind: "indeterminate", reason: "authority_unknown" };}
    if (outcome.kind === "resolved") {const binding = snapshot(outcome.binding, outcome.evidence); return { acceptanceProofId: proofId(outcome.evidence, "acceptance"), acceptanceResolutionDigest: resolutionDigest(binding, outcome.evidence, "acceptance"), kind: "resolved", snapshot: binding };}
    if (outcome.reason === "revoked" || outcome.reason === "not_found") {return { kind: "prevented", preventionProofId: proofId(outcome.evidence, "acceptance"), reason: "access_denied" };}
    return { evidenceId: evidenceId(outcome.evidence, "acceptance"), kind: "indeterminate", reason: "authority_unknown" };
  },
  async revalidateForDispatch(input) {
    const outerBinding: OuterBinding = Object.freeze({ ...input.acceptedSnapshot, credentialBindingDigest: input.acceptedSnapshot.ownerAuthorityDigest });
    const outcome = await owner.revalidate({ binding: outerBinding, provider: input.acceptedSnapshot.provider, scope: input.scope });
    if (outcome.evidence.purpose !== "dispatch") {return { evidenceId: evidenceId(outcome.evidence, "dispatch"), kind: "indeterminate", reason: "authority_unknown" };}
    if (outcome.kind === "valid") {const binding = snapshot(outcome.binding, outcome.evidence); return { dispatchProofId: proofId(outcome.evidence, "dispatch"), dispatchResolutionDigest: resolutionDigest(binding, outcome.evidence, "dispatch"), kind: "current", snapshot: binding };}
    if (outcome.reason === "revoked" || outcome.reason.endsWith("_changed") || outcome.reason === "credential_rotated" || outcome.reason === "revision_changed") {return { kind: "prevented", preventionProofId: proofId(outcome.evidence, "dispatch"), reason: "access_revoked" };}
    return { evidenceId: evidenceId(outcome.evidence, "dispatch"), kind: "indeterminate", reason: "authority_unknown" };
  },
  };
  return Object.freeze(port);
};
