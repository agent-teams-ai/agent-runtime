import { createHash } from 'node:crypto';
import { OrdinaryPaUnavailable, type OrdinaryPaBinding, type OrdinaryPaAuthority, type OrdinaryPaSnapshot } from '../../../contracts/ordinary-provider-access.js';
import type { OrdinaryPaGrantStore, OrdinaryPaInsertGrantResult } from '../../../application/ports/outbound/ordinary-pa-grant-store.js';
import { decideOrdinaryPaBeginRequest, decideOrdinaryPaEndRequest, decideOrdinaryPaRetire, decideOrdinaryPaSettle, deriveOrdinaryPaAuthority,
  isOrdinaryPaDisposition, isOrdinaryPaRequestOutcome, ordinaryPaMaxRequests, sameOrdinaryPaBinding, snapshotOrdinaryPaBinding, snapshotOrdinaryPaRequest,
  type OrdinaryPaBrokerRequest, type OrdinaryPaDisposition, type OrdinaryPaGrantRecord, type OrdinaryPaRequestOutcome } from '../../../domain/ordinary-provider-access.js';
import { MaterializationPostgresTransactions, type MaterializationPostgresClient, type MaterializationPostgresPool } from './materialization-postgres-transactions.js';
import { assertOrdinaryPaSchema, migrateOrdinaryPaSchema } from './ordinary-pa-schema.js';

