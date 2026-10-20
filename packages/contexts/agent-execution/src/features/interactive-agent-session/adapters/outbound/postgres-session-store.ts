import type {InteractiveSessionStore, StoreWrite} from "../../application/ports/outbound/interactive-session-ports.js";
import {sameScope, validateRecord, type SessionRecord, type SessionScope} from "../../domain/session.js";

interface InteractivePostgresQuery {readonly text: string; readonly values: unknown[]; readonly query_timeout: number}
const query = (text: string, values: unknown[] = []): InteractivePostgresQuery => ({text, values, query_timeout: 5000});
export const INTERACTIVE_SESSION_SCHEMA = `CREATE TABLE IF NOT EXISTS interactive_session_v1 (
 tenant_id text NOT NULL, project_id text NOT NULL, session_id text NOT NULL,
 generation bigint NOT NULL CHECK (generation > 0), revision bigint NOT NULL CHECK (revision >= 0),
 state jsonb NOT NULL, PRIMARY KEY (tenant_id, project_id, session_id)
)`;
export interface InteractivePostgresClient {
  readonly query: (config: InteractivePostgresQuery) => Promise<{readonly rows: Record<string, unknown>[]; readonly rowCount: number | null}>;
  readonly release: (discard?: boolean) => void;
}
export interface InteractivePostgresPool {readonly connect: () => Promise<InteractivePostgresClient>}
const acquire = (pool: InteractivePostgresPool): Promise<InteractivePostgresClient> => new Promise((resolve, reject) => {
  let expired = false;
  const timer = setTimeout(() => {expired = true; reject(new Error("interactive_store_acquisition_timeout"));}, 5000);
  void pool.connect().then(client => {
    clearTimeout(timer);
    if (expired) {client.release();} else {resolve(client);}
    return null;
  }, () => {clearTimeout(timer); reject(new Error("interactive_store_acquisition_failed")); return null;});
});
/** Explicit migration. Constructing this borrowed-pool store never mutates schema or closes the pool. */
export async function migrateInteractiveSessionStore(pool: InteractivePostgresPool): Promise<void> {
  const client = await acquire(pool);
  try {await client.query(query(INTERACTIVE_SESSION_SCHEMA));} finally {client.release();}
}
/** Read-only admission check. An existing incompatible table is never silently adopted. */
export async function verifyInteractiveSessionStore(pool: InteractivePostgresPool): Promise<void> {
  const client = await acquire(pool);
  try {
    const columns = await client.query(query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required
      FROM pg_attribute a WHERE a.attrelid=to_regclass('interactive_session_v1') AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`));
    const expected = [["tenant_id", "text"], ["project_id", "text"], ["session_id", "text"], ["generation", "bigint"], ["revision", "bigint"], ["state", "jsonb"]];
    if (columns.rows.length !== expected.length || columns.rows.some((row, index) => row.name !== expected[index]![0] || row.type !== expected[index]![1] || row.required !== true)) {throw new TypeError("interactive_schema_columns_invalid");}
    const primary = await client.query(query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('interactive_session_v1') AND contype='p'`));
    if (primary.rows.length !== 1 || primary.rows[0]!.definition !== "PRIMARY KEY (tenant_id, project_id, session_id)") {throw new TypeError("interactive_schema_primary_key_invalid");}
  } finally {client.release();}
}
export class PostgresInteractiveSessionStore implements InteractiveSessionStore {
  readonly #pool: InteractivePostgresPool;
  constructor(pool: InteractivePostgresPool) {this.#pool = pool;}

  async #write(body: (client: InteractivePostgresClient) => Promise<StoreWrite>): Promise<StoreWrite> {
    const client = await acquire(this.#pool);
    let committing = false; let discard = false;
    try {
      await client.query(query("BEGIN"));
      await client.query(query("SET LOCAL statement_timeout = '5000ms'"));
      await client.query(query("SET LOCAL lock_timeout = '3000ms'"));
      const result = await body(client);
      committing = true;
      await client.query(query("COMMIT"));
      return result;
    } catch (error) {
      if (committing) {discard = true; return "unknown";}
      try {await client.query(query("ROLLBACK"));} catch {discard = true;}
      throw error;
    } finally {client.release(discard);}
  }
  create(record: SessionRecord): Promise<StoreWrite> {
    validateRecord(record);
    if (record.revision !== 0 || record.generation !== 1 || record.status !== "opening") {throw new TypeError("interactive_initial_record_invalid");}
    return this.#write(async client => {
      const result = await client.query(query("INSERT INTO interactive_session_v1 (tenant_id,project_id,session_id,generation,revision,state) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING",
        [record.tenantId, record.projectId, record.sessionId, record.generation, record.revision, JSON.stringify(record)]));
      return result.rowCount === 1 ? "written" : "conflict";
    });
  }
  async read(ref: SessionScope & {readonly sessionId: string}): Promise<SessionRecord | undefined> {
    const client = await acquire(this.#pool);
    let discard = false;
    try {
      const result = await client.query(query("SELECT state,generation,revision FROM interactive_session_v1 WHERE tenant_id=$1 AND project_id=$2 AND session_id=$3", [ref.tenantId, ref.projectId, ref.sessionId]));
      const row: unknown = result.rows[0]; if (row === undefined) {return undefined;}
      if (!row || typeof row !== "object" || !("state" in row) || !("generation" in row) || !("revision" in row)) {throw new TypeError("interactive_stored_row_invalid");}
      const record = row.state as SessionRecord;
      validateRecord(record);
      if (!sameScope(record, ref) || record.sessionId !== ref.sessionId || Number(row.generation) !== record.generation || Number(row.revision) !== record.revision) {throw new TypeError("interactive_stored_binding_invalid");}
      return structuredClone(record);
    } catch (error) {discard = true; throw error;} finally {client.release(discard);}
  }
  compareAndSwap(previous: SessionRecord, next: SessionRecord): Promise<StoreWrite> {
    validateRecord(previous); validateRecord(next);
    if (!sameScope(previous, next) || previous.sessionId !== next.sessionId || next.revision !== previous.revision + 1 ||
      !(next.generation === previous.generation || next.generation === previous.generation + 1 && previous.status === "closed" && next.status === "opening")) {throw new TypeError("interactive_cas_binding_invalid");}
    return this.#write(async client => {
      const result = await client.query(query("UPDATE interactive_session_v1 SET state=$4::jsonb,generation=$5,revision=$6 WHERE tenant_id=$1 AND project_id=$2 AND session_id=$3 AND generation=$7 AND revision=$8",
        [previous.tenantId, previous.projectId, previous.sessionId, JSON.stringify(next), next.generation, next.revision, previous.generation, previous.revision]));
      return result.rowCount === 1 ? "written" : "conflict";
    });
  }
}
