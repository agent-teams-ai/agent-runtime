export interface EgressPolicyTimeSnapshotV1 {
  readonly contractVersion: "contained-turn-egress-policy/v1";
  readonly policyId: string; readonly policyRevision: string; readonly policyGeneration: string;
  readonly keyId: string; readonly keyGeneration: string; readonly signerRevision: string;
  readonly timeAuthorityId: string; readonly timeGeneration: string; readonly observedAt: number;
  readonly expiresAt: number; readonly maxRequestBytes: number; readonly maxResponseBytes: number;
  readonly maxDeadlineMs: number;
}