export const ordinaryPaDigest = (value: unknown): string => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operationKey = (binding: OrdinaryPaBinding): string => ordinaryPaDigest([binding.tenantId, binding.projectId, binding.operationId]).slice(7);
const fail = (): never => { throw new OrdinaryPaUnavailable(); };
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return fail(); }
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string' || value.length < 1 || value.length > 512) { return fail(); } return value; };
const integer = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { return fail(); } return value; };
const authority = (binding: OrdinaryPaBinding, facts: Parameters<typeof deriveOrdinaryPaAuthority>[1]): OrdinaryPaAuthority => deriveOrdinaryPaAuthority(binding, facts, ordinaryPaDigest);
function readDisposition(value: unknown): 'claim_committed' | 'abandoned_without_claim' | null {
  if (value !== null && value !== 'claim_committed' && value !== 'abandoned_without_claim') { return fail(); }
  return value;
}
function decodeRow(row: Record<string, unknown>, binding: OrdinaryPaBinding): OrdinaryPaSnapshot {
  const observedBinding = snapshotOrdinaryPaBinding(row.binding);
  if (!sameOrdinaryPaBinding(binding, observedBinding)) { return fail(); }
  const base = record(row.snapshot), observedAuthority = record(base.authority);
  const generation = integer(base.generation), accountId = text(base.accountId), expiresAt = integer(observedAuthority.expiresAt);
  if (generation < 1 || accountId.length > 256) { return fail(); }
  const expected = authority(binding, { grantId: text(observedAuthority.grantId), ownerReceiptId: text(observedAuthority.ownerReceiptId), expiresAt, generation, accountId });
  if (Object.keys(base).length !== 4 || Object.keys(observedAuthority).length !== Object.keys(expected).length ||
      String(expiresAt) !== String(row.expires_at)) { return fail(); }
  for (const key of Object.keys(expected) as (keyof OrdinaryPaAuthority)[]) {
    if (key === 'scope') {
      const scope = record(observedAuthority.scope);
      if (scope.tenantId !== binding.tenantId || scope.projectId !== binding.projectId || Object.keys(scope).length !== 2) { return fail(); }
    } else if (observedAuthority[key] !== expected[key]) { return fail(); }
  }
  const retiredAt = row.retired_at === null ? null : text(row.retired_at);
  const disposition = readDisposition(row.disposition);
  const settlementReceiptId = row.settlement_id === null ? null : text(row.settlement_id);
  if ((disposition === null) !== (settlementReceiptId === null)) { return fail(); }
  const requestsStarted = integer(row.requests_started), requestsCompleted = integer(row.requests_completed), requestsFailed = integer(row.requests_failed);
  if (requestsStarted > ordinaryPaMaxRequests || requestsCompleted + requestsFailed > requestsStarted) { return fail(); }
  return Object.freeze({ authority: expected, generation, accountId, materializationId: text(base.materializationId), retiredAt,
    disposition, settlementReceiptId, requestsStarted, requestsCompleted, requestsFailed });
}
const select = async (client: MaterializationPostgresClient, binding: OrdinaryPaBinding, lock = false): Promise<OrdinaryPaSnapshot | undefined> => {
  const result = await client.query('SELECT * FROM provider_access.ordinary_grant WHERE operation_key=$1' + (lock ? ' FOR UPDATE' : ''), [operationKey(binding)]);
  if (result.rows.length > 1) { return fail(); }
  return result.rows[0] ? decodeRow(result.rows[0], binding) : undefined;
};
export type PostgresOrdinaryPaGrantStore = Readonly<OrdinaryPaGrantStore & { migrate(): Promise<void>; dispose(): void }>;
/** Additive ordinary namespace. A duplicate insert or unknown COMMIT never issues a fresh grant. */
export function createOrdinaryPaStore(pool: MaterializationPostgresPool, options: { readonly now?: () => number } = {}): PostgresOrdinaryPaGrantStore {
  const now = options.now ?? Date.now;
  const transactions = new MaterializationPostgresTransactions(pool, { connectionMs: 1000, statementMs: 2000, transactionMs: 4000 });
  const transaction = <T>(work: (client: MaterializationPostgresClient) => Promise<T>) => transactions.write(async client => {
    await assertOrdinaryPaSchema(client); return work(client);
  });
  return Object.freeze({
    migrate: () => migrateOrdinaryPaSchema(transactions),
    dispose: () => {transactions.dispose(); },
    observe: (input: OrdinaryPaBinding) => { const binding = snapshotOrdinaryPaBinding(input); return transaction(client => select(client, binding)); },
    async insertGrant(grant: OrdinaryPaGrantRecord): Promise<OrdinaryPaInsertGrantResult> {
      const binding = snapshotOrdinaryPaBinding(grant.binding), snapshot = JSON.stringify(grant.snapshot), expiresAt = grant.expiresAt;
      return transaction(async client => {
        const inserted = await client.query(`INSERT INTO provider_access.ordinary_grant(operation_key,binding,snapshot,expires_at)
          SELECT $1,$2::jsonb,$3::jsonb,$4::bigint WHERE $4::bigint>extract(epoch from clock_timestamp())*1000 AND $4::bigint<=extract(epoch from clock_timestamp())*1000+60000
          ON CONFLICT (operation_key) DO NOTHING`, [operationKey(binding), JSON.stringify(binding), snapshot, expiresAt]);
        if (inserted.rowCount !== 1) { return Object.freeze({ kind: 'rejected' } as const); }
        return Object.freeze({ kind: 'inserted', snapshot: await select(client, binding) ?? fail() } as const);
      });
    },
    async retire(input: OrdinaryPaBinding): Promise<OrdinaryPaSnapshot> {
      const binding = snapshotOrdinaryPaBinding(input);
      return transaction(async client => {
        const decision = decideOrdinaryPaRetire(await select(client, binding, true));
        if (decision.kind === 'refused') { return fail(); }
        if (decision.kind === 'write') { await client.query('UPDATE provider_access.ordinary_grant SET retired_at=$2 WHERE operation_key=$1', [operationKey(binding), new Date(now()).toISOString()]); }
        return await select(client, binding) ?? fail();
      });
    },
    async settle(input: OrdinaryPaBinding, disposition: OrdinaryPaDisposition, settlementId: string): Promise<OrdinaryPaSnapshot> {
      const binding = snapshotOrdinaryPaBinding(input), receipt = text(settlementId);
      if (!isOrdinaryPaDisposition(disposition)) { return fail(); }
      return transaction(async client => {
        const decision = decideOrdinaryPaSettle(await select(client, binding, true), disposition);
        if (decision.kind === 'refused') { return fail(); }
        if (decision.kind === 'write') { await client.query('UPDATE provider_access.ordinary_grant SET disposition=$2,settlement_id=$3 WHERE operation_key=$1', [operationKey(binding), disposition, receipt]); }
        return await select(client, binding) ?? fail();
      });
    },
    async beginRequest(input: OrdinaryPaBinding, requestInput: OrdinaryPaBrokerRequest): Promise<number> {
      const binding = snapshotOrdinaryPaBinding(input), request = snapshotOrdinaryPaRequest(requestInput);
      return transaction(async client => {
        const decision = decideOrdinaryPaBeginRequest(await select(client, binding, true), now());
        if (decision.kind === 'refused') { return fail(); }
        await client.query("INSERT INTO provider_access.ordinary_request(operation_key,sequence,body_digest,byte_length,outcome) VALUES ($1,$2,$3,$4,'started')", [operationKey(binding), decision.sequence, request.bodyDigest, request.byteLength]);
        await client.query('UPDATE provider_access.ordinary_grant SET requests_started=$2 WHERE operation_key=$1', [operationKey(binding), decision.sequence]);
        return decision.sequence;
      });
    },
    async endRequest(input: OrdinaryPaBinding, sequence: number, outcome: OrdinaryPaRequestOutcome): Promise<void> {
      const binding = snapshotOrdinaryPaBinding(input);
      if (!isOrdinaryPaRequestOutcome(outcome)) { return fail(); }
      await transaction(async client => {
        if (decideOrdinaryPaEndRequest(await select(client, binding, true), sequence).kind === 'refused') { return fail(); }
        const updated = await client.query("UPDATE provider_access.ordinary_request SET outcome=$3 WHERE operation_key=$1 AND sequence=$2 AND outcome='started'",
          [operationKey(binding), sequence, outcome]);
        if (updated.rowCount !== 1) { return fail(); }
        await client.query(`UPDATE provider_access.ordinary_grant SET ${outcome === 'completed' ? 'requests_completed=requests_completed+1' : 'requests_failed=requests_failed+1'} WHERE operation_key=$1`, [operationKey(binding)]);
      });
    },
  });
}
