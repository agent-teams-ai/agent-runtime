import type { ContainedTurnConsumedGrantReceipt } from "./contained-turn-dispatch-authority.js";
import { digestContainedTurnCanonicalValue, type ContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import { containedTurnIdentity, type ContainedTurnAttemptId, type ContainedTurnCustodyId, type ContainedTurnEvidenceId, type ContainedTurnIdentity, type ContainedTurnOperationId, type ContainedTurnPreparationToken, type ContainedTurnWorkspaceId, validateContainedTurnIdentity } from "./contained-turn-identities.js";
import type { ContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";

export type ContainedTurnCleanupPermitId = ContainedTurnIdentity<"cleanup_permit">;
export const CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT = 64;

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
  readonly providerAccessConsumptionReceipt?: ContainedTurnConsumedGrantReceipt<"provider_access">;
  readonly providerAccessGrantRequestId: string | null;
  readonly runtimeSecurityConsumptionReceipt?: ContainedTurnConsumedGrantReceipt<"runtime_security">;
  readonly runtimeSecurityGrantRequestId: string | null;
}

export type ContainedTurnDispatchPreparation =
  | (PreparationBase & { readonly kind: "active" })
  | (PreparationBase & { readonly kind: "claimed" })
  | (PreparationBase & {
    readonly cleanupEvidenceIds: readonly string[];
    readonly cleanupPermit: ContainedTurnCleanupPermit;
    readonly custodyReleased: boolean;
    readonly kind: "cleanup_pending";
    readonly providerAccessConsumptionEvidenceId: ContainedTurnEvidenceId | null;
    readonly providerAccessSettled: boolean;
    readonly runtimeSecurityConsumptionEvidenceId: ContainedTurnEvidenceId | null;
    readonly runtimeSecuritySettled: boolean;
  })
  | (PreparationBase & {
    readonly cleanupEvidenceIds: readonly string[];
    readonly cleanupPermitId: ContainedTurnCleanupPermitId;
    readonly kind: "cleanup_closed";
    readonly providerAccessConsumptionEvidenceId: ContainedTurnEvidenceId | null;
    readonly runtimeSecurityConsumptionEvidenceId: ContainedTurnEvidenceId | null;
  });

export interface ContainedTurnGrantConsumptionEvidenceIds {
  readonly providerAccessEvidenceId?: ContainedTurnEvidenceId;
  readonly runtimeSecurityEvidenceId?: ContainedTurnEvidenceId;
}

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
    providerAccessConsumptionReceipt: preparation.providerAccessConsumptionReceipt ?? null,
    providerAccessGrantRequestId: preparation.providerAccessGrantRequestId,
    purpose: "contained_turn_preparation_cleanup_v1",
    runtimeSecurityConsumptionReceipt: preparation.runtimeSecurityConsumptionReceipt ?? null,
    runtimeSecurityGrantRequestId: preparation.runtimeSecurityGrantRequestId,
    workspaceId: preparation.workspaceId,
  } as never);
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

export interface ContainedTurnConsumedGrantRequestIds {
  readonly providerAccessConsumptionReceipt?: ContainedTurnConsumedGrantReceipt<"provider_access">;
  readonly providerAccessGrantRequestId?: string;
  readonly runtimeSecurityConsumptionReceipt?: ContainedTurnConsumedGrantReceipt<"runtime_security">;
  readonly runtimeSecurityGrantRequestId?: string;
}

