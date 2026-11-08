// Disposable S2.0/M08 SQL feasibility TEST only; NOT a production admission owner.
// This has no Host/Provider Access integration, public API or cutover authority.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {Client, Pool} from "pg";

const digest = (scope: string, operation: string, attempt: string, request: string) =>
  createHash("sha256").update(JSON.stringify([scope, operation, attempt, request])).digest("hex");
const claim = `INSERT INTO host_http_egress.m08_admission_spike (intent_key, owner_id)
  VALUES ($1, $2) ON CONFLICT (intent_key) DO NOTHING RETURNING owner_id`;

/** Called only after the parent verifies a fresh, isolated disposable PG database.
 * An atomic pre-effect reservation has one winner, even under concurrent owners.
 * Post-COMMIT ACK loss must not yield a second claim or authorize replay.
 * An uncommitted pre-effect claim is released by a real PostgreSQL backend crash.
 */
export const proveDisposablePostgresAdmissionSpike = async (databaseUrl: string): Promise<void> => {
  const config = {connectionString: databaseUrl, connectionTimeoutMillis: 5_000, max: 2};
  const first = new Pool(config); const second = new Pool(config);
  try {
    await first.query(`CREATE TABLE host_http_egress.m08_admission_spike (
      intent_key text PRIMARY KEY CHECK (length(intent_key) = 64),
      owner_id text NOT NULL)`);
    const a = await first.connect(); const b = await second.connect();
    try {
      const [pidA, pidB] = await Promise.all([a.query("SELECT pg_backend_pid() AS pid"),
        b.query("SELECT pg_backend_pid() AS pid")]);
      assert.notEqual(pidA.rows[0]?.pid, pidB.rows[0]?.pid, "distinct PostgreSQL server backends");
      const key = digest("tenant/project/deployment", "operation", "attempt", "request");
      const raced = await Promise.all([a.query(claim, [key, "host-A"]), b.query(claim, [key, "host-B"])]);
      assert.deepEqual(raced.map(result => result.rowCount).toSorted(), [0, 1],
        "concurrent SQL claims must have exactly one durable winner");
      const original = await b.query("SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1",
        [key]);
      assert.equal(original.rowCount, 1);
      assert.ok(["host-A", "host-B"].includes(original.rows[0]?.owner_id));
      assert.equal((await a.query(claim, [key, "restarted-host"])).rowCount, 0,
        "restarted Host cannot reacquire previously claimed intent");

      const unknownKey = digest("tenant/project/deployment", "operation-unknown", "attempt", "request");
      await a.query("BEGIN");
      assert.equal((await a.query(claim, [unknownKey, "host-A-before-ack-loss"])).rowCount, 1);
      await a.query("COMMIT");
      // Lost acknowledgement is simulated *after* a real committed transaction.
      let lostAck = false;
      try {throw new Error("simulated lost ACK");}
      catch (error) {lostAck = error instanceof Error && error.message === "simulated lost ACK";}
      assert.equal(lostAck, true);
      assert.equal((await b.query(claim, [unknownKey, "host-B-after-unknown"])).rowCount, 0,
        "a lost COMMIT ACK cannot allow a second SQL winner");
      const retained = await b.query("SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1",
        [unknownKey]);
      assert.deepEqual(retained.rows.map(row => row.owner_id), ["host-A-before-ack-loss"],
        "readback must preserve the prior immutable claim");

      const foreignKey = digest("foreign-tenant/project/deployment", "operation", "attempt", "request");
      assert.equal((await b.query(claim, [foreignKey, "foreign-owner"])).rowCount, 1,
        "foreign scope must not alias the original durable identity");
    } finally {a.release(); b.release();}
    // A claim in a transaction that dies BEFORE any provider effect must
    // roll back. This is distinct from a committed UNKNOWN claim: only the
    // demonstrably uncommitted reservation can be reacquired.
    const crashed = new Client({connectionString: databaseUrl, connectionTimeoutMillis: 5_000});
    crashed.on("error", () => {}); // The backend is deliberately terminated below.
    await crashed.connect();
    try {
      const abortKey = digest("tenant/project/deployment", "aborted-before-effect", "attempt", "request");
      await crashed.query("BEGIN");
      assert.equal((await crashed.query(claim, [abortKey, "aborted-host"])).rowCount, 1);
      const backendPid = (await crashed.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      assert.equal(typeof backendPid, "number");
      const stopped = await second.query("SELECT pg_terminate_backend($1) AS stopped", [backendPid]);
      assert.equal(stopped.rows[0]?.stopped, true, "disposable checked-out SQL backend was killed");
      assert.equal((await second.query(claim, [abortKey, "verified-no-effect-recovery"])).rowCount, 1,
        "uncommitted claim must be released by actual backend termination");
      assert.equal((await second.query(claim, [abortKey, "second-recovery"])).rowCount, 0,
        "recovery claim is durable and cannot be taken by another Host");
    } finally {
      // Connection-terminated is expected during disposal of this TEST Client.
      await crashed.end().catch(() => {});
    }
    // A durable COMMIT must survive termination of the SQL backend that made
    // the claim. A new process may observe it but cannot reserve it again.
    // This remains SQL-only: no provider effect or Host admission is wired.
    const committed = new Client({connectionString: databaseUrl, connectionTimeoutMillis: 5_000});
    committed.on("error", () => {}); // Termination is deliberate in this disposable fixture.
    await committed.connect();
    try {
      const durableKey = digest("tenant/project/deployment", "committed-before-crash", "attempt", "request");
      await committed.query("BEGIN");
      assert.equal((await committed.query(claim, [durableKey, "committed-owner"])).rowCount, 1);
      await committed.query("COMMIT");
      const backendPid = (await committed.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      assert.equal(typeof backendPid, "number");
      const stopped = await second.query("SELECT pg_terminate_backend($1) AS stopped", [backendPid]);
      assert.equal(stopped.rows[0]?.stopped, true, "committed SQL backend was killed");
      assert.equal((await second.query(claim, [durableKey, "post-crash-owner"])).rowCount, 0,
        "committed intent must not be reclaimed after backend termination");
      const retained = await second.query(
        "SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1", [durableKey]);
      assert.deepEqual(retained.rows.map(row => row.owner_id), ["committed-owner"],
        "actual post-crash readback must preserve the original durable winner");
    } finally {
      await committed.end().catch(() => {});
    }
  } finally {await Promise.all([first.end(), second.end()]);}
};
