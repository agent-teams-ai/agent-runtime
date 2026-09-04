import type { AuthorizationRecord } from "../../../domain/materialization-authorization.js";

/** Provider Access facts required for the final pre-materialization checkpoint. */
export interface MaterializationAuthorizationBinding {
  readonly accessRef: string;
  readonly availability: "available" | "unavailable";
  readonly bindingRevision: number;
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revocation: "active" | "revoked";
  readonly scopeDigest: string;
  readonly tenantId: string;
}

export interface MaterializationAuthorizationTransaction {
  findAuthorizationRequest(): Promise<AuthorizationRecord | undefined>;
  findBinding(): Promise<MaterializationAuthorizationBinding | undefined>;
  saveAuthorization(record: AuthorizationRecord): Promise<void>;
}

export interface MaterializationAuthorizationRepository {
  /** Request identities are global; public callers must be owner-checked before digest comparison. */
  observeAuthorizationRequest(authorizationRequestId: string): Promise<AuthorizationRecord | undefined>;
  transact<T>(selector: {
    readonly authorizationRequestId: string;
    readonly projectId: string;
    readonly provider: "claude" | "codex";
    readonly scopeDigest: string;
    readonly tenantId: string;
  }, work: (transaction: MaterializationAuthorizationTransaction) => Promise<T>): Promise<T>;
}
