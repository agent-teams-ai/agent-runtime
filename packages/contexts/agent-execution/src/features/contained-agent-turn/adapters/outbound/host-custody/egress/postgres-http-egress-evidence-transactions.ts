/** Private driver boundary. The caller owns the pool and its shutdown. */
export interface ContainedTurnPostgresQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface ContainedTurnPostgresClient {
  query(sql: string, values?: unknown[]): Promise<ContainedTurnPostgresQueryResult>;
  release(discard?: boolean): void;
}

export interface ContainedTurnPostgresPool {
  connect(): Promise<ContainedTurnPostgresClient>;
}

// This fence belongs to Host HTTP custody, never agent_execution.schema_migration.
export const HTTP_EVIDENCE_FENCE = "host-http-egress-receipt/v1:canonical-complete-json/v1";
const TIMEOUT_MS = 5_000;
export class PostgresHttpEvidenceTransactions {
  readonly #pool: ContainedTurnPostgresPool;
  public constructor(pool: ContainedTurnPostgresPool) {this.#pool = pool;}
  async #connect(): Promise<ContainedTurnPostgresClient> {
    const pending = this.#pool.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP evidence acquisition timeout")), TIMEOUT_MS);
      })]);
    } catch (error) {void pending.then(client => client.release(true), () => {}); throw error;}
    finally {clearTimeout(timer);}
  }
  public async run<T>(work: (client: ContainedTurnPostgresClient, query: (sql: string, values?: unknown[]) => Promise<ContainedTurnPostgresQueryResult>) => Promise<T>): Promise<T> {
    const client = await this.#connect();
    let discarded = false;
    const query = async (sql: string, values?: unknown[]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([client.query(sql, values), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {discarded = true; reject(new Error("HTTP evidence query timeout"));}, TIMEOUT_MS);
        })]);
      } finally {clearTimeout(timer);}
    };
    try {
      await query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await query(`SELECT set_config('statement_timeout', '4000ms', true),
        set_config('lock_timeout', '4000ms', true),
        set_config('idle_in_transaction_session_timeout', '4000ms', true),
        set_config('synchronous_commit', 'on', true)`);
      const result = await work(client, query);
      await query("COMMIT");
      return result;
    } catch (error) {
      // Destroy on any uncertainty; never queue ROLLBACK behind a timed-out COMMIT.
      discarded = true; throw error;
    } finally {client.release(discarded);}
  }
}
