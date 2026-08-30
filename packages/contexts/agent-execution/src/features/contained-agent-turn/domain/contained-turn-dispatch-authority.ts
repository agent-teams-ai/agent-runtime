import type { ContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import { digestContainedTurnCanonicalValue } from "./contained-turn-codecs.js";
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
import type { ContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import { assertContainedTurnExactRecord } from "./contained-turn-record.js";

export const CONTAINED_TURN_DISPATCH_GRANT_OWNERS = Object.freeze([
  "provider_access",
  "runtime_security",
] as const);

export type ContainedTurnDispatchGrantOwner =
  (typeof CONTAINED_TURN_DISPATCH_GRANT_OWNERS)[number];

/** Provider-neutral subject frozen before either authority owner consumes a grant. */
export interface ContainedTurnDispatchGrantSubject {
  readonly attemptId: ContainedTurnAttemptId;
  readonly custodyId: ContainedTurnCustodyId;
  readonly effectId: ContainedTurnEffectId;
  readonly executionGenerationId: ContainedTurnExecutionGenerationId;
  readonly hostBootId: ContainedTurnHostBootId;
  readonly hostInstanceId: ContainedTurnHostInstanceId;
  readonly operationCutoffRevision: ContainedTurnOperationCutoffRevision;
  readonly operationId: ContainedTurnOperationId;
  readonly preparationToken: ContainedTurnPreparationToken;
  readonly purpose: "contained_turn_provider_start_v1";
  readonly scopeDigest: ContainedTurnCanonicalDigest;
  readonly workspaceId: ContainedTurnWorkspaceId;
}

export const containedTurnDispatchClaimBindingDigest = (
  subject: ContainedTurnDispatchGrantSubject,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue({
  attemptId: subject.attemptId,
  custodyId: subject.custodyId,
  effectId: subject.effectId,
  executionGenerationId: subject.executionGenerationId,
  hostBootId: subject.hostBootId,
  hostInstanceId: subject.hostInstanceId,
  operationCutoffRevision: subject.operationCutoffRevision,
  operationId: subject.operationId,
  preparationToken: subject.preparationToken,
  purpose: subject.purpose,
  scopeDigest: subject.scopeDigest,
  workspaceId: subject.workspaceId,
});

/**
 * The only owner grant representation admitted at the Kernel ACL. Owner
 * lifecycle details and opaque references are deliberately absent.
 */
export interface ContainedTurnConsumedGrantReceipt<Owner extends ContainedTurnDispatchGrantOwner = ContainedTurnDispatchGrantOwner> {
  readonly claimBindingDigest: ContainedTurnCanonicalDigest;
  readonly grantRequestDigest: ContainedTurnCanonicalDigest;
  readonly grantRequestId: string;
  readonly owner: Owner;
  readonly ownerAuthorityDigest: ContainedTurnCanonicalDigest;
  readonly ownerReceiptDigest: ContainedTurnCanonicalDigest;
  readonly validThroughOperationCutoffRevision: ContainedTurnOperationCutoffRevision;
}

export type ContainedTurnConsumedGrantReceipts = readonly [
  ContainedTurnConsumedGrantReceipt<"provider_access">,
  ContainedTurnConsumedGrantReceipt<"runtime_security">,
];

export const validateContainedTurnConsumedGrantReceipts = (
  subject: ContainedTurnDispatchGrantSubject,
  receipts: readonly ContainedTurnConsumedGrantReceipt[],
): ContainedTurnConsumedGrantReceipts => {
  if (receipts.length !== 2) {
    throw new TypeError("dispatch claim requires exactly two consumed owner grant receipts");
  }
  const [providerAccess, runtimeSecurity] = receipts;
  if (providerAccess === undefined || runtimeSecurity === undefined) {
    throw new TypeError("dispatch claim requires both owner grant receipts");
  }
  for (const receipt of receipts) {
    assertContainedTurnExactRecord("consumed dispatch grant receipt", receipt, [
      "claimBindingDigest", "grantRequestDigest", "grantRequestId", "owner",
      "ownerAuthorityDigest", "ownerReceiptDigest", "validThroughOperationCutoffRevision",
    ]);
  }
  if (providerAccess.owner !== "provider_access" || runtimeSecurity.owner !== "runtime_security") {
    throw new TypeError("dispatch claim receipts must be ordered one per exact owner");
  }
  const expectedBinding = containedTurnDispatchClaimBindingDigest(subject);
  for (const receipt of receipts) {
    if (receipt.claimBindingDigest !== expectedBinding) {
      throw new TypeError(`${receipt.owner} consumed receipt has the wrong claim binding`);
    }
    if (receipt.validThroughOperationCutoffRevision < subject.operationCutoffRevision) {
      throw new TypeError(`${receipt.owner} consumed receipt is expired for the current cutoff`);
    }
  }
  return receipts as ContainedTurnConsumedGrantReceipts;
};

