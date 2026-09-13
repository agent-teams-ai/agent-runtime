export interface OrdinaryPaBinding {
  readonly operationId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly executionProfile: 'user-session-v1';
  readonly effectClass: 'ordinary_user_session_effect';
  readonly capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1';
}
export class OrdinaryPaUnavailable extends Error {
  readonly code = 'ORDINARY_PA_UNAVAILABLE';
  constructor() { super('ORDINARY_PA_UNAVAILABLE'); }
}
export interface OrdinaryPaAuthority extends OrdinaryPaBinding {
  readonly owner: 'provider_access';
  readonly provider: 'codex';
  readonly grantId: string;
  readonly ownerReceiptId: string;
  readonly consumptionDigest: string;
  readonly consumptionRevision: 1;
  readonly authorityDigest: string;
  readonly expiresAt: number;
  readonly scope: { readonly tenantId: string; readonly projectId: string };
}
export interface OrdinaryPaSnapshot {
  readonly authority: OrdinaryPaAuthority;
  readonly generation: number;
  readonly accountId: string;
  readonly materializationId: string;
  readonly retiredAt: string | null;
  readonly disposition: 'claim_committed' | 'abandoned_without_claim' | null;
  readonly settlementReceiptId: string | null;
  readonly requestsStarted: number;
  readonly requestsCompleted: number;
  readonly requestsFailed: number;
}
export interface OrdinaryPaMaterial {
  readonly brokerEndpoint: string;
  readonly materializationId: string;
  readonly generation: number;
  readonly environment: Readonly<{ AR_ORDINARY_BROKER_CAPABILITY: string }>;
}
export interface OrdinaryPaRetirement { readonly materializationId: string; readonly generation: number; readonly retiredAt: string; }
export interface OrdinaryPaSettlement {
  readonly grantId: string;
  readonly ownerReceiptId: string;
  readonly settlementReceiptId: string;
  readonly disposition: 'claim_committed' | 'abandoned_without_claim';
}
export interface OrdinaryPaGrant {
  readonly grantId: string;
  readonly expiresAt: number;
  readonly authority: OrdinaryPaAuthority;
  materialize(): Promise<OrdinaryPaMaterial>;
  retire(): Promise<OrdinaryPaRetirement>;
  settle(disposition: 'claim_committed' | 'abandoned_without_claim'): Promise<OrdinaryPaSettlement>;
  /** Check the whole cumulative output or whole canonical artifact, never an isolated chunk. */
  admitCanonicalText(text: string): boolean;
  /** Fatal UTF-8 decode; checks the complete original artifact bytes. */
  admitArtifactBytes(bytes: Uint8Array): boolean;
}
