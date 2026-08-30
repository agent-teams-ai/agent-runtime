import { digestContainedTurnCanonicalValue, type ContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import { containedTurnIdentity, type ContainedTurnAttemptId, type ContainedTurnCustodyId, type ContainedTurnIdentity, type ContainedTurnOperationId, type ContainedTurnPreparationToken, type ContainedTurnWorkspaceId } from "./contained-turn-identities.js";
import type { ContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";

export type ContainedTurnCleanupPermitId = ContainedTurnIdentity<"cleanup_permit">;

export interface ContainedTurnDispatchPreparationIdentity {
  readonly attemptId: ContainedTurnAttemptId;
  readonly custodyId: ContainedTurnCustodyId;
  readonly operationCutoffRevision: ContainedTurnOperationCutoffRevision;
  readonly operationId: ContainedTurnOperationId;
  readonly preparationToken: ContainedTurnPreparationToken;
  readonly preparedOperationRevision: number;
  readonly workspaceId: ContainedTurnWorkspaceId;
}

export interface ContainedTurnCleanupPermit extends ContainedTurnDispatchPreparationIdentity {
  readonly permitDigest: ContainedTurnCanonicalDigest;
  readonly permitId: ContainedTurnCleanupPermitId;
}

interface PreparationBase extends ContainedTurnDispatchPreparationIdentity {
  readonly providerAccessGrantRequestId: string;
  readonly runtimeSecurityGrantRequestId: string;
}

export type ContainedTurnDispatchPreparation =
  | (PreparationBase & { readonly kind: "active" })
  | (PreparationBase & { readonly kind: "claimed" })
  | (PreparationBase & {
    readonly cleanupEvidenceIds: readonly string[];
    readonly cleanupPermit: ContainedTurnCleanupPermit;
    readonly custodyReleased: boolean;
    readonly kind: "cleanup_pending";
    readonly providerAccessSettled: boolean;
    readonly runtimeSecuritySettled: boolean;
  })
  | (PreparationBase & {
    readonly cleanupPermitId: ContainedTurnCleanupPermitId;
    readonly kind: "cleanup_closed";
  });

export const containedTurnCleanupPermit = (
  preparation: Extract<ContainedTurnDispatchPreparation, { readonly kind: "active" }>,
  nonce: string,
): ContainedTurnCleanupPermit => {
  const permitDigest = digestContainedTurnCanonicalValue({
    attemptId: preparation.attemptId,
    custodyId: preparation.custodyId,
    nonce,
    operationCutoffRevision: preparation.operationCutoffRevision,
    operationId: preparation.operationId,
    preparationToken: preparation.preparationToken,
    preparedOperationRevision: preparation.preparedOperationRevision,
    purpose: "contained_turn_preparation_cleanup_v1",
    workspaceId: preparation.workspaceId,
  });
  return Object.freeze({
    attemptId: preparation.attemptId,
    custodyId: preparation.custodyId,
    operationCutoffRevision: preparation.operationCutoffRevision,
    operationId: preparation.operationId,
    permitDigest,
    permitId: containedTurnIdentity("cleanup_permit", `cleanup-permit:${permitDigest}`),
    preparationToken: preparation.preparationToken,
    preparedOperationRevision: preparation.preparedOperationRevision,
    workspaceId: preparation.workspaceId,
  });
};
export const claimContainedTurnDispatchPreparation = (
  preparation: ContainedTurnDispatchPreparation,
): ContainedTurnDispatchPreparation => {
  if (preparation.kind === "claimed") {return preparation;}
  if (preparation.kind !== "active") {
    throw new TypeError("retired dispatch preparation can never be claimed");
  }
  return Object.freeze({ ...preparation, kind: "claimed" });
};

export const retireContainedTurnDispatchPreparation = (
  preparation: ContainedTurnDispatchPreparation,
  nonce: string,
): ContainedTurnDispatchPreparation => {
  if (preparation.kind === "claimed") {
    throw new TypeError("claimed dispatch preparation can never mint a cleanup permit");
  }
  if (preparation.kind !== "active") {return preparation;}
  return Object.freeze({
    ...preparation,
    cleanupEvidenceIds: Object.freeze([]),
    cleanupPermit: containedTurnCleanupPermit(preparation, nonce),
    custodyReleased: false,
    kind: "cleanup_pending",
    providerAccessSettled: false,
    runtimeSecuritySettled: false,
  });
};

const samePermit = (left: ContainedTurnCleanupPermit, right: ContainedTurnCleanupPermit): boolean =>
  left.permitId === right.permitId && left.permitDigest === right.permitDigest &&
  left.operationId === right.operationId && left.preparationToken === right.preparationToken &&
  left.attemptId === right.attemptId && left.custodyId === right.custodyId &&
  left.workspaceId === right.workspaceId &&
  left.preparedOperationRevision === right.preparedOperationRevision &&
  left.operationCutoffRevision === right.operationCutoffRevision;

export const recordContainedTurnPreparationCleanup = (
  preparation: ContainedTurnDispatchPreparation,
  input: Readonly<{
    evidenceId?: string;
    permit: ContainedTurnCleanupPermit;
    target: "custody" | "provider_access" | "runtime_security";
  }>,
): ContainedTurnDispatchPreparation => {
  if (preparation.kind === "cleanup_closed") {
    if (preparation.cleanupPermitId !== input.permit.permitId) {
      throw new TypeError("cleanup permit substitution rejected");
    }
    return preparation;
  }
  if (preparation.kind !== "cleanup_pending" || !samePermit(preparation.cleanupPermit, input.permit)) {
    throw new TypeError("cleanup requires the exact retired preparation permit");
  }
  const candidate = {
    ...preparation,
    cleanupEvidenceIds: input.evidenceId === undefined
      ? preparation.cleanupEvidenceIds
      : Object.freeze([...new Set([...preparation.cleanupEvidenceIds, input.evidenceId])]),
    custodyReleased: preparation.custodyReleased || input.target === "custody",
    providerAccessSettled: preparation.providerAccessSettled || input.target === "provider_access",
    runtimeSecuritySettled: preparation.runtimeSecuritySettled || input.target === "runtime_security",
  };
  if (candidate.cleanupEvidenceIds.length === 0 && candidate.custodyReleased &&
      candidate.providerAccessSettled && candidate.runtimeSecuritySettled) {
    return Object.freeze({
      ...preparation,
      cleanupPermitId: preparation.cleanupPermit.permitId,
      kind: "cleanup_closed",
    });
  }
  return Object.freeze(candidate);
};
