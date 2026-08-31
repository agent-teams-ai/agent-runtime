import { digestContainedTurnCanonicalValue, parseContainedTurnCanonicalDigest } from "../domain/contained-turn-codecs.js";
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
  expectedGrantRequestId?: string,
): ContainedTurnConsumedGrantReceipt<Owner> => {
  let grantRequestDigest = opaqueGrantFieldDigest(owner, "request", outer.grantRequestRef);
  let grantRequestId = `grant-request:${grantRequestDigest}`;
  if (expectedGrantRequestId !== undefined) {
    if (outer.grantRequestRef !== expectedGrantRequestId ||
        !expectedGrantRequestId.startsWith("grant-request:")) {
      throw new TypeError(`${owner} consumed receipt substituted the grant request identity`);
    }
    grantRequestDigest = parseContainedTurnCanonicalDigest(
      expectedGrantRequestId.slice("grant-request:".length),
    );
    grantRequestId = expectedGrantRequestId;
  }
  return Object.freeze({
    claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject),
    grantRequestDigest,
    grantRequestId,
    owner,
    ownerAuthorityDigest: opaqueGrantFieldDigest(owner, "authority", outer.ownerAuthorityRef),
    ownerReceiptDigest: opaqueGrantFieldDigest(owner, "receipt", outer.ownerReceiptRef),
    validThroughOperationCutoffRevision: outer.validThroughOperationCutoffRevision,
  });
};
