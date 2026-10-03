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
/** Typed so a store can tell a domain refusal from a failed or unknown database outcome. */
export class OrdinarySecurityDeniedError extends Error {constructor() {super("ORDINARY_SECURITY_DENIED"); this.name = "OrdinarySecurityDeniedError";}}
export const ordinarySecurityDenied = (): Error => new OrdinarySecurityDeniedError();
const exact = (value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> => snapshotExactDispatchRecord(value, keys) ?? (() => {throw ordinarySecurityDenied();})();
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[\x20-\x7e]{1,512}$/u.test(value)) {throw ordinarySecurityDenied();}
  return value;
};
export const captureOrdinarySecurityScope = (value: unknown): OrdinarySecurityScope => {
  const scope = exact(value, ["tenantId", "projectId"]);
  return Object.freeze({tenantId: identifier(scope.tenantId), projectId: identifier(scope.projectId)});
};
export const captureOrdinarySecurityPolicy = (input: OrdinarySecurityPolicy): OrdinarySecurityPolicy => {
  const value = exact(input, ["provider", "mode", "executionProfile", "effectClass", "capabilityManifestRevision", "ttlMs", "maxOutputBytes", "maxArtifactBytes"]);
  if (value.provider !== "codex" || value.mode !== "workspace-write" || value.executionProfile !== "user-session-v1" || value.effectClass !== "ordinary_user_session_effect" || value.capabilityManifestRevision !== "ordinary-codex-macos-arm64-0.153.4-v1" || typeof value.ttlMs !== "number" || !Number.isSafeInteger(value.ttlMs) || value.ttlMs < 10001 || value.ttlMs > 60000 || typeof value.maxOutputBytes !== "number" || !Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 2000000 || typeof value.maxArtifactBytes !== "number" || !Number.isSafeInteger(value.maxArtifactBytes) || value.maxArtifactBytes < 1 || value.maxArtifactBytes > 2000000) {throw ordinarySecurityDenied();}
  return Object.freeze({provider: value.provider, mode: value.mode, executionProfile: value.executionProfile, effectClass: value.effectClass, capabilityManifestRevision: value.capabilityManifestRevision, ttlMs: value.ttlMs, maxOutputBytes: value.maxOutputBytes, maxArtifactBytes: value.maxArtifactBytes});
};
export const captureOrdinarySecurityInput = (input: OrdinarySecurityInput, scope: OrdinarySecurityScope, policy: OrdinarySecurityPolicy): OrdinarySecurityInput => {
  const value = exact(input, ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision", "scope", "provider", "mode", "effectClass"]);
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
      const admitted: readonly string[] = values;
      tokens = Object.freeze([...new Set([...tokens, ...admitted])]); registered = true; return true;
    },
    admitOutput(text: string): boolean {
      if (closed || rejected || !registered || artifact !== undefined || typeof text !== "string" || text.includes("\u0000") || new TextDecoder().decode(new TextEncoder().encode(text)) !== text) {return false;}
      const combined = output + text;
      if (new TextEncoder().encode(combined).byteLength > policy.maxOutputBytes || forbidden(combined)) {rejected = true; return false;}
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

/** Canonical digest over any JSON value; supplied by the composition so the domain stays free of platform modules. */
export type OrdinarySecurityDigest = (value: unknown) => string;
export interface OrdinarySecurityKey extends OrdinarySecurityScope {readonly operationId: string}
export interface OrdinarySecurityGrantRecord {
  readonly input: OrdinarySecurityInput; readonly policy: OrdinarySecurityPolicy;
  readonly authority: OrdinarySecurityAuthority; readonly settlement: OrdinarySecuritySettlement | null;
}
export const ordinarySecurityKeyOf = (input: OrdinarySecurityInput): OrdinarySecurityKey => Object.freeze({tenantId: input.scope.tenantId, projectId: input.scope.projectId, operationId: input.operationId});
const bindingOf = (input: OrdinarySecurityBinding) => ({operationId: input.operationId, attemptId: input.attemptId, executionProfile: input.executionProfile, capabilityManifestRevision: input.capabilityManifestRevision});
interface OrdinarySecurityIds {readonly grantId: string; readonly ownerReceiptId: string}
const authorityFor = (input: OrdinarySecurityInput, policy: OrdinarySecurityPolicy, {grantId, ownerReceiptId}: OrdinarySecurityIds, expiresAt: number, digest: OrdinarySecurityDigest): OrdinarySecurityAuthority => Object.freeze({...bindingOf(input), owner: "runtime_security", grantId, ownerReceiptId, consumptionDigest: digest({input, policy, grantId, ownerReceiptId, expiresAt}), consumptionRevision: 1, authorityDigest: digest({input, policy}), expiresAt, scope: input.scope, provider: input.provider});
export const ordinarySecuritySettlementFor = (authority: OrdinarySecurityAuthority, disposition: OrdinarySecuritySettlement["disposition"], digest: OrdinarySecurityDigest): OrdinarySecuritySettlement => Object.freeze({...bindingOf(authority), kind: "security_grant_settled", grantId: authority.grantId, ownerReceiptId: authority.ownerReceiptId, settlementReceiptId: `ordinary-security-settlement:${digest({grantId: authority.grantId, ownerReceiptId: authority.ownerReceiptId, disposition})}`, disposition});
/** Candidate record for a first consume; `now` is explicit so the owner's clock is the only time source. */
export const newOrdinarySecurityRecord = (input: OrdinarySecurityInput, policy: OrdinarySecurityPolicy, ids: OrdinarySecurityIds, now: number, digest: OrdinarySecurityDigest): OrdinarySecurityGrantRecord =>
  Object.freeze({input, policy, authority: authorityFor(input, policy, ids, now + policy.ttlMs, digest), settlement: null});
/** The exact text a store persists and digests; key order is part of the stored contract. */
export const serializeOrdinarySecurityRecord = (record: OrdinarySecurityGrantRecord): string => JSON.stringify({input: record.input, policy: record.policy, authority: record.authority, settlement: record.settlement});
/** Rebuilds a record from stored text and rejects anything outside the allowed scope or policy, or with a forged authority or settlement. */
export const parseOrdinarySecurityRecord = (serialized: unknown, scope: OrdinarySecurityScope, policy: OrdinarySecurityPolicy, digest: OrdinarySecurityDigest): OrdinarySecurityGrantRecord => {
  if (typeof serialized !== "string" || serialized.length > 65536) {throw ordinarySecurityDenied();}
  let parsed: unknown;
  try {parsed = JSON.parse(serialized);} catch {throw ordinarySecurityDenied();}
  const data = snapshotExactDispatchRecord(parsed, ["input", "policy", "authority", "settlement"]);
  if (data === undefined) {throw ordinarySecurityDenied();}
  const capturedPolicy = captureOrdinarySecurityPolicy(data.policy as OrdinarySecurityPolicy);
  const capturedInput = captureOrdinarySecurityInput(data.input as OrdinarySecurityInput, scope, policy);
  if (JSON.stringify(capturedPolicy) !== JSON.stringify(policy)) {throw ordinarySecurityDenied();}
  const authority = snapshotExactDispatchRecord(data.authority, ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision", "owner", "grantId", "ownerReceiptId", "consumptionDigest", "consumptionRevision", "authorityDigest", "expiresAt", "scope", "provider"]);
  if (authority === undefined || typeof authority.grantId !== "string" || !/^ordinary-security-grant:[a-f0-9-]{36}$/u.test(authority.grantId) || typeof authority.ownerReceiptId !== "string" || !/^ordinary-security-consumption:[a-f0-9-]{36}$/u.test(authority.ownerReceiptId) || typeof authority.expiresAt !== "number" || !Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= 0) {throw ordinarySecurityDenied();}
  const checked = authorityFor(capturedInput, capturedPolicy, {grantId: authority.grantId, ownerReceiptId: authority.ownerReceiptId}, authority.expiresAt, digest);
  if (JSON.stringify(data.authority) !== JSON.stringify(checked)) {throw ordinarySecurityDenied();}
  let settlement: OrdinarySecuritySettlement | null = null;
  if (data.settlement !== null) {
    const fact = snapshotExactDispatchRecord(data.settlement, ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision", "kind", "grantId", "ownerReceiptId", "settlementReceiptId", "disposition"]);
    if (fact === undefined || (fact.disposition !== "claim_committed" && fact.disposition !== "abandoned_without_claim")) {throw ordinarySecurityDenied();}
    settlement = ordinarySecuritySettlementFor(checked, fact.disposition, digest);
    if (JSON.stringify(data.settlement) !== JSON.stringify(settlement)) {throw ordinarySecurityDenied();}
  }
  return Object.freeze({input: capturedInput, policy: capturedPolicy, authority: checked, settlement});
};
/** A stored record answers a request only when it was consumed for exactly that input. */
export const ordinarySecurityRecordMatches = (record: OrdinarySecurityGrantRecord, input: OrdinarySecurityInput): boolean => JSON.stringify(record.input) === JSON.stringify(input);
/** A repeat consume returns the same grant until it is settled or expired. */
export const decideOrdinarySecurityConsume = (record: OrdinarySecurityGrantRecord, now: number): "grant" | "deny" => record.settlement !== null || record.authority.expiresAt <= now ? "deny" : "grant";
export type OrdinarySecuritySettleDecision = {readonly kind: "settle" | "already"; readonly settlement: OrdinarySecuritySettlement} | {readonly kind: "conflict"};
/** Settle is idempotent for the same disposition and a conflict for any other, or for a settlement not derived from this record's authority. */
export const decideOrdinarySecuritySettle = (record: OrdinarySecurityGrantRecord, settlement: OrdinarySecuritySettlement, digest: OrdinarySecurityDigest): OrdinarySecuritySettleDecision => {
  if (JSON.stringify(ordinarySecuritySettlementFor(record.authority, settlement.disposition, digest)) !== JSON.stringify(settlement)) {return {kind: "conflict"};}
  if (record.settlement === null) {return {kind: "settle", settlement};}
  return record.settlement.disposition === settlement.disposition ? {kind: "already", settlement: record.settlement} : {kind: "conflict"};
};
