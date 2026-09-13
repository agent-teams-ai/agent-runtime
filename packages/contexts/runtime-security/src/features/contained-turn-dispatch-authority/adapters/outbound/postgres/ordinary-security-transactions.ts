import type {DispatchPgPool, DispatchPgClient, DispatchPgTransaction} from "./transaction.js";
const unavailable = (): Error => new Error("ORDINARY_SECURITY_DATABASE_UNAVAILABLE");
/** Ordinary supports PG14+. Server statement bounds plus one owned overall timer bound the transaction. */
export const createOrdinarySecurityTransactions = (pool: DispatchPgPool) => {
  let closed = false;
  const active = new Set<AbortController>();
  const completions = new Set<Promise<void>>();
  return Object.freeze({
    async close(): Promise<void> {closed = true; for (const controller of active) {controller.abort();} await Promise.all(completions);},
    async run<T>(work: (transaction: DispatchPgTransaction) => Promise<T>): Promise<T> {
      if (closed) {throw unavailable();}
      const controller = new AbortController(); active.add(controller);
      let complete!: () => void;
      const completion = new Promise<void>(resolve => {complete = resolve;}); completions.add(completion);
      const timer = setTimeout(() => controller.abort(), 10000);
      let client: DispatchPgClient | undefined; let broken = false; let committing = false;
      const assertOpen = (): void => {if (closed || controller.signal.aborted) {throw unavailable();}};
      const bounded = <V>(start: () => Promise<V>): Promise<V> => new Promise((resolve, reject) => {
        try {assertOpen();} catch {reject(unavailable()); return;}
        let queryTimer: ReturnType<typeof setTimeout> | undefined;
        const release = (): void => {clearTimeout(queryTimer); controller.signal.removeEventListener("abort", abort);};
        const abort = (): void => {release(); broken = true; reject(unavailable());};
        controller.signal.addEventListener("abort", abort, {once: true});
        queryTimer = setTimeout(() => controller.abort(), 5000);
        try {start().then(value => {release(); if (controller.signal.aborted) {reject(unavailable());} else {resolve(value);} return;}, () => {release(); reject(unavailable());});}
        catch {release(); reject(unavailable());}
      });
      const query: DispatchPgTransaction["query"] = async (sql, values) => {
        const owned = client; if (owned === undefined) {throw unavailable();}
        return bounded(() => owned.query(sql, values));
      };
      try {
        client = await bounded(async () => {
          const acquired = await pool.connect();
          if (controller.signal.aborted || closed) {acquired.release(true); throw unavailable();}
          return acquired;
        });
        committing = true; await query("BEGIN"); committing = false;
        await query("SELECT set_config('statement_timeout','5000',true), set_config('idle_in_transaction_session_timeout','10000',true)");
        const result = await work({query, assertOpen}); assertOpen();
        committing = true; await query("COMMIT"); return result;
      } catch {
        if (committing || controller.signal.aborted) {broken = true;}
        else if (client !== undefined) {try {await query("ROLLBACK");} catch {broken = true;}}
        throw unavailable();
      } finally {clearTimeout(timer); active.delete(controller); try {client?.release(broken || closed);} finally {completions.delete(completion); complete();}}
    },
  });
};
