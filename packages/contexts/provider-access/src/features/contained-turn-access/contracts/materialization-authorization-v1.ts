export const CREDENTIAL_MATERIALIZATION_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_MATERIALIZATION_PURPOSE = "contained-turn.credential-materialization-authorization/v1" as const;

export interface AuthorizeCredentialMaterializationInput {
  readonly accessRef: string;
  readonly authorizationRequestId: string;
  readonly availability: "available" | "unavailable";
  readonly bindingRevision: number;
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly purpose: typeof CREDENTIAL_MATERIALIZATION_PURPOSE;
  readonly requestDigest: string;
  readonly revocation: "active" | "revoked";
  readonly schemaVersion: typeof CREDENTIAL_MATERIALIZATION_SCHEMA_VERSION;
  readonly scopeDigest: string;
  readonly tenantId: string;
}

export type CredentialMaterializationRejectionReason =
  | "access_changed" | "access_not_available" | "account_changed" | "availability_changed"
  | "binding_revision_changed" | "credential_binding_changed" | "credential_generation_changed"
  | "revoked" | "route_changed";

/** Final Provider Access decision. It conveys no Host lifecycle or physical-cleanup fact. */
export interface CredentialMaterializationAuthorizationReceipt extends AuthorizeCredentialMaterializationInput {
  readonly decision: "authorized" | "rejected";
  readonly rejectionReason: CredentialMaterializationRejectionReason | null;
}

export type CredentialMaterializationUnsupportedReason = "unsupported_provider" | "unsupported_version";

export type AuthorizeCredentialMaterializationOutcome =
  | { readonly kind: "authorized"; readonly receipt: CredentialMaterializationAuthorizationReceipt }
  | { readonly kind: "conflict"; readonly reason: "authorization_request_digest_conflict" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "observed"; readonly receipt: CredentialMaterializationAuthorizationReceipt }
  | { readonly kind: "rejected"; readonly reason: CredentialMaterializationRejectionReason; readonly receipt: CredentialMaterializationAuthorizationReceipt }
  | { readonly kind: "unsupported"; readonly reason: CredentialMaterializationUnsupportedReason };

export interface ObserveCredentialMaterializationAuthorizationInput {
  readonly authorizationRequestId: string;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly requestDigest: string;
  readonly scopeDigest: string;
  readonly tenantId: string;
}

export type ObserveCredentialMaterializationAuthorizationOutcome =
  | { readonly kind: "indeterminate" }
  | { readonly kind: "observed"; readonly receipt: CredentialMaterializationAuthorizationReceipt }
  | { readonly kind: "rejected"; readonly reason: CredentialMaterializationRejectionReason; readonly receipt: CredentialMaterializationAuthorizationReceipt }
  | { readonly kind: "unsupported"; readonly reason: "unsupported_provider" };

/**
 * One-shot Provider Access checkpoint immediately before credential materialization.
 * An authorized receipt is non-secret authorization evidence for a downstream Host;
 * only `authorize()` returning `authorized` grants fresh authority. Replayed and observed
 * historical receipts are facts and do not describe installation, execution, custody,
 * reconciliation, cleanup, or fresh Host start authority.
 */
export interface CredentialMaterializationAuthorizationV1 {
  authorize(input: AuthorizeCredentialMaterializationInput): Promise<AuthorizeCredentialMaterializationOutcome>;
  observe(input: ObserveCredentialMaterializationAuthorizationInput): Promise<ObserveCredentialMaterializationAuthorizationOutcome>;
}
