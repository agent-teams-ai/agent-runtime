import type {OrdinarySecurityAuthority, OrdinarySecurityInput, OrdinarySecuritySettlement} from "../domain/ordinary-security-policy.js";
export interface OrdinarySecurityGrant {
  readonly authority: OrdinarySecurityAuthority;
  admitOutput(text: string): boolean;
  admitArtifact(bytes: Uint8Array): boolean;
  settle(disposition: OrdinarySecuritySettlement["disposition"]): Promise<OrdinarySecuritySettlement>;
}
export interface OrdinarySecurityObservation {
  readonly authority: OrdinarySecurityAuthority;
  readonly settlement: OrdinarySecuritySettlement | null;
}
export interface OrdinarySecurityOwner {
  migrate(): Promise<void>;
  resolveAndConsume(input: OrdinarySecurityInput): Promise<OrdinarySecurityGrant>;
  observe(input: OrdinarySecurityInput): Promise<OrdinarySecurityObservation | undefined>;
  registerSecrets(operationId: string, tokens: readonly string[]): boolean;
  dispose(): Promise<void>;
}
