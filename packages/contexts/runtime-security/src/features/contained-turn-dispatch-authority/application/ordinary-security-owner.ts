import {captureOrdinarySecurityInput, captureOrdinarySecurityPolicy, captureOrdinarySecurityScope, createOrdinarySecretGuard, decideOrdinarySecurityConsume, newOrdinarySecurityRecord, ordinarySecurityDenied, ordinarySecurityKeyOf, ordinarySecurityRecordMatches, ordinarySecuritySettlementFor, type OrdinarySecurityAuthority, type OrdinarySecurityDigest, type OrdinarySecurityGrantRecord, type OrdinarySecurityInput, type OrdinarySecurityPolicy, type OrdinarySecurityScope, type OrdinarySecuritySettlement} from "../domain/ordinary-security-policy.js";
import {OrdinarySecurityCommitUnknownError, OrdinarySecurityStoreUnavailableError, type OrdinarySecurityGrantStore} from "./ports/ordinary-security-grant-store.js";
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
/** The composed owner additionally creates its own storage until the Host owns storage migration. */
export interface OrdinarySecurityOwner {
  migrate(): Promise<void>;
  resolveAndConsume(input: OrdinarySecurityInput): Promise<OrdinarySecurityGrant>;
  observe(input: OrdinarySecurityInput): Promise<OrdinarySecurityObservation | undefined>;
  registerSecrets(operationId: string, tokens: readonly string[]): boolean;
  dispose(): Promise<void>;
}
export type OrdinarySecurityGrantOwner = Omit<OrdinarySecurityOwner, "migrate">;
export interface OrdinarySecurityGrantOwnerOptions {
  readonly store: OrdinarySecurityGrantStore; readonly allowedScope: OrdinarySecurityScope; readonly policy: OrdinarySecurityPolicy;
  readonly now: () => number; readonly newId: () => string; readonly digest: OrdinarySecurityDigest;
}
const outcomeUncertain = (error: unknown): boolean => error instanceof OrdinarySecurityCommitUnknownError || error instanceof OrdinarySecurityStoreUnavailableError;
const observation = (record: OrdinarySecurityGrantRecord): OrdinarySecurityObservation => Object.freeze({authority: record.authority, settlement: record.settlement});

/** Runtime Security policy/consumption owner: in-memory secret guards, TTL and readback acceptance over a grant store. */
export const createOrdinarySecurityGrantOwner = (options: OrdinarySecurityGrantOwnerOptions): OrdinarySecurityGrantOwner => {
  const {store, now, newId, digest} = options;
  const scope = captureOrdinarySecurityScope(options.allowedScope); const policy = captureOrdinarySecurityPolicy(options.policy);
  const guards = new Map<string, ReturnType<typeof createOrdinarySecretGuard>>();
  const grants = new Map<string, OrdinarySecurityGrant>(); let disposed = false;
  const capture = (input: OrdinarySecurityInput): OrdinarySecurityInput => {if (disposed) {throw ordinarySecurityDenied();} return captureOrdinarySecurityInput(input, scope, policy);};
  const observe = async (input: OrdinarySecurityInput): Promise<OrdinarySecurityGrantRecord | undefined> => {
    const record = await store.observe(ordinarySecurityKeyOf(input));
    if (record !== undefined && !ordinarySecurityRecordMatches(record, input)) {throw ordinarySecurityDenied();}
    return record;
  };
  const settle = async (input: OrdinarySecurityInput, authority: OrdinarySecurityAuthority, disposition: OrdinarySecuritySettlement["disposition"]): Promise<OrdinarySecuritySettlement> => {
    if (disposed || !["claim_committed", "abandoned_without_claim"].includes(disposition)) {throw ordinarySecurityDenied();}
    const wanted = ordinarySecuritySettlementFor(authority, disposition, digest);
    let receipt: OrdinarySecuritySettlement;
    try {
      const result = await store.settle(ordinarySecurityKeyOf(input), wanted);
      if (result.kind !== "settled" && result.kind !== "already") {throw ordinarySecurityDenied();}
      receipt = result.settlement;
    } catch (error) {
      if (!outcomeUncertain(error)) {throw error;}
      const readback = await observe(input);
      if (readback?.settlement?.disposition !== disposition) {throw ordinarySecurityDenied();}
      receipt = readback.settlement;
    }
    guards.get(input.operationId)?.dispose(); guards.delete(input.operationId); grants.delete(input.operationId);
    return receipt;
  };
  return Object.freeze({
    async resolveAndConsume(request: OrdinarySecurityInput): Promise<OrdinarySecurityGrant> {
      const input = capture(request); let stored: OrdinarySecurityGrantRecord;
      try {
        const candidate = newOrdinarySecurityRecord(input, policy, {grantId: `ordinary-security-grant:${newId()}`, ownerReceiptId: `ordinary-security-consumption:${newId()}`}, now(), digest);
        stored = (await store.insertIfAbsent(candidate)).record;
      } catch (error) {
        if (!outcomeUncertain(error)) {throw error;}
        const readback = await observe(input); if (readback === undefined) {throw ordinarySecurityDenied();} stored = readback;
      }
      if (disposed || !ordinarySecurityRecordMatches(stored, input) || decideOrdinarySecurityConsume(stored, now()) === "deny") {throw ordinarySecurityDenied();}
      const previous = grants.get(input.operationId); if (previous !== undefined) {return previous;}
      const guard = createOrdinarySecretGuard(policy); guards.set(input.operationId, guard);
      const {authority} = stored;
      const grant: OrdinarySecurityGrant = Object.freeze({authority,
        admitOutput: (text: string) => !disposed && now() < authority.expiresAt && guard.admitOutput(text),
        admitArtifact: (bytes: Uint8Array) => !disposed && now() < authority.expiresAt && guard.admitArtifact(bytes),
        settle: (disposition: OrdinarySecuritySettlement["disposition"]) => settle(input, authority, disposition),
      });
      grants.set(input.operationId, grant); return grant;
    },
    async observe(request: OrdinarySecurityInput): Promise<OrdinarySecurityObservation | undefined> {const found = await observe(capture(request)); return found === undefined ? undefined : observation(found);},
    registerSecrets(operationId: string, tokens: readonly string[]): boolean {return !disposed && (guards.get(operationId)?.registerSecrets(tokens) ?? false);},
    async dispose(): Promise<void> {disposed = true; for (const guard of guards.values()) {guard.dispose();} guards.clear(); grants.clear();},
  });
};
