import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { containedTurnDispatchClaimBindingDigest, type ContainedTurnConsumedGrantReceipt, type ContainedTurnDispatchGrantOwner, type ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnOperationCutoffRevision } from "../domain/contained-turn-output-authority.js";

export interface OuterContainedTurnConsumedGrantReceipt {
  readonly grantRequestRef: string;
  readonly ownerAuthorityRef: string;
  readonly ownerReceiptRef: string;
  readonly validThroughOperationCutoffRevision: ContainedTurnOperationCutoffRevision;
}

const opaqueGrantFieldDigest = (
  owner: ContainedTurnDispatchGrantOwner,
  field: "authority" | "request" | "receipt",
  ref: string,
) => digestContainedTurnCanonicalValue({ field, owner, ref });

/** Maps either owner's published receipt without importing its domain model. */
export const normalizeContainedTurnConsumedGrantReceipt = <Owner extends ContainedTurnDispatchGrantOwner>(
  owner: Owner,
  subject: ContainedTurnDispatchGrantSubject,
  outer: OuterContainedTurnConsumedGrantReceipt,
): ContainedTurnConsumedGrantReceipt<Owner> => Object.freeze({
  claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject),
  grantRequestDigest: opaqueGrantFieldDigest(owner, "request", outer.grantRequestRef),
  grantRequestId: `grant-request:${opaqueGrantFieldDigest(owner, "request", outer.grantRequestRef)}`,
  owner,
  ownerAuthorityDigest: opaqueGrantFieldDigest(owner, "authority", outer.ownerAuthorityRef),
  ownerReceiptDigest: opaqueGrantFieldDigest(owner, "receipt", outer.ownerReceiptRef),
  validThroughOperationCutoffRevision: outer.validThroughOperationCutoffRevision,
});
