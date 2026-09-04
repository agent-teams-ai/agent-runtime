import type { AuthorizationRecord } from "../../../domain/materialization-authorization.js";

export interface MaterializationAuthorizationRequestSelector {
  readonly authorizationRequestId: string;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly scopeDigest: string;
  readonly tenantId: string;
}

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
  /** Owner scope is part of the repository key; adapters must not perform a global lookup followed by an owner check. */
  observeAuthorizationRequest(selector: MaterializationAuthorizationRequestSelector): Promise<AuthorizationRecord | undefined>;
  transact<T>(selector: MaterializationAuthorizationRequestSelector,
    work: (transaction: MaterializationAuthorizationTransaction) => Promise<T>): Promise<T>;
}
