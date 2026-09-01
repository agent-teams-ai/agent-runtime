import type {
  ContainedTurnIntent,
  ContainedTurnProvider,
  ContainedTurnProviderAccessSnapshot,
  ContainedTurnScope,
} from "../../../domain/contained-turn-authority.js";
import type { ContainedTurnCanonicalDigest } from "../../../domain/contained-turn-codecs.js";
import type {
  ContainedTurnConsumedGrantReceipt,
  ContainedTurnDispatchGrantSubject,
} from "../../../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnCleanupPermit } from "../../../domain/contained-turn-dispatch-preparation.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
  ContainedTurnProofId,
} from "../../../domain/contained-turn-identities.js";

export type SettleContainedTurnConsumedGrantInput = Readonly<{
  cleanupPermit: ContainedTurnCleanupPermit;
} & (
  | { readonly grantRequestId: string; readonly consumptionEvidenceId?: never }
  | { readonly consumptionEvidenceId: ContainedTurnEvidenceId; readonly grantRequestId?: never }
)>;

export type ResolveContainedTurnProviderAccessOutcome =
  | {
    readonly acceptanceResolutionDigest: ContainedTurnCanonicalDigest;
    readonly acceptanceProofId: ContainedTurnProofId;
    readonly kind: "resolved";
    readonly snapshot: ContainedTurnProviderAccessSnapshot;
  }
  | {
    readonly kind: "prevented";
    readonly preventionProofId: ContainedTurnProofId;
    readonly reason: "access_denied" | "credential_unavailable" | "route_unavailable";
  }
  | {
    readonly evidenceId: ContainedTurnEvidenceId;
    readonly kind: "indeterminate";
    readonly reason: "authority_unavailable" | "authority_unknown";
  };

export type RevalidateContainedTurnProviderAccessOutcome =
  | {
    readonly dispatchResolutionDigest: ContainedTurnCanonicalDigest;
    readonly dispatchProofId: ContainedTurnProofId;
    readonly kind: "current";
    readonly snapshot: ContainedTurnProviderAccessSnapshot;
  }
  | {
    readonly kind: "prevented";
    readonly preventionProofId: ContainedTurnProofId;
    readonly reason: "access_revoked" | "credential_changed" | "route_changed";
  }
  | {
    readonly evidenceId: ContainedTurnEvidenceId;
    readonly kind: "indeterminate";
    readonly reason: "authority_unavailable" | "authority_unknown";
  };

export interface ContainedTurnProviderAccessPort {
  consumeForDispatch(input: Readonly<{ grantRequestId: string; subject: ContainedTurnDispatchGrantSubject }>): Promise<
    | { readonly kind: "consumed"; readonly receipt: ContainedTurnConsumedGrantReceipt<"provider_access"> }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  settleConsumedGrant(input: SettleContainedTurnConsumedGrantInput): Promise<
    | { readonly kind: "settled" }
    | { readonly kind: "already_settled" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  resolveForAcceptance(input: Readonly<{
    intent: ContainedTurnIntent;
    provider: ContainedTurnProvider;
    scope: ContainedTurnScope;
  }>): Promise<ResolveContainedTurnProviderAccessOutcome>;
  revalidateForDispatch(input: Readonly<{
    acceptedSnapshot: ContainedTurnProviderAccessSnapshot;
    operationId: ContainedTurnOperationId;
    scope: ContainedTurnScope;
  }>): Promise<RevalidateContainedTurnProviderAccessOutcome>;
}

export interface ContainedTurnKernelSecurityPort {
  consumeForDispatch(input: Readonly<{ subject: ContainedTurnDispatchGrantSubject }>): Promise<
    | { readonly kind: "consumed"; readonly receipt: ContainedTurnConsumedGrantReceipt<"runtime_security"> }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  settleConsumedGrant(input: SettleContainedTurnConsumedGrantInput): Promise<
    | { readonly kind: "settled" }
    | { readonly kind: "already_settled" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  authorizeForAcceptance(input: Readonly<{
    intent: ContainedTurnIntent;
    provider: ContainedTurnProvider;
    scope: ContainedTurnScope;
  }>): Promise<
    | { readonly acceptanceProofId: ContainedTurnProofId; readonly authorityRevision: string; readonly containmentPolicyDigest: ContainedTurnCanonicalDigest; readonly decisionDigest: ContainedTurnCanonicalDigest; readonly kind: "allowed" }
    | { readonly kind: "denied" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  revalidateForDispatch(input: Readonly<{
    decisionDigest: ContainedTurnCanonicalDigest;
    operationId: ContainedTurnOperationId;
    securityAuthorityRevision: string;
    scope: ContainedTurnScope;
  }>): Promise<
    | { readonly dispatchDecisionDigest: ContainedTurnCanonicalDigest; readonly kind: "current"; readonly proofId: ContainedTurnProofId }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
}
