import { parseContainedTurnCanonicalDigest } from "../domain/contained-turn-codecs.js";
import type {
  ContainedTurnConsumedGrantReceipt,
  ContainedTurnDispatchGrantOwner,
  ContainedTurnDispatchGrantSubject,
} from "../domain/contained-turn-dispatch-authority.js";
import { detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";

export type OuterContainedTurnConsumedGrantReceipt<Owner extends ContainedTurnDispatchGrantOwner> = Omit<
  ContainedTurnConsumedGrantReceipt<Owner>,
  "grantRequestDigest" | "owner" | "validThroughOperationCutoffRevision"
>;

/** Explicit ACL projection. Every owner fact remains inspectable and is verified at the local CAS. */
export const normalizeContainedTurnConsumedGrantReceipt = <Owner extends ContainedTurnDispatchGrantOwner>(
  owner: Owner,
  subject: ContainedTurnDispatchGrantSubject,
  outer: OuterContainedTurnConsumedGrantReceipt<Owner>,
): ContainedTurnConsumedGrantReceipt<Owner> => {
  const request = owner === "provider_access" ? subject.providerAccessRequest : subject.runtimeSecurityRequest;
  if (outer.grantRequestId !== request.grantRequestId || !outer.grantRequestId.startsWith("grant-request:")) {
    throw new TypeError(`${owner} consumed receipt substituted the grant request identity`);
  }
  const grantRequestDigest = parseContainedTurnCanonicalDigest(
    outer.grantRequestId.slice("grant-request:".length),
  );
  return detachAndFreezeContainedTurnValue({
    ...outer,
    grantRequestDigest,
    owner,
    validThroughOperationCutoffRevision: subject.operationCutoffRevision,
  });
};
