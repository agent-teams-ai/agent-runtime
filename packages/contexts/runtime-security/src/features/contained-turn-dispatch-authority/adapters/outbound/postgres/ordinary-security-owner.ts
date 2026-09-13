import {createHash, randomUUID} from "node:crypto";
import type {OrdinarySecurityOwner, OrdinarySecurityGrant, OrdinarySecurityObservation} from "../../../application/ordinary-security-owner.js";
import {captureOrdinarySecurityInput, captureOrdinarySecurityPolicy, captureOrdinarySecurityScope, createOrdinarySecretGuard, ordinarySecurityDenied, type OrdinarySecurityAuthority, type OrdinarySecurityInput, type OrdinarySecurityPolicy, type OrdinarySecurityScope, type OrdinarySecuritySettlement} from "../../../domain/ordinary-security-policy.js";
import {snapshotExactDispatchRecord} from "../../../domain/dispatch-exact-record.js";
import type {DispatchPgPool, DispatchPgTransaction} from "./transaction.js";
import {createOrdinarySecurityTransactions} from "./ordinary-security-transactions.js";
export interface OrdinarySecurityOwnerOptions {readonly pool: DispatchPgPool; readonly allowedScope: OrdinarySecurityScope; readonly policy: OrdinarySecurityPolicy}
interface Stored extends OrdinarySecurityObservation {readonly input: OrdinarySecurityInput; readonly policy: OrdinarySecurityPolicy}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (input: OrdinarySecurityInput) => ({operationId: input.operationId, attemptId: input.attemptId, executionProfile: input.executionProfile, capabilityManifestRevision: input.capabilityManifestRevision});
const authorityFor = (input: OrdinarySecurityInput, policy: OrdinarySecurityPolicy, grantId: string, ownerReceiptId: string, expiresAt: number): OrdinarySecurityAuthority => Object.freeze({...binding(input), owner: "runtime_security", grantId, ownerReceiptId, consumptionDigest: hash({input, policy, grantId, ownerReceiptId, expiresAt}), consumptionRevision: 1, authorityDigest: hash({input, policy}), expiresAt, scope: input.scope, provider: input.provider});
const settlementFor = (authority: OrdinarySecurityAuthority, disposition: OrdinarySecuritySettlement["disposition"]): OrdinarySecuritySettlement => Object.freeze({operationId: authority.operationId, attemptId: authority.attemptId, executionProfile: authority.executionProfile, capabilityManifestRevision: authority.capabilityManifestRevision, kind: "security_grant_settled", grantId: authority.grantId, ownerReceiptId: authority.ownerReceiptId, settlementReceiptId: `ordinary-security-settlement:${hash({grantId: authority.grantId, ownerReceiptId: authority.ownerReceiptId, disposition})}`, disposition});
const table = "runtime_security_ordinary_grants_v1";
const values = (input: OrdinarySecurityInput): unknown[] => [input.scope.tenantId, input.scope.projectId, input.operationId];
const decode = (serialized: unknown, expected: OrdinarySecurityInput, policy: OrdinarySecurityPolicy): Stored => {
  if (typeof serialized !== "string" || serialized.length > 65536) {throw ordinarySecurityDenied();}
  const data = snapshotExactDispatchRecord(JSON.parse(serialized), ["input", "policy", "authority", "settlement"]);
  if (data === undefined) {throw ordinarySecurityDenied();}
  const capturedPolicy = captureOrdinarySecurityPolicy(data.policy as OrdinarySecurityPolicy);
  const capturedInput = captureOrdinarySecurityInput(data.input as OrdinarySecurityInput, expected.scope, policy);
  if (JSON.stringify(capturedInput) !== JSON.stringify(expected) || JSON.stringify(capturedPolicy) !== JSON.stringify(policy)) {throw ordinarySecurityDenied();}
  const authority = snapshotExactDispatchRecord(data.authority, ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision", "owner", "grantId", "ownerReceiptId", "consumptionDigest", "consumptionRevision", "authorityDigest", "expiresAt", "scope", "provider"]);
  if (authority === undefined || typeof authority.grantId !== "string" || !/^ordinary-security-grant:[a-f0-9-]{36}$/u.test(authority.grantId) || typeof authority.ownerReceiptId !== "string" || !/^ordinary-security-consumption:[a-f0-9-]{36}$/u.test(authority.ownerReceiptId) || typeof authority.expiresAt !== "number" || !Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= 0) {throw ordinarySecurityDenied();}
  const checked = authorityFor(capturedInput, capturedPolicy, authority.grantId, authority.ownerReceiptId, authority.expiresAt);
  if (JSON.stringify(data.authority) !== JSON.stringify(checked)) {throw ordinarySecurityDenied();}
  let settlement: OrdinarySecuritySettlement | null = null;
  if (data.settlement !== null) {
    const fact = snapshotExactDispatchRecord(data.settlement, ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision", "kind", "grantId", "ownerReceiptId", "settlementReceiptId", "disposition"]);
    if (fact === undefined || (fact.disposition !== "claim_committed" && fact.disposition !== "abandoned_without_claim")) {throw ordinarySecurityDenied();}
    settlement = settlementFor(checked, fact.disposition);
    if (JSON.stringify(data.settlement) !== JSON.stringify(settlement)) {throw ordinarySecurityDenied();}
  }
  return Object.freeze({input: capturedInput, policy: capturedPolicy, authority: checked, settlement});
};

/** Genuine Runtime Security policy/consumption owner, additive to the V1 containment authority. */
export const createPostgresOrdinarySecurityOwner = (options: OrdinarySecurityOwnerOptions): OrdinarySecurityOwner => {
  const scope = captureOrdinarySecurityScope(options.allowedScope); const policy = captureOrdinarySecurityPolicy(options.policy);
  const transactions = createOrdinarySecurityTransactions(options.pool);
  const guards = new Map<string, ReturnType<typeof createOrdinarySecretGuard>>();
  const grants = new Map<string, OrdinarySecurityGrant>(); let disposed = false;
  const capture = (input: OrdinarySecurityInput): OrdinarySecurityInput => {if (disposed) {throw ordinarySecurityDenied();} return captureOrdinarySecurityInput(input, scope, policy);};
  const read = async (tx: DispatchPgTransaction, input: OrdinarySecurityInput, locked = false): Promise<Stored | undefined> => {
    const row = (await tx.query(`SELECT state, state_digest FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND operation_id=$3${locked ? " FOR UPDATE" : ""}`, values(input))).rows[0];
    if (row === undefined) {return undefined;}
    if (typeof row.state !== "string" || row.state_digest !== hash(row.state)) {throw ordinarySecurityDenied();}
    return decode(row.state, input, policy);
  };
  const observe = async (input: OrdinarySecurityInput): Promise<Stored | undefined> => transactions.run(tx => read(tx, input));
  const settle = async (input: OrdinarySecurityInput, disposition: OrdinarySecuritySettlement["disposition"]): Promise<OrdinarySecuritySettlement> => {
    if (disposed || (disposition !== "claim_committed" && disposition !== "abandoned_without_claim")) {throw ordinarySecurityDenied();}
    let receipt: OrdinarySecuritySettlement;
    try {receipt = await transactions.run(async tx => {
      const prior = await read(tx, input, true); if (prior === undefined) {throw ordinarySecurityDenied();}
      if (prior.settlement !== null) {if (prior.settlement.disposition !== disposition) {throw ordinarySecurityDenied();} return prior.settlement;}
      const settlement = settlementFor(prior.authority, disposition);
      const state = JSON.stringify({...prior, settlement});
      const result = await tx.query(`UPDATE ${table} SET state=$4,state_digest=$5 WHERE tenant_id=$1 AND project_id=$2 AND operation_id=$3`, [...values(input), state, hash(state)]);
      if (result.rowCount !== 1) {throw ordinarySecurityDenied();} return settlement;
    });} catch {
      const readback = await observe(input);
      if (readback?.settlement?.disposition !== disposition) {throw ordinarySecurityDenied();}
      receipt = readback.settlement;
    }
    guards.get(input.operationId)?.dispose(); guards.delete(input.operationId); grants.delete(input.operationId);
    return receipt;
  };
  return Object.freeze({
    async migrate() {if (disposed) {throw ordinarySecurityDenied();} await transactions.run(async tx => {await tx.query(`CREATE TABLE IF NOT EXISTS ${table} (tenant_id text NOT NULL,project_id text NOT NULL,operation_id text NOT NULL,state text NOT NULL,state_digest text NOT NULL,PRIMARY KEY(tenant_id,project_id,operation_id))`);});},
    async resolveAndConsume(request: OrdinarySecurityInput): Promise<OrdinarySecurityGrant> {
      const input = capture(request); let stored: Stored;
      try {stored = await transactions.run(async tx => {
        const authority = authorityFor(input, policy, `ordinary-security-grant:${randomUUID()}`, `ordinary-security-consumption:${randomUUID()}`, Date.now() + policy.ttlMs);
        const state = JSON.stringify({input, policy, authority, settlement: null});
        await tx.query(`INSERT INTO ${table}(tenant_id,project_id,operation_id,state,state_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...values(input), state, hash(state)]);
        const confirmed = await read(tx, input); if (confirmed === undefined) {throw ordinarySecurityDenied();} return confirmed;
      });} catch {
        const readback = await observe(input); if (readback === undefined) {throw ordinarySecurityDenied();} stored = readback;
      }
      if (disposed || stored.settlement !== null || stored.authority.expiresAt <= Date.now()) {throw ordinarySecurityDenied();}
      const previous = grants.get(input.operationId); if (previous !== undefined) {return previous;}
      const guard = createOrdinarySecretGuard(policy); guards.set(input.operationId, guard);
      const grant: OrdinarySecurityGrant = Object.freeze({authority: stored.authority,
        admitOutput: (text: string) => !disposed && Date.now() < stored.authority.expiresAt && guard.admitOutput(text),
        admitArtifact: (bytes: Uint8Array) => !disposed && Date.now() < stored.authority.expiresAt && guard.admitArtifact(bytes),
        settle: (disposition: OrdinarySecuritySettlement["disposition"]) => settle(input, disposition),
      });
      grants.set(input.operationId, grant); return grant;
    },
    async observe(request: OrdinarySecurityInput): Promise<OrdinarySecurityObservation | undefined> {const found = await observe(capture(request)); return found === undefined ? undefined : Object.freeze({authority: found.authority, settlement: found.settlement});},
    registerSecrets(operationId: string, tokens: readonly string[]): boolean {return !disposed && (guards.get(operationId)?.registerSecrets(tokens) ?? false);},
    async dispose(): Promise<void> {disposed = true; for (const guard of guards.values()) {guard.dispose();} guards.clear(); grants.clear(); await transactions.close();},
  });
};
