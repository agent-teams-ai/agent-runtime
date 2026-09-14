import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import type { ContainedTurnOperationShape } from "./contained-turn-operation-shape.js";
import type { ContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import type { ContainedTurnProvider } from "./contained-turn-authority.js";
import { digestContainedTurnCanonicalInput, parseContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnExecutionGenerationId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnPreparationToken,
  ContainedTurnWorkspaceId,
} from "./contained-turn-identities.js";
import { containedTurnOperationCutoffRevision, type ContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import { assertContainedTurnCanonicalArray, assertContainedTurnDataRecord, assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "./contained-turn-record.js";

import { validateContainedTurnIdentity } from "./contained-turn-identities.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";

export const CONTAINED_TURN_OWNER_DISPATCH_PURPOSE = "contained-turn.provider-dispatch/v1" as const;
export const CONTAINED_TURN_DISPATCH_GRANT_OWNERS = Object.freeze(["provider_access", "runtime_security"] as const);
export type ContainedTurnDispatchGrantOwner = (typeof CONTAINED_TURN_DISPATCH_GRANT_OWNERS)[number];

export interface ContainedTurnProviderAccessDispatchExpectation {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigest: string;
  readonly bindingDigest: string; readonly bindingRevision: number; readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string; readonly credentialGeneration: number;
  readonly providerAccountRef: string; readonly providerRouteRef: string;
}
export interface ContainedTurnRuntimeSecurityDispatchExpectation {
  readonly acceptedAuthorityDigest: string; readonly authorityGeneration: string; readonly authorityHeadDigest: string;
  readonly authorityRevision: string; readonly constraintsDigest: string; readonly containmentPolicyDigest: string;
  readonly providerBindingDigest: string; readonly providerId: string;
}
export interface ContainedTurnOwnerDispatchRequestIdentity {
  readonly claimBindingDigest: ContainedTurnCanonicalDigest;
  readonly grantRequestId: string;
  readonly requestDigest: ContainedTurnCanonicalDigest;
}

/** Complete provider-neutral non-secret packet frozen before either owner is called. */
export interface ContainedTurnDispatchGrantSubject {
  readonly attemptId: ContainedTurnAttemptId; readonly custodyId: ContainedTurnCustodyId;
  readonly effectId: ContainedTurnEffectId; readonly executionGenerationId: ContainedTurnExecutionGenerationId;
  readonly hostBootId: ContainedTurnHostBootId; readonly hostInstanceId: ContainedTurnHostInstanceId;
  readonly operationCutoffRevision: ContainedTurnOperationCutoffRevision; readonly operationId: ContainedTurnOperationId;
  readonly preparationToken: ContainedTurnPreparationToken; readonly provider: ContainedTurnProvider;
  readonly providerAccessExpectation: ContainedTurnProviderAccessDispatchExpectation;
  readonly providerAccessRequest: ContainedTurnOwnerDispatchRequestIdentity;
  readonly purpose: "contained_turn_provider_start_v1";
  readonly runtimeSecurityExpectation: ContainedTurnRuntimeSecurityDispatchExpectation;
  readonly runtimeSecurityRequest: ContainedTurnOwnerDispatchRequestIdentity;
  readonly scope: Readonly<{ projectId: string; tenantId: string }>;
  readonly scopeDigest: ContainedTurnCanonicalDigest; readonly workspaceId: ContainedTurnWorkspaceId;
}
type SubjectSeed = Omit<ContainedTurnDispatchGrantSubject, "providerAccessRequest" | "runtimeSecurityRequest">;

const claimBindingValue = (subject: SubjectSeed | ContainedTurnDispatchGrantSubject) => ({
  attemptId: subject.attemptId, custodyId: subject.custodyId, effectId: subject.effectId,
  executionGenerationId: subject.executionGenerationId, hostBootId: subject.hostBootId,
  hostInstanceId: subject.hostInstanceId, operationCutoffRevision: subject.operationCutoffRevision,
  operationId: subject.operationId, preparationToken: subject.preparationToken, provider: subject.provider,
  providerAccessExpectation: subject.providerAccessExpectation, purpose: subject.purpose,
  runtimeSecurityExpectation: subject.runtimeSecurityExpectation, scope: subject.scope,
  scopeDigest: subject.scopeDigest, workspaceId: subject.workspaceId,
});
export const containedTurnDispatchClaimBindingDigest = (
  subject: SubjectSeed | ContainedTurnDispatchGrantSubject,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalInput(claimBindingValue(subject));
export const containedTurnDispatchGrantRequestId = (
  owner: ContainedTurnDispatchGrantOwner,
  subject: SubjectSeed | ContainedTurnDispatchGrantSubject,
): string => `grant-request:${digestContainedTurnCanonicalInput({
  claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject), owner,
  purpose: "contained_turn_dispatch_grant_request_v1",
})}`;
const providerAccessClaimBindingDigest = (subject: SubjectSeed, grantRequestId: string) =>
  digestContainedTurnCanonicalInput({
    ...subject.providerAccessExpectation, grantRequestId, operationId: subject.operationId,
    provider: subject.provider, purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
  });
const providerAccessRequestDigest = (subject: SubjectSeed, grantRequestId: string, claimBindingDigest: string) =>
  digestContainedTurnCanonicalInput({
    binding: subject.providerAccessExpectation, claimBindingDigest, grantRequestId,
    operationId: subject.operationId, provider: subject.provider,
    purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
  });
const runtimeSecurityRequestDigest = (subject: SubjectSeed, grantRequestId: string, claimBindingDigest: string) => {
  const expected = subject.runtimeSecurityExpectation;
  return digestContainedTurnCanonicalInput({
    acceptedAuthorityDigest: expected.acceptedAuthorityDigest, authorityGeneration: expected.authorityGeneration,
    claimBindingDigest, expectedAuthorityHeadDigest: expected.authorityHeadDigest,
    expectedAuthorityRevision: expected.authorityRevision, expectedConstraintsDigest: expected.constraintsDigest,
    expectedContainmentPolicyDigest: expected.containmentPolicyDigest, grantRequestId, operationId: subject.operationId,
    providerBindingDigest: expected.providerBindingDigest, providerId: expected.providerId,
    purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
  });
};
export const completeContainedTurnDispatchGrantSubject = (seed: SubjectSeed): ContainedTurnDispatchGrantSubject => {
  const providerAccessGrantRequestId = containedTurnDispatchGrantRequestId("provider_access", seed);
  const runtimeSecurityGrantRequestId = containedTurnDispatchGrantRequestId("runtime_security", seed);
  const providerAccessClaim = providerAccessClaimBindingDigest(seed, providerAccessGrantRequestId);
  const runtimeSecurityClaim = containedTurnDispatchClaimBindingDigest(seed);
  return detachAndFreezeContainedTurnValue({
    ...seed,
    providerAccessRequest: {
      claimBindingDigest: providerAccessClaim, grantRequestId: providerAccessGrantRequestId,
      requestDigest: providerAccessRequestDigest(seed, providerAccessGrantRequestId, providerAccessClaim),
    },
    runtimeSecurityRequest: {
      claimBindingDigest: runtimeSecurityClaim, grantRequestId: runtimeSecurityGrantRequestId,
      requestDigest: runtimeSecurityRequestDigest(seed, runtimeSecurityGrantRequestId, runtimeSecurityClaim),
    },
  });
};

export interface ContainedTurnConsumedGrantReceipt<Owner extends ContainedTurnDispatchGrantOwner = ContainedTurnDispatchGrantOwner> {
  readonly authorityFacts: Owner extends "provider_access"
    ? ContainedTurnProviderAccessDispatchExpectation : ContainedTurnRuntimeSecurityDispatchExpectation;
  readonly claimBeforeControlTime: number; readonly claimBindingDigest: ContainedTurnCanonicalDigest;
  readonly consumedAtControlTime: number; readonly consumptionDigest: string;
  readonly grantRequestDigest: ContainedTurnCanonicalDigest; readonly grantRequestId: string;
  readonly operationId: ContainedTurnOperationId; readonly owner: Owner; readonly ownerEvidenceRef: string;
  readonly provider: ContainedTurnProvider; readonly purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE;
  readonly requestDigest: ContainedTurnCanonicalDigest;
  readonly scope: Readonly<{ projectId: string; scopeDigest: ContainedTurnCanonicalDigest; tenantId: string }>;
  readonly validThroughOperationCutoffRevision: ContainedTurnOperationCutoffRevision;
}
export type ContainedTurnConsumedGrantReceipts = readonly [
  ContainedTurnConsumedGrantReceipt<"provider_access">,
  ContainedTurnConsumedGrantReceipt<"runtime_security">,
];

/** Recorded structure only. Current owner authority still requires the explicit subject below. */
export function validateContainedTurnConsumedGrantReceiptShape(
  receipt: unknown,
): asserts receipt is ContainedTurnConsumedGrantReceipt<"provider_access"> | ContainedTurnConsumedGrantReceipt<"runtime_security"> {
  assertContainedTurnExactRecord("consumed dispatch grant receipt", receipt, [
    "authorityFacts", "claimBeforeControlTime", "claimBindingDigest", "consumedAtControlTime",
    "consumptionDigest", "grantRequestDigest", "grantRequestId", "operationId", "owner",
    "ownerEvidenceRef", "provider", "purpose", "requestDigest", "scope",
    "validThroughOperationCutoffRevision",
  ]);
  invariant(receipt.owner === "provider_access" || receipt.owner === "runtime_security", "unknown dispatch receipt owner");
  invariant(receipt.purpose === CONTAINED_TURN_OWNER_DISPATCH_PURPOSE, "unknown dispatch receipt purpose");
  assertContainedTurnExactRecord("consumption scope", receipt.scope, ["projectId", "scopeDigest", "tenantId"]);
  for (const value of [receipt.consumptionDigest, receipt.grantRequestId, receipt.ownerEvidenceRef,
    receipt.provider, receipt.scope.projectId, receipt.scope.tenantId]) {
    validateContainedTurnText("consumption identity", value, CONTAINED_TURN_LIMITS.text.identifier);
  }
  for (const value of [receipt.claimBindingDigest, receipt.grantRequestDigest, receipt.requestDigest, receipt.scope.scopeDigest]) {
    parseContainedTurnCanonicalDigest(value);
  }
  validateContainedTurnIdentity("operation", receipt.operationId);
  containedTurnOperationCutoffRevision(receipt.validThroughOperationCutoffRevision);
  invariant(typeof receipt.claimBeforeControlTime === "number" && Number.isSafeInteger(receipt.claimBeforeControlTime) && !Object.is(receipt.claimBeforeControlTime, -0) &&
    typeof receipt.consumedAtControlTime === "number" && Number.isSafeInteger(receipt.consumedAtControlTime) && !Object.is(receipt.consumedAtControlTime, -0),
  "consumption control times must be safe integers");
  validateConsumedAuthorityFacts(receipt.owner, receipt.authorityFacts);
}

const validateConsumedAuthorityFacts = (owner: ContainedTurnDispatchGrantOwner, facts: unknown): void => {
  const textKeys = owner === "provider_access"
    ? ["acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "credentialBindingDigest",
      "credentialBindingRef", "providerAccountRef", "providerRouteRef"]
    : ["acceptedAuthorityDigest", "authorityGeneration", "authorityHeadDigest", "authorityRevision",
      "constraintsDigest", "containmentPolicyDigest", "providerBindingDigest", "providerId"];
  const numberKeys = owner === "provider_access" ? ["bindingRevision", "credentialGeneration"] : [];
  assertContainedTurnExactRecord("consumption authority", facts, [...textKeys, ...numberKeys]);
  for (const key of textKeys) {
    validateContainedTurnText("consumption authority", facts[key], CONTAINED_TURN_LIMITS.text.identifier);
  }
  for (const key of numberKeys) {
    invariant(typeof facts[key] === "number" && Number.isSafeInteger(facts[key]) && !Object.is(facts[key], -0), "invalid consumption authority revision");
  }
};

export function validateContainedTurnConsumedGrantReceiptTuple(
  receipts: unknown,
): asserts receipts is ContainedTurnConsumedGrantReceipts {
  assertContainedTurnCanonicalArray(receipts);
  invariant(receipts.length === 2, "dispatch claim requires exactly two consumed owner grant receipts");
  const [providerAccess, runtimeSecurity] = receipts;
  validateContainedTurnConsumedGrantReceiptShape(providerAccess);
  validateContainedTurnConsumedGrantReceiptShape(runtimeSecurity);
  invariant(providerAccess.owner === "provider_access" && runtimeSecurity.owner === "runtime_security",
    "dispatch claim receipts must be ordered one per exact owner");
}

const sameFacts = (left: object, right: object): boolean =>
  digestContainedTurnCanonicalInput(left) === digestContainedTurnCanonicalInput(right);

/** Field-complete owner receipt verification. No opaque digest is accepted as a substitute for owner facts. */
export const validateContainedTurnConsumedGrantReceipts = (
  subject: ContainedTurnDispatchGrantSubject,
  receipts: unknown,
): ContainedTurnConsumedGrantReceipts => {
  const { providerAccessRequest: _providerRequest, runtimeSecurityRequest: _securityRequest, ...seed } = subject;
  const expectedSubject = completeContainedTurnDispatchGrantSubject(seed);
  if (!sameFacts(subject.providerAccessRequest, expectedSubject.providerAccessRequest) ||
      !sameFacts(subject.runtimeSecurityRequest, expectedSubject.runtimeSecurityRequest)) {
    throw new TypeError("dispatch grant subject request identities have the wrong claim binding");
  }
  assertContainedTurnCanonicalArray(receipts);
  if (receipts.length !== 2) {throw new TypeError("dispatch claim requires exactly two consumed owner grant receipts");}
  const [providerAccess, runtimeSecurity] = receipts;
  assertContainedTurnDataRecord("consumed dispatch grant receipt", providerAccess);
  assertContainedTurnDataRecord("consumed dispatch grant receipt", runtimeSecurity);
  if (providerAccess.owner !== "provider_access" || runtimeSecurity.owner !== "runtime_security") {
    throw new TypeError("dispatch claim receipts must be ordered one per exact owner");
  }
  const sanitize = (
    receipt: unknown,
  ): ContainedTurnConsumedGrantReceipt<"provider_access"> | ContainedTurnConsumedGrantReceipt<"runtime_security"> => {
    validateContainedTurnConsumedGrantReceiptShape(receipt);
    const claimBindingDigest = parseContainedTurnCanonicalDigest(receipt.claimBindingDigest);
    const grantRequestDigest = parseContainedTurnCanonicalDigest(receipt.grantRequestDigest);
    const requestDigest = parseContainedTurnCanonicalDigest(receipt.requestDigest);
    const validThroughOperationCutoffRevision = containedTurnOperationCutoffRevision(receipt.validThroughOperationCutoffRevision);
    const expectedRequest = receipt.owner === "provider_access" ? subject.providerAccessRequest : subject.runtimeSecurityRequest;
    const expectedFacts = receipt.owner === "provider_access" ? subject.providerAccessExpectation : subject.runtimeSecurityExpectation;
    if (receipt.grantRequestId !== "grant-request:" + grantRequestDigest ||
        receipt.grantRequestId !== expectedRequest.grantRequestId || requestDigest !== expectedRequest.requestDigest ||
        claimBindingDigest !== expectedRequest.claimBindingDigest || receipt.operationId !== subject.operationId ||
        receipt.provider !== subject.provider || receipt.purpose !== CONTAINED_TURN_OWNER_DISPATCH_PURPOSE ||
        receipt.scope.tenantId !== subject.scope.tenantId || receipt.scope.projectId !== subject.scope.projectId ||
        receipt.scope.scopeDigest !== subject.scopeDigest || !sameFacts(receipt.authorityFacts, expectedFacts) ||
        validThroughOperationCutoffRevision < subject.operationCutoffRevision ||
        !Number.isSafeInteger(receipt.claimBeforeControlTime) || !Number.isSafeInteger(receipt.consumedAtControlTime) ||
        receipt.claimBeforeControlTime < receipt.consumedAtControlTime) {
      throw new TypeError(`${receipt.owner} consumed receipt does not prove the exact durable owner facts`);
    }
    return detachAndFreezeContainedTurnValue(receipt);
  };
  const providerReceipt = sanitize(providerAccess);
  const securityReceipt = sanitize(runtimeSecurity);
  invariant(providerReceipt.owner === "provider_access" && securityReceipt.owner === "runtime_security",
    "dispatch claim receipts must retain their exact owners");
  return Object.freeze([providerReceipt, securityReceipt]);
};

export const containedTurnGrantSettlementRequestId = (
  receipt: ContainedTurnConsumedGrantReceipt,
  disposition: "abandoned_without_claim" | "claim_committed",
): string => `grant-settlement:${digestContainedTurnCanonicalInput({
  consumptionDigest: receipt.consumptionDigest, disposition, grantRequestId: receipt.grantRequestId,
  operationId: receipt.operationId, owner: receipt.owner,
})}`;

export const validateContainedTurnOperationDispatchReceipts = (candidate: Pick<ContainedTurnKernelOperation,
  "operationId" | "adapterSnapshot" | "scope" | "acceptedAuthorityVector"> & { readonly dispatch: ContainedTurnOperationShape["dispatch"] }): void => {
  if (candidate.dispatch.kind !== "claimed") {return;}
  validateContainedTurnConsumedGrantReceiptTuple(candidate.dispatch.grantReceipts);
  const dispatchCutoffRevision = containedTurnOperationCutoffRevision(candidate.dispatch.operationCutoffRevision);
  for (const receipt of candidate.dispatch.grantReceipts) {
    invariant(receipt.operationId === candidate.operationId && receipt.provider === candidate.adapterSnapshot.provider &&
      receipt.scope.projectId === candidate.scope.projectId && receipt.scope.tenantId === candidate.scope.tenantId &&
      receipt.scope.scopeDigest === candidate.acceptedAuthorityVector.scopeDigest &&
      receipt.validThroughOperationCutoffRevision >= dispatchCutoffRevision &&
      receipt.grantRequestId === `grant-request:${receipt.grantRequestDigest}` &&
      receipt.claimBeforeControlTime >= receipt.consumedAtControlTime,
    "dispatch receipt must bind the operation and its claimed cutoff");
  }
};
