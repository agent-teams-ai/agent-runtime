import type { ContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import type { ContainedTurnProvider } from "./contained-turn-authority.js";
import { digestContainedTurnCanonicalValue, parseContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
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
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "./contained-turn-record.js";

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
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue(claimBindingValue(subject) as never);
export const containedTurnDispatchGrantRequestId = (
  owner: ContainedTurnDispatchGrantOwner,
  subject: SubjectSeed | ContainedTurnDispatchGrantSubject,
): string => `grant-request:${digestContainedTurnCanonicalValue({
  claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject), owner,
  purpose: "contained_turn_dispatch_grant_request_v1",
})}`;
const providerAccessClaimBindingDigest = (subject: SubjectSeed, grantRequestId: string) =>
  digestContainedTurnCanonicalValue({
    ...subject.providerAccessExpectation, grantRequestId, operationId: subject.operationId,
    provider: subject.provider, purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
  } as never);
const providerAccessRequestDigest = (subject: SubjectSeed, grantRequestId: string, claimBindingDigest: string) =>
  digestContainedTurnCanonicalValue({
    binding: subject.providerAccessExpectation, claimBindingDigest, grantRequestId,
    operationId: subject.operationId, provider: subject.provider,
    purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
  } as never);
const runtimeSecurityRequestDigest = (subject: SubjectSeed, grantRequestId: string, claimBindingDigest: string) => {
  const expected = subject.runtimeSecurityExpectation;
  return digestContainedTurnCanonicalValue({
    acceptedAuthorityDigest: expected.acceptedAuthorityDigest, authorityGeneration: expected.authorityGeneration,
    claimBindingDigest, expectedAuthorityHeadDigest: expected.authorityHeadDigest,
    expectedAuthorityRevision: expected.authorityRevision, expectedConstraintsDigest: expected.constraintsDigest,
    expectedContainmentPolicyDigest: expected.containmentPolicyDigest, grantRequestId, operationId: subject.operationId,
    providerBindingDigest: expected.providerBindingDigest, providerId: expected.providerId,
    purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
    scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
  } as never);
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

const sameFacts = (left: object, right: object): boolean =>
  digestContainedTurnCanonicalValue(left as never) === digestContainedTurnCanonicalValue(right as never);

/** Field-complete owner receipt verification. No opaque digest is accepted as a substitute for owner facts. */
export const validateContainedTurnConsumedGrantReceipts = (
  subject: ContainedTurnDispatchGrantSubject,
  receipts: readonly ContainedTurnConsumedGrantReceipt[],
): ContainedTurnConsumedGrantReceipts => {
  const { providerAccessRequest: _providerRequest, runtimeSecurityRequest: _securityRequest, ...seed } = subject;
  const expectedSubject = completeContainedTurnDispatchGrantSubject(seed);
  if (!sameFacts(subject.providerAccessRequest, expectedSubject.providerAccessRequest) ||
      !sameFacts(subject.runtimeSecurityRequest, expectedSubject.runtimeSecurityRequest)) {
    throw new TypeError("dispatch grant subject request identities have the wrong claim binding");
  }
  if (receipts.length !== 2) {throw new TypeError("dispatch claim requires exactly two consumed owner grant receipts");}
  const [providerAccess, runtimeSecurity] = receipts;
  if (providerAccess?.owner !== "provider_access" || runtimeSecurity?.owner !== "runtime_security") {
    throw new TypeError("dispatch claim receipts must be ordered one per exact owner");
  }
  const sanitize = <Owner extends ContainedTurnDispatchGrantOwner>(
    receipt: ContainedTurnConsumedGrantReceipt<Owner>,
  ): ContainedTurnConsumedGrantReceipt<Owner> => {
    assertContainedTurnExactRecord("consumed dispatch grant receipt", receipt, [
      "authorityFacts", "claimBeforeControlTime", "claimBindingDigest", "consumedAtControlTime",
      "consumptionDigest", "grantRequestDigest", "grantRequestId", "operationId", "owner",
      "ownerEvidenceRef", "provider", "purpose", "requestDigest", "scope",
      "validThroughOperationCutoffRevision",
    ]);
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
    return detachAndFreezeContainedTurnValue({
      ...receipt, authorityFacts: receipt.authorityFacts, claimBindingDigest, grantRequestDigest,
      requestDigest, validThroughOperationCutoffRevision,
    });
  };
  return Object.freeze([sanitize(providerAccess), sanitize(runtimeSecurity)]) as ContainedTurnConsumedGrantReceipts;
};

export const containedTurnGrantSettlementRequestId = (
  receipt: ContainedTurnConsumedGrantReceipt,
  disposition: "abandoned_without_claim" | "claim_committed",
): string => `grant-settlement:${digestContainedTurnCanonicalValue({
  consumptionDigest: receipt.consumptionDigest, disposition, grantRequestId: receipt.grantRequestId,
  operationId: receipt.operationId, owner: receipt.owner,
})}`;
