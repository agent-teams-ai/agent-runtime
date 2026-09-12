/** Private driver boundary. The caller owns the pool and its shutdown. */
export interface MaterializationPostgresClient {
  query(sql: string, values?: unknown[]): Promise<{rows: Record<string, unknown>[]; rowCount: number | null}>;
  release(discard?: boolean): void;
}
export interface MaterializationPostgresPool {
  connect(): Promise<MaterializationPostgresClient>;
}
export interface MaterializationPostgresTimeouts {
  readonly connectionMs: number;
  readonly statementMs: number;
  readonly transactionMs: number;
}

const within = async <T>(pending: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Provider Access database deadline exceeded")), milliseconds);
    })]);
  } finally {if (timer !== undefined) {clearTimeout(timer);}}
};

export class MaterializationPostgresTransactions {
  readonly #pool: MaterializationPostgresPool;
  readonly #timeouts: MaterializationPostgresTimeouts;
  #closed = false;

  constructor(pool: MaterializationPostgresPool, overrides: Partial<MaterializationPostgresTimeouts> = {}) {
    this.#pool = pool;
    this.#timeouts = Object.freeze({connectionMs: 2_000, statementMs: 5_000, transactionMs: 10_000, ...overrides});
    for (const value of Object.values(this.#timeouts)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {throw new TypeError("Invalid PA database timeout");}
    }
  }
  dispose(): void {this.#closed = true;}
  #check(): void {if (this.#closed) {throw new Error("Provider Access database owner is closed");}}

  async write<T>(work: (client: MaterializationPostgresClient, checkOpen: () => void) => Promise<T>): Promise<T> {
    this.#check();
    const pending = this.#pool.connect();
    let client: MaterializationPostgresClient;
    try {client = await within(pending, this.#timeouts.connectionMs);}
    catch (error) {void pending.then(late => {late.release(true); return null;}, () => null); throw error;}
    let commitStarted = false;
    let discard = false;
    let open = true;
    let queriesInFlight = 0;
    const checkOpen = () => {
      this.#check();
      if (!open) {throw new Error("Provider Access transaction is closed");}
    };
    const query = async (sql: string, values?: unknown[]) => {
      queriesInFlight += 1;
      try {return await within(client.query(sql, values), this.#timeouts.statementMs);}
      catch (error) {discard = true; throw error;}
      finally {queriesInFlight -= 1;}
    };
    const scoped: MaterializationPostgresClient = {
      query: async (sql, values) => {
        checkOpen();
        const result = await query(sql, values);
        checkOpen();
        return result;
      },
      release: () => {throw new Error("Transaction does not own the connection");},
    };
    try {
      this.#check();
      await query("BEGIN");
      await query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [`${String(this.#timeouts.statementMs)}ms`, `${String(this.#timeouts.transactionMs)}ms`]);
      let result: T;
      try {result = await within(work(scoped, checkOpen), this.#timeouts.transactionMs);}
      finally {open = false;}
      this.#check();
      commitStarted = true;
      await query("COMMIT");
      this.#check();
      return result;
    } catch (error) {
      open = false;
      if (commitStarted) {
        // COMMIT may have succeeded. Never retry or publish fresh authority.
        discard = true;
        throw new Error("Provider Access commit acknowledgement is indeterminate", {cause: error});
      }
      if (queriesInFlight > 0) {discard = true;}
      if (!discard) {try {await query("ROLLBACK");} catch {discard = true;}}
      throw error;
    } finally {open = false; client.release(discard);}
  }
}
