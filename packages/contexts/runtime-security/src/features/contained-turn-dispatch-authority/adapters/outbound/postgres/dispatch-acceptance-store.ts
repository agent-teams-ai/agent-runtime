import type { DispatchAcceptanceStore, DispatchAcceptanceDecision, DispatchAcceptanceIntent } from
  '../../../application/ports/outbound/dispatch-acceptance-owner.js';
import { acceptanceCanonical, validAcceptanceIntent } from '../../../application/dispatch-acceptance.js';
import { detachDispatchBoundaryValue } from '../../dispatch-boundary-value.js';
import { createDispatchPgTransactions } from './transaction.js';
import type { DispatchPgDeadlines, DispatchPgPool } from './transaction.js';

const table = 'runtime_security_dispatch_acceptance_v1.decisions';
const keyOf = (intent: DispatchAcceptanceIntent) => {
  if (!validAcceptanceIntent(intent)) {throw new TypeError('invalid acceptance intent');}
  return acceptanceCanonical({ operationId: intent.operationId, scope: intent.scope });
};
/** RS-owned insert-only evidence, using the same transaction/borrowed-pool rules
 * as dispatch persistence. Explicit migration; no effects during construction. */
export const createPostgresDispatchAcceptanceStore = (options: DispatchPgDeadlines & {
  readonly pool: DispatchPgPool;
}): DispatchAcceptanceStore & { migrate(): Promise<void>; close(): void } => {
  const transactions = createDispatchPgTransactions(options.pool, options);
  const capture = (value: unknown) => detachDispatchBoundaryValue(value) as DispatchAcceptanceDecision;
  return Object.freeze({
    close: transactions.close,
    async migrate() {
      await transactions.run(async tx => {
        await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", ['-693137002']);
        await tx.query(`CREATE SCHEMA IF NOT EXISTS runtime_security_dispatch_acceptance_v1;
          CREATE TABLE IF NOT EXISTS ${table} (
            operation_key text PRIMARY KEY, decision text NOT NULL);
          CREATE OR REPLACE FUNCTION runtime_security_dispatch_acceptance_v1.immutable_decision()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            RAISE EXCEPTION 'dispatch acceptance is immutable'; END $$;
          DROP TRIGGER IF EXISTS immutable_decision ON ${table};
          CREATE TRIGGER immutable_decision BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION runtime_security_dispatch_acceptance_v1.immutable_decision();`);
      });
    },
    async read(value: DispatchAcceptanceIntent) {
      const intent = detachDispatchBoundaryValue(value) as DispatchAcceptanceIntent;
      return transactions.run(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keyOf(intent)]);
        const result = await tx.query(`SELECT decision FROM ${table} WHERE operation_key = $1`, [keyOf(intent)]);
        if (result.rows.length === 0) {return undefined;}
        if (result.rows.length !== 1 || typeof result.rows[0]?.decision !== 'string') {
          throw new TypeError('invalid retained acceptance');
        }
        return capture(JSON.parse(result.rows[0].decision));
      });
    },
    async retain(value: DispatchAcceptanceDecision) {
      const decision = capture(value);
      const intent = { operationId: decision.operationId, scope: decision.scope,
        providerId: decision.providerId, intentDigest: decision.intentDigest,
        policyRevision: decision.policyRevision };
      const key = keyOf(intent);
      return transactions.run(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        await tx.query(`INSERT INTO ${table} (operation_key, decision) VALUES ($1, $2)
          ON CONFLICT (operation_key) DO NOTHING`, [key, acceptanceCanonical(decision)]);
        const result = await tx.query(`SELECT decision FROM ${table} WHERE operation_key = $1`, [key]);
        if (result.rows.length !== 1 || typeof result.rows[0]?.decision !== 'string') {
          throw new TypeError('invalid retained acceptance');
        }
        return capture(JSON.parse(result.rows[0].decision));
      });
    },
  });
};
