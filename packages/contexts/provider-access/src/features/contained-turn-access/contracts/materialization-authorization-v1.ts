export const CREDENTIAL_MATERIALIZATION_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_MATERIALIZATION_PURPOSE = "contained-turn.credential-materialization/v1" as const;

export type CredentialMaterializationState =
  | "eligible" | "claimed" | "installing" | "materialized" | "cleanup_pending" | "destroyed"
  | "rejected" | "expired" | "reconcile_required" | "quarantined";

/** Exact non-secret request. This DTO is evidence only and is never installation authority. */
export interface AuthorizeCredentialMaterializationInput {
  readonly accessRef: string;
  readonly attemptId: string;
  readonly availability: "available";
  readonly bindingRevision: number;
  readonly credentialBindingDigest: string;
  readonly credentialGeneration: number;
  readonly custodyId: string;
  readonly executionGenerationId: string;
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly materializationRequestId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly purpose: typeof CREDENTIAL_MATERIALIZATION_PURPOSE;
  readonly requestDigest: string;
  readonly revocation: "active";
  readonly schemaVersion: typeof CREDENTIAL_MATERIALIZATION_SCHEMA_VERSION;
  readonly scopeDigest: string;
  readonly settledConsumptionDigest: string;
  readonly tenantId: string;
}

export interface CredentialMaterializationReceipt extends AuthorizeCredentialMaterializationInput {
  readonly observedAtControlTime: number;
  readonly receiptDigest: string;
  readonly state: CredentialMaterializationState;
  readonly stateRevision: number;
}

export type CredentialMaterializationRejectionReason =
  | "access_changed" | "account_changed" | "already_used_by_another_request" | "availability_changed"
  | "binding_changed" | "binding_revision_changed" | "consumption_not_claim_committed" | "credential_changed" | "credential_rotated"
  | "expired" | "operation_mismatch" | "provider_mismatch" | "revoked" | "route_changed"
  | "scope_mismatch" | "settled_consumption_not_found";

export type AuthorizeCredentialMaterializationOutcome =
  | { readonly kind: "claimed"; readonly receipt: CredentialMaterializationReceipt }
  | { readonly kind: "conflict"; readonly reason: "materialization_request_digest_conflict" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "observed"; readonly receipt: CredentialMaterializationReceipt }
  | { readonly kind: "rejected"; readonly reason: CredentialMaterializationRejectionReason; readonly receipt: CredentialMaterializationReceipt };

export interface ObserveCredentialMaterializationInput {
  readonly materializationRequestId: string;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly requestDigest: string;
  readonly scopeDigest: string;
  readonly tenantId: string;
}
export type ObserveCredentialMaterializationOutcome =
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "observed"; readonly receipt: CredentialMaterializationReceipt };

export type CredentialMaterializationTransition =
  | "installation_may_have_begun" | "materialized" | "cleanup_pending" | "reconcile_required";
export interface TransitionCredentialMaterializationInput extends ObserveCredentialMaterializationInput {
  readonly transition: CredentialMaterializationTransition;
}
export type TransitionCredentialMaterializationOutcome =
  | { readonly kind: "conflict"; readonly reason: "invalid_state_transition" | "materialization_request_digest_conflict" }
  | { readonly kind: "indeterminate" } | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "observed"; readonly receipt: CredentialMaterializationReceipt }
  | { readonly kind: "transitioned"; readonly receipt: CredentialMaterializationReceipt };

export interface AcknowledgeCredentialCleanupInput extends ObserveCredentialMaterializationInput {
  readonly outcome: "destroyed" | "quarantined";
}
export type AcknowledgeCredentialCleanupOutcome = TransitionCredentialMaterializationOutcome;

/**
 * Provider Access-owned pre-broker checkpoint. Receipts are immutable observations,
 * not serializable installation capabilities. Every operation is at-most-once.
 */
export interface CredentialMaterializationAuthorizationV1 {
  acknowledgeCleanup(input: AcknowledgeCredentialCleanupInput): Promise<AcknowledgeCredentialCleanupOutcome>;
  authorize(input: AuthorizeCredentialMaterializationInput): Promise<AuthorizeCredentialMaterializationOutcome>;
  observe(input: ObserveCredentialMaterializationInput): Promise<ObserveCredentialMaterializationOutcome>;
  transition(input: TransitionCredentialMaterializationInput): Promise<TransitionCredentialMaterializationOutcome>;
}