const validateGrantRequestId = (owner: string, value: string | null): void => {
  if (value !== null && !/^grant-request:sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${owner} consumed grant request ID must be digest-bound`);
  }
};

export const bindContainedTurnPreparationGrantRequests = (
  preparation: ContainedTurnDispatchPreparation,
  consumedGrantRequestIds: ContainedTurnConsumedGrantRequestIds,
): Extract<ContainedTurnDispatchPreparation, { readonly kind: "active" }> => {
  if (preparation.kind !== "active") {
    throw new TypeError("only an active dispatch preparation can bind consumed grants");
  }
  const providerAccessGrantRequestId =
    consumedGrantRequestIds.providerAccessConsumptionReceipt?.grantRequestId ?? consumedGrantRequestIds.providerAccessGrantRequestId ?? preparation.providerAccessGrantRequestId;
  const runtimeSecurityGrantRequestId =
    consumedGrantRequestIds.runtimeSecurityConsumptionReceipt?.grantRequestId ?? consumedGrantRequestIds.runtimeSecurityGrantRequestId ?? preparation.runtimeSecurityGrantRequestId;
  validateGrantRequestId("Provider Access", providerAccessGrantRequestId);
  validateGrantRequestId("Runtime Security", runtimeSecurityGrantRequestId);
  if (preparation.providerAccessGrantRequestId !== null &&
      providerAccessGrantRequestId !== preparation.providerAccessGrantRequestId) {
    throw new TypeError("Provider Access consumed grant identity substitution rejected");
  }
  if (preparation.runtimeSecurityGrantRequestId !== null &&
      runtimeSecurityGrantRequestId !== preparation.runtimeSecurityGrantRequestId) {
    throw new TypeError("Runtime Security consumed grant identity substitution rejected");
  }
  return Object.freeze({
    ...preparation,
    ...(consumedGrantRequestIds.providerAccessConsumptionReceipt === undefined ? {} : { providerAccessConsumptionReceipt: consumedGrantRequestIds.providerAccessConsumptionReceipt }),
    providerAccessGrantRequestId,
    ...(consumedGrantRequestIds.runtimeSecurityConsumptionReceipt === undefined ? {} : { runtimeSecurityConsumptionReceipt: consumedGrantRequestIds.runtimeSecurityConsumptionReceipt }),
    runtimeSecurityGrantRequestId,
  });
};

export const retireContainedTurnDispatchPreparation = (
  preparation: ContainedTurnDispatchPreparation,
  nonce: string,
  consumedGrantRequestIds: ContainedTurnConsumedGrantRequestIds = {},
  consumptionEvidenceIds: ContainedTurnGrantConsumptionEvidenceIds = {},
): ContainedTurnDispatchPreparation => {
  if (preparation.kind === "claimed") {
    throw new TypeError("claimed dispatch preparation can never mint a cleanup permit");
  }
  if (consumedGrantRequestIds.providerAccessGrantRequestId !== undefined &&
      preparation.providerAccessGrantRequestId !== null &&
      preparation.providerAccessGrantRequestId !== consumedGrantRequestIds.providerAccessGrantRequestId) {
    throw new TypeError("Provider Access retired grant identity substitution rejected");
  }
  if (consumedGrantRequestIds.runtimeSecurityGrantRequestId !== undefined &&
      preparation.runtimeSecurityGrantRequestId !== null &&
      preparation.runtimeSecurityGrantRequestId !== consumedGrantRequestIds.runtimeSecurityGrantRequestId) {
    throw new TypeError("Runtime Security retired grant identity substitution rejected");
  }
  if (preparation.kind !== "active") {return preparation;}
  const bound = bindContainedTurnPreparationGrantRequests(preparation, consumedGrantRequestIds);
  const providerAccessConsumptionEvidenceId = consumptionEvidenceIds.providerAccessEvidenceId === undefined
    ? null
    : validateContainedTurnIdentity("evidence", consumptionEvidenceIds.providerAccessEvidenceId);
  const runtimeSecurityConsumptionEvidenceId = consumptionEvidenceIds.runtimeSecurityEvidenceId === undefined
    ? null
    : validateContainedTurnIdentity("evidence", consumptionEvidenceIds.runtimeSecurityEvidenceId);
  if (bound.runtimeSecurityGrantRequestId !== null && runtimeSecurityConsumptionEvidenceId !== null) {
    throw new TypeError("Runtime Security consumption cannot be both proved and indeterminate");
  }
  const cleanupEvidenceIds = Object.freeze([
    ...new Set([
      providerAccessConsumptionEvidenceId,
      runtimeSecurityConsumptionEvidenceId,
    ].filter((evidenceId): evidenceId is ContainedTurnEvidenceId => evidenceId !== null)),
  ]);
  return Object.freeze({
    ...bound,
    cleanupEvidenceIds,
    cleanupPermit: containedTurnCleanupPermit(bound, nonce),
    custodyReleased: false,
    kind: "cleanup_pending",
    providerAccessConsumptionEvidenceId,
    providerAccessSettled: bound.providerAccessGrantRequestId === null &&
      providerAccessConsumptionEvidenceId === null,
    runtimeSecurityConsumptionEvidenceId,
    runtimeSecuritySettled: bound.runtimeSecurityGrantRequestId === null &&
      runtimeSecurityConsumptionEvidenceId === null,
  });
};

const samePermit = (left: ContainedTurnCleanupPermit, right: ContainedTurnCleanupPermit): boolean =>
  left.permitId === right.permitId && left.permitDigest === right.permitDigest &&
  left.operationId === right.operationId && left.preparationToken === right.preparationToken &&
  left.attemptId === right.attemptId && left.custodyId === right.custodyId &&
  left.workspaceId === right.workspaceId &&
  left.preparedOperationRevision === right.preparedOperationRevision &&
  left.operationCutoffRevision === right.operationCutoffRevision;

type CleanupPendingPreparation = Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }>;

const advanceContainedTurnPreparationCleanup = (
  preparation: CleanupPendingPreparation,
  evidenceId: ContainedTurnEvidenceId | undefined,
  target: "custody" | "provider_access" | "runtime_security",
): CleanupPendingPreparation => ({
  ...preparation,
  cleanupEvidenceIds: evidenceId === undefined
    ? preparation.cleanupEvidenceIds
    : Object.freeze([...new Set([...preparation.cleanupEvidenceIds, evidenceId])]),
  custodyReleased: preparation.custodyReleased ||
    (evidenceId === undefined && target === "custody"),
  providerAccessSettled: preparation.providerAccessSettled ||
    (evidenceId === undefined && target === "provider_access"),
  runtimeSecuritySettled: preparation.runtimeSecuritySettled ||
    (evidenceId === undefined && target === "runtime_security"),
});

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
  if (preparation.cleanupEvidenceIds.length > CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT) {
    throw new TypeError("cleanup evidence limit exceeded");
  }
  const evidenceId = input.evidenceId === undefined
    ? undefined
    : validateContainedTurnIdentity("evidence", input.evidenceId);
  if (evidenceId !== undefined) {
    if (preparation.cleanupEvidenceIds.includes(evidenceId) ||
        preparation.cleanupEvidenceIds.length === CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT) {
      return preparation;
    }
  }
  const candidate = advanceContainedTurnPreparationCleanup(preparation, evidenceId, input.target);
  if (candidate.custodyReleased && candidate.providerAccessSettled && candidate.runtimeSecuritySettled) {
    return Object.freeze({
      attemptId: preparation.attemptId,
      cleanupEvidenceIds: candidate.cleanupEvidenceIds,
      cleanupPermitId: preparation.cleanupPermit.permitId,
      custodyId: preparation.custodyId,
      kind: "cleanup_closed",
      operationCutoffRevision: preparation.operationCutoffRevision,
      operationId: preparation.operationId,
      preparationToken: preparation.preparationToken,
      preparedOperationRevision: preparation.preparedOperationRevision,
      ...(preparation.providerAccessConsumptionReceipt === undefined ? {} : { providerAccessConsumptionReceipt: preparation.providerAccessConsumptionReceipt }),
      providerAccessConsumptionEvidenceId: preparation.providerAccessConsumptionEvidenceId,
      providerAccessGrantRequestId: preparation.providerAccessGrantRequestId,
      ...(preparation.runtimeSecurityConsumptionReceipt === undefined ? {} : { runtimeSecurityConsumptionReceipt: preparation.runtimeSecurityConsumptionReceipt }),
      runtimeSecurityConsumptionEvidenceId: preparation.runtimeSecurityConsumptionEvidenceId,
      runtimeSecurityGrantRequestId: preparation.runtimeSecurityGrantRequestId,
      workspaceId: preparation.workspaceId,
    });
  }
  return Object.freeze(candidate);
};
