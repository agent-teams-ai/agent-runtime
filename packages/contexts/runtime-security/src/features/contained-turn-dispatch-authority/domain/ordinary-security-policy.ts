import {snapshotExactDispatchRecord} from "./dispatch-exact-record.js";
export interface OrdinarySecurityScope {readonly tenantId: string; readonly projectId: string}
export interface OrdinarySecurityBinding {
  readonly operationId: string; readonly attemptId: string;
  readonly executionProfile: "user-session-v1";
  readonly capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1";
}
export interface OrdinarySecurityInput extends OrdinarySecurityBinding {
  readonly scope: OrdinarySecurityScope; readonly provider: "codex";
  readonly mode: "workspace-write"; readonly effectClass: "ordinary_user_session_effect";
}
export interface OrdinarySecurityPolicy {
  readonly provider: "codex"; readonly mode: "workspace-write";
  readonly executionProfile: "user-session-v1"; readonly effectClass: "ordinary_user_session_effect";
  readonly capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1";
  readonly ttlMs: number; readonly maxOutputBytes: number; readonly maxArtifactBytes: number;
}
export interface OrdinarySecurityAuthority extends OrdinarySecurityBinding {
  readonly owner: "runtime_security"; readonly grantId: string; readonly ownerReceiptId: string;
  readonly consumptionDigest: string; readonly consumptionRevision: 1; readonly authorityDigest: string;
  readonly expiresAt: number; readonly scope: OrdinarySecurityScope; readonly provider: "codex";
}
export interface OrdinarySecuritySettlement extends OrdinarySecurityBinding {
  readonly kind: "security_grant_settled"; readonly grantId: string; readonly ownerReceiptId: string;
  readonly settlementReceiptId: string; readonly disposition: "claim_committed" | "abandoned_without_claim";
}
export const ordinarySecurityDenied = (): Error => new Error("ORDINARY_SECURITY_DENIED");
const exact = (value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> => snapshotExactDispatchRecord(value, keys) ?? (() => {throw ordinarySecurityDenied();})();
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[\x20-\x7e]{1,512}$/u.test(value)) {throw ordinarySecurityDenied();}
  return value;
};
export const captureOrdinarySecurityScope = (value: unknown): OrdinarySecurityScope => {
  const scope = exact(value, ["tenantId", "projectId"]);
  return Object.freeze({tenantId: identifier(scope.tenantId), projectId: identifier(scope.projectId)});
};
export const captureOrdinarySecurityPolicy = (value: OrdinarySecurityPolicy): OrdinarySecurityPolicy => {
  exact(value, ["provider", "mode", "executionProfile", "effectClass", "capabilityManifestRevision", "ttlMs", "maxOutputBytes", "maxArtifactBytes"]);
  if (value.provider !== "codex" || value.mode !== "workspace-write" || value.executionProfile !== "user-session-v1" || value.effectClass !== "ordinary_user_session_effect" || value.capabilityManifestRevision !== "ordinary-codex-macos-arm64-0.153.4-v1" || !Number.isSafeInteger(value.ttlMs) || value.ttlMs < 10001 || value.ttlMs > 60000 || !Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 2000000 || !Number.isSafeInteger(value.maxArtifactBytes) || value.maxArtifactBytes < 1 || value.maxArtifactBytes > 2000000) {throw ordinarySecurityDenied();}
  return Object.freeze({provider: value.provider, mode: value.mode, executionProfile: value.executionProfile, effectClass: value.effectClass, capabilityManifestRevision: value.capabilityManifestRevision, ttlMs: value.ttlMs, maxOutputBytes: value.maxOutputBytes, maxArtifactBytes: value.maxArtifactBytes});
};
export const captureOrdinarySecurityInput = (value: OrdinarySecurityInput, scope: OrdinarySecurityScope, policy: OrdinarySecurityPolicy): OrdinarySecurityInput => {
  exact(value, ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision", "scope", "provider", "mode", "effectClass"]);
  const captured = captureOrdinarySecurityScope(value.scope);
  if (captured.tenantId !== scope.tenantId || captured.projectId !== scope.projectId || value.provider !== policy.provider || value.mode !== policy.mode || value.executionProfile !== policy.executionProfile || value.effectClass !== policy.effectClass || value.capabilityManifestRevision !== policy.capabilityManifestRevision) {throw ordinarySecurityDenied();}
  return Object.freeze({operationId: identifier(value.operationId), attemptId: identifier(value.attemptId), executionProfile: value.executionProfile, capabilityManifestRevision: value.capabilityManifestRevision, scope: captured, provider: value.provider, mode: value.mode, effectClass: value.effectClass});
};
/** Secret admission is operation-local and ephemeral; registration is mandatory before publication. */
export const createOrdinarySecretGuard = (policy: OrdinarySecurityPolicy) => {
  let tokens: readonly string[] = []; let registered = false; let closed = false; let rejected = false;
  let output = ""; let artifact: string | undefined;
  const forbidden = (text: string): boolean => tokens.some(token => text.includes(token));
  return Object.freeze({
    registerSecrets(values: readonly string[]): boolean {
      if (closed || rejected || output.length !== 0 || artifact !== undefined || !Array.isArray(values) || values.length === 0 || values.length > 32 || values.some(token => typeof token !== "string" || token.length === 0 || token.length > 131072 || token.includes("\u0000"))) {return false;}
      tokens = Object.freeze([...new Set([...tokens, ...values])]); registered = true; return true;
    },
    admitOutput(text: string): boolean {
      if (closed || rejected || !registered || artifact !== undefined || typeof text !== "string" || text.includes("\u0000") || new TextDecoder().decode(new TextEncoder().encode(text)) !== text) {return false;}
      const combined = output + text;
      if (new TextEncoder().encode(combined).byteLength > policy.maxOutputBytes || forbidden(combined) || (artifact !== undefined && (forbidden(combined + artifact) || forbidden(artifact + combined)))) {rejected = true; return false;}
      output = combined; return true;
    },
    admitArtifact(bytes: Uint8Array): boolean {
      if (closed || rejected || !registered || bytes.byteLength > policy.maxArtifactBytes) {return false;}
      let text: string;
      try {text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {rejected = true; return false;}
      if ((artifact !== undefined && artifact !== text) || forbidden(text) || forbidden(output + text) || forbidden(text + output)) {rejected = true; return false;}
      artifact = text; return true;
    },
    dispose(): void {closed = true; tokens = []; output = ""; artifact = undefined;},
  });
};
