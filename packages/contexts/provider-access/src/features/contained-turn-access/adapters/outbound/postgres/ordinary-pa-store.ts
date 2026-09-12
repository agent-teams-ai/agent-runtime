import { createHash, randomUUID } from 'node:crypto';
import { OrdinaryPaUnavailable, type OrdinaryPaBinding, type OrdinaryPaAuthority, type OrdinaryPaSnapshot } from '../../../contracts/ordinary-provider-access.js';
import { snapshotOrdinaryPaBinding, sameOrdinaryPaBinding } from '../../../domain/ordinary-provider-access.js';
import { MaterializationPostgresTransactions, type MaterializationPostgresClient, type MaterializationPostgresPool } from './materialization-postgres-transactions.js';
import { assertOrdinaryPaSchema, migrateOrdinaryPaSchema } from './ordinary-pa-schema.js';

export const ordinaryPaDigest = (value: unknown): string => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operationKey = (binding: OrdinaryPaBinding): string => ordinaryPaDigest([binding.tenantId, binding.projectId, binding.operationId]).slice(7);
const fail = (): never => { throw new OrdinaryPaUnavailable(); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return fail(); }
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string' || value.length < 1 || value.length > 512) { return fail(); } return value; };
const integer = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { return fail(); } return value; };
const authority = (binding: OrdinaryPaBinding, facts: { grantId: string; ownerReceiptId: string; expiresAt: number; generation: number; accountId: string }): OrdinaryPaAuthority => {
  const { grantId, ownerReceiptId, expiresAt, generation, accountId } = facts;
  const consumptionDigest = ordinaryPaDigest([binding, grantId, ownerReceiptId, expiresAt, generation, accountId]);
  return Object.freeze({ ...binding, owner: 'provider_access', provider: 'codex', grantId, ownerReceiptId,
    consumptionDigest, consumptionRevision: 1, authorityDigest: ordinaryPaDigest(['ordinary-pa-authority-v1', consumptionDigest]),
    expiresAt, scope: Object.freeze({ tenantId: binding.tenantId, projectId: binding.projectId }) });
};
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
  if (requestsStarted > 64 || requestsCompleted + requestsFailed > requestsStarted) { return fail(); }
  return Object.freeze({ authority: expected, generation, accountId, materializationId: text(base.materializationId), retiredAt,
    disposition, settlementReceiptId, requestsStarted, requestsCompleted, requestsFailed });
}
const select = async (client: MaterializationPostgresClient, binding: OrdinaryPaBinding, lock = false): Promise<OrdinaryPaSnapshot | undefined> => {
  const result = await client.query('SELECT * FROM provider_access.ordinary_grant WHERE operation_key=$1' + (lock ? ' FOR UPDATE' : ''), [operationKey(binding)]);
  if (result.rows.length > 1) { return fail(); }
  return result.rows[0] ? decodeRow(result.rows[0], binding) : undefined;
};
/** Additive ordinary namespace. A duplicate consume or unknown COMMIT never issues a fresh grant. */
export function createOrdinaryPaStore(pool: MaterializationPostgresPool) {
  const transactions = new MaterializationPostgresTransactions(pool, { connectionMs: 1000, statementMs: 2000, transactionMs: 4000 });
  const transaction = <T>(work: (client: MaterializationPostgresClient) => Promise<T>) => transactions.write(async client => {
    await assertOrdinaryPaSchema(client); return work(client);
  });
  return Object.freeze({
    migrate: () => migrateOrdinaryPaSchema(transactions),
    dispose: () => transactions.dispose(),
    observe: (input: OrdinaryPaBinding) => { const binding = snapshotOrdinaryPaBinding(input); return transaction(client => select(client, binding)); },
    async consume(input: OrdinaryPaBinding, selected: { generation: number; accountId: string; expiresAt: number }): Promise<OrdinaryPaSnapshot> {
      const binding = snapshotOrdinaryPaBinding(input);
      if (integer(selected.generation) < 1 || text(selected.accountId).length > 256 || selected.expiresAt <= Date.now() || selected.expiresAt > Date.now() + 60_000) { return fail(); }
      const snapshot = Object.freeze({ authority: authority(binding, { grantId: randomUUID(), ownerReceiptId: randomUUID(), ...selected }),
        generation: selected.generation, accountId: selected.accountId, materializationId: randomUUID() });
      return transaction(async client => {
        const inserted = await client.query(`INSERT INTO provider_access.ordinary_grant(operation_key,binding,snapshot,expires_at)
          SELECT $1,$2::jsonb,$3::jsonb,$4::bigint WHERE $4::bigint>extract(epoch from clock_timestamp())*1000 AND $4::bigint<=extract(epoch from clock_timestamp())*1000+60000
          ON CONFLICT (operation_key) DO NOTHING`, [operationKey(binding), JSON.stringify(binding), JSON.stringify(snapshot), selected.expiresAt]);
        if (inserted.rowCount !== 1) { return fail(); }
        return await select(client, binding) ?? fail();
      });
    },
    async retire(input: OrdinaryPaBinding): Promise<OrdinaryPaSnapshot> {
      const binding = snapshotOrdinaryPaBinding(input);
      return transaction(async client => {
        const current = await select(client, binding, true); if (!current) { return fail(); }
        if (current.requestsStarted !== current.requestsCompleted + current.requestsFailed) { return fail(); }
        if (current.retiredAt === null) {
          await client.query('UPDATE provider_access.ordinary_grant SET retired_at=$2 WHERE operation_key=$1', [operationKey(binding), new Date().toISOString()]);
        }
        return await select(client, binding) ?? fail();
      });
    },
    async settle(input: OrdinaryPaBinding, disposition: 'claim_committed' | 'abandoned_without_claim'): Promise<OrdinaryPaSnapshot> {
      const binding = snapshotOrdinaryPaBinding(input);
      if (disposition !== 'claim_committed' && disposition !== 'abandoned_without_claim') { return fail(); }
      return transaction(async client => {
        const current = await select(client, binding, true); if (!current || current.retiredAt === null) { return fail(); }
        if (current.disposition !== null && current.disposition !== disposition) { return fail(); }
        if (current.disposition === null) { await client.query('UPDATE provider_access.ordinary_grant SET disposition=$2,settlement_id=$3 WHERE operation_key=$1', [operationKey(binding), disposition, randomUUID()]); }
        return await select(client, binding) ?? fail();
      });
    },
    async beginRequest(input: OrdinaryPaBinding, bodyDigest: string, byteLength: number): Promise<number> {
      const binding = snapshotOrdinaryPaBinding(input);
      if (!/^sha256:[a-f0-9]{64}$/.test(bodyDigest) || integer(byteLength) < 1 || byteLength > 1_048_576) { return fail(); }
      return transaction(async client => {
        const current = await select(client, binding, true);
        if (!current || current.retiredAt !== null || current.disposition !== null || current.requestsFailed !== 0 ||
          current.authority.expiresAt <= Date.now() || current.requestsStarted >= 64 || current.requestsStarted !== current.requestsCompleted) { return fail(); }
        const sequence = current.requestsStarted + 1;
        await client.query("INSERT INTO provider_access.ordinary_request(operation_key,sequence,body_digest,byte_length,outcome) VALUES ($1,$2,$3,$4,'started')", [operationKey(binding), sequence, bodyDigest, byteLength]);
        await client.query('UPDATE provider_access.ordinary_grant SET requests_started=$2 WHERE operation_key=$1', [operationKey(binding), sequence]);
        return sequence;
      });
    },
    async endRequest(input: OrdinaryPaBinding, sequence: number, succeeded: boolean): Promise<void> {
      const binding = snapshotOrdinaryPaBinding(input);
      await transaction(async client => {
        const current = await select(client, binding, true); if (!current || integer(sequence) < 1 || sequence !== current.requestsStarted) { return fail(); }
        const updated = await client.query("UPDATE provider_access.ordinary_request SET outcome=$3 WHERE operation_key=$1 AND sequence=$2 AND outcome='started'",
          [operationKey(binding), sequence, succeeded ? 'completed' : 'failed']);
        if (updated.rowCount !== 1) { return fail(); }
        await client.query(`UPDATE provider_access.ordinary_grant SET ${succeeded ? 'requests_completed=requests_completed+1' : 'requests_failed=requests_failed+1'} WHERE operation_key=$1`, [operationKey(binding)]);
      });
    },
  });
}
export type OrdinaryPaStore = ReturnType<typeof createOrdinaryPaStore>;
