import { performance } from "node:perf_hooks";

/** Borrowed pg-compatible pool. Each connect must lend one exclusive, idle client. */
export interface DispatchPgClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[];
    rowCount: number | null }>;
  release(discard?: boolean): void;
}
export interface DispatchPgPool { connect(): Promise<DispatchPgClient> }
export interface DispatchPgDeadlines {
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly transactionTimeoutMs: number;
}
export interface DispatchPgTransaction {
  query(sql: string, values?: unknown[]): ReturnType<DispatchPgClient["query"]>;
  assertOpen(): void;
}

const unavailable = () => new Error("dispatch PostgreSQL owner unavailable");

/** No I/O at construction; close seals only this adapter, never ends the borrowed pool. */
export const createDispatchPgTransactions = (pool: DispatchPgPool, options: DispatchPgDeadlines) => {
  const { connectTimeoutMs, queryTimeoutMs, transactionTimeoutMs } = options;
  for (const value of [connectTimeoutMs, queryTimeoutMs, transactionTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new TypeError("invalid dispatch PostgreSQL deadline");
    }
  }
  const connect = pool.connect.bind(pool);
  const active = new Set<AbortController>();
  let closed = false;
  return Object.freeze({
    close(): void {
      closed = true;
      for (const controller of active) {controller.abort();}
    },
    async run<Value>(work: (transaction: DispatchPgTransaction) => Promise<Value>): Promise<Value> {
      if (closed) {throw unavailable();}
      const controller = new AbortController();
      active.add(controller);
      const expires = performance.now() + transactionTimeoutMs;
      let client: DispatchPgClient | undefined;
      let discarded = false;
      let begun = false;
      let committing = false;
      const release = (connection: DispatchPgClient, discard: boolean) => {
        try {connection.release(discard);} catch { /* Never expose driver diagnostics. */ }
      };
      const assertOpen = () => {
        if (closed || controller.signal.aborted || performance.now() >= expires) {throw unavailable();}
      };
      const bounded = <T>(start: () => Promise<T>, cap: number, onAbandon: () => void): Promise<T> => {
        assertOpen();
        return new Promise<T>((resolve, reject) => {
          let done = false;
          const finish = (error: boolean, value?: T) => {
            if (done) {return;}
            done = true;
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", abandon);
            if (error) {reject(unavailable());} else {resolve(value as T);}
          };
          const abandon = () => {onAbandon(); finish(true);};
          const timer = setTimeout(abandon, Math.max(1, Math.min(cap, expires - performance.now())));
          controller.signal.addEventListener("abort", abandon, { once: true });
          try {start().then(value => finish(false, value), () => finish(true));}
          catch {finish(true);}
        });
      };
      const query: DispatchPgTransaction["query"] = async (sql, values) => {
        if (client === undefined || discarded) {throw unavailable();}
        const connection = client;
        const result = await bounded(() => connection.query(sql, values), queryTimeoutMs,
          () => {discarded = true;});
        assertOpen();
        return result;
      };
      try {
        let abandoned = false;
        client = await bounded(() => connect().then(connection => {
          // A timed-out acquisition can still arrive; it must not leak or run BEGIN.
          if (abandoned || closed) {release(connection, true); throw unavailable();}
          return connection;
        }), connectTimeoutMs, () => {abandoned = true;});
        assertOpen();
        // BEGIN failures also discard: the server may have begun without acknowledging it.
        committing = true;
        await query("BEGIN ISOLATION LEVEL READ COMMITTED");
        committing = false;
        begun = true;
        await query(`SELECT set_config('statement_timeout', $1, true),
          set_config('idle_in_transaction_session_timeout', $2, true),
          set_config('transaction_timeout', $2, true)`,
        [String(queryTimeoutMs), String(transactionTimeoutMs)]);
        const result = await work({ query, assertOpen });
        assertOpen();
        committing = true;
        await query("COMMIT");
        begun = false;
        return result;
      } catch {
        if (begun && !committing && !discarded) {
          try {await query("ROLLBACK");} catch {discarded = true;}
        } else {discarded = true;}
        throw unavailable();
      } finally {
        active.delete(controller);
        if (client !== undefined) {release(client, discarded || closed);}
      }
    },
  });
};
