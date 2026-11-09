// Disposable S2.0/M08 SQL feasibility TEST only; NOT a production admission owner.
// This has no Host/Provider Access integration, public API or cutover authority.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {Client, Pool} from "pg";

// An UNKNOWN operation is immutable across attempts and changed request bodies.
// Keep the request fingerprint as evidence, never as part of the unique key.
const digest = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const claim = `INSERT INTO host_http_egress.m08_admission_spike
  (intent_key, first_attempt_id, request_fingerprint, owner_id)
  VALUES ($1, $2, $3, $4) ON CONFLICT (intent_key) DO NOTHING RETURNING owner_id`;
const args = (key: string, attempt: string, request: string, owner: string): string[] =>
  [key, attempt, digest(request), owner];
// Hash each scope component separately; slash-joined strings can alias distinct scopes.
type Scope = Readonly<{tenantId: string; projectId: string; deploymentId: string}>;
const scope: Scope = {tenantId: "tenant", projectId: "project", deploymentId: "deployment"};
const operationKey = (ownerScope: Scope, operation: string) =>
  digest(ownerScope.tenantId, ownerScope.projectId, ownerScope.deploymentId, operation);

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
      first_attempt_id text NOT NULL,
      request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
      owner_id text NOT NULL)`);
    const a = await first.connect(); const b = await second.connect();
    try {
      const [pidA, pidB] = await Promise.all([a.query("SELECT pg_backend_pid() AS pid"),
        b.query("SELECT pg_backend_pid() AS pid")]);
      assert.notEqual(pidA.rows[0]?.pid, pidB.rows[0]?.pid, "distinct PostgreSQL server backends");
      const key = operationKey(scope, "operation");
      const raced = await Promise.all([a.query(claim, args(key, "attempt", "request", "host-A")), b.query(claim, args(key, "attempt", "request", "host-B"))]);
      assert.deepEqual(raced.map(result => result.rowCount).toSorted(), [0, 1],
        "concurrent SQL claims must have exactly one durable winner");
      const original = await b.query("SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1",
        [key]);
      assert.equal(original.rowCount, 1);
      assert.ok(["host-A", "host-B"].includes(original.rows[0]?.owner_id));
      assert.equal((await a.query(claim, args(key, "new-attempt", "request", "restarted-host"))).rowCount, 0,
        "restarted Host cannot reacquire previously claimed intent");

      // A second SQL backend cannot win while the first owner holds an
      // uncommitted pre-effect claim. Lock contention is not an approval to
      // bypass admission; after the first COMMIT the rival still loses.
      const pendingKey = operationKey(scope, "pending-pre-effect");
      await a.query("BEGIN");
      try {
        assert.equal((await a.query(claim, args(pendingKey, "attempt", "request", "pending-host-A"))).rowCount, 1);
        await b.query("SET lock_timeout = '250ms'");
        try {
          await assert.rejects(b.query(claim, args(pendingKey, "attempt", "request", "racing-host-B")),
            (error: unknown) => error instanceof Error && "code" in error && error.code === "55P03",
            "competing pre-effect claim must not bypass an uncommitted owner");
        } finally {await b.query("RESET lock_timeout");}
        await a.query("COMMIT");
      } catch (error) {
        await a.query("ROLLBACK").catch(() => {});
        throw error;
      }
      assert.equal((await b.query(claim, args(pendingKey, "retry", "changed-request", "racing-host-B"))).rowCount, 0,
        "once the pending owner commits, neither retry nor request drift may reclaim the intent");
      const pendingWinner = await b.query(
        "SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1", [pendingKey]);
      assert.deepEqual(pendingWinner.rows.map(row => row.owner_id), ["pending-host-A"]);

      const unknownKey = operationKey(scope, "operation-unknown");
      await a.query("BEGIN");
      assert.equal((await a.query(claim, args(unknownKey, "attempt", "request", "host-A-before-ack-loss"))).rowCount, 1);
      await a.query("COMMIT");
      // Lost acknowledgement is simulated *after* a real committed transaction.
      let lostAck = false;
      try {throw new Error("simulated lost ACK");}
      catch (error) {lostAck = error instanceof Error && error.message === "simulated lost ACK";}
      assert.equal(lostAck, true);
      assert.equal((await b.query(claim, args(unknownKey, "new-attempt", "request", "host-B-after-unknown"))).rowCount, 0,
        "a lost COMMIT ACK cannot allow a second SQL winner");
      assert.equal((await b.query(claim,
        args(unknownKey, "another-attempt", "changed-request", "host-B-drifted-request"))).rowCount, 0,
        "changing both attempt and payload must not bypass operation-level UNKNOWN");
      const retained = await b.query(
        "SELECT owner_id, first_attempt_id, request_fingerprint FROM host_http_egress.m08_admission_spike WHERE intent_key=$1",
        [unknownKey]);
      assert.deepEqual(retained.rows.map(row => [row.owner_id, row.first_attempt_id, row.request_fingerprint]),
        [["host-A-before-ack-loss", "attempt", digest("request")]],
        "readback must preserve original owner, attempt and request fingerprint");
      const newOperation = operationKey(scope, "genuinely-new-operation");
      assert.equal((await b.query(claim, args(newOperation, "attempt", "request", "legitimate-owner"))).rowCount, 1,
        "an independent operation remains admissible; no false rejection");

      // Scope separation here proves only collision-free operation identity,
      // NOT tenant read isolation or RLS (this is a disposable SQL-only spike).
      for (const foreignScope of [
        {...scope, tenantId: "foreign-tenant"}, {...scope, projectId: "foreign-project"},
        {...scope, deploymentId: "foreign-deployment"},
      ]) {
        const foreignKey = operationKey(foreignScope, "operation");
        assert.notEqual(foreignKey, key, "different captured scope must have a different intent key");
        assert.equal((await b.query(claim, args(foreignKey, "attempt", "request", "foreign-owner"))).rowCount, 1,
          "a distinct scope can reserve the same operation ID independently");
        assert.equal((await a.query(claim, args(foreignKey, "new-attempt", "changed-request", "intruder"))).rowCount, 0,
          "a different attempt and payload cannot reclaim that scope's original intent");
      }
      assert.equal((await b.query(claim, args(key, "foreign-attempt", "request", "foreign-owner"))).rowCount, 0,
        "foreign-scope claims must not disturb the original scope's reservation");
      const slashA = {tenantId: "tenant/project", projectId: "deployment", deploymentId: "x"};
      const slashB = {tenantId: "tenant", projectId: "project/deployment", deploymentId: "x"};
      assert.equal(Object.values(slashA).join("/"), Object.values(slashB).join("/"),
        "adversarial scope tuples must collide under unsafe slash concatenation");
      const keyA = operationKey(slashA, "operation"); const keyB = operationKey(slashB, "operation");
      assert.notEqual(keyA, keyB, "component-framed scope identity must not alias");
      assert.equal((await a.query(claim, args(keyA, "attempt", "request", "slash-A"))).rowCount, 1);
      assert.equal((await b.query(claim, args(keyB, "attempt", "request", "slash-B"))).rowCount, 1,
        "distinct tenant/project tuples must not suppress each other's valid operation");
    } finally {a.release(); b.release();}
    // A claim in a transaction that dies BEFORE any provider effect must
    // roll back. This is distinct from a committed UNKNOWN claim: only the
    // demonstrably uncommitted reservation can be reacquired.
    const crashed = new Client({connectionString: databaseUrl, connectionTimeoutMillis: 5_000});
    crashed.on("error", () => {}); // The backend is deliberately terminated below.
    await crashed.connect();
    try {
      const abortKey = operationKey(scope, "aborted-before-effect");
      await crashed.query("BEGIN");
      assert.equal((await crashed.query(claim, args(abortKey, "attempt", "request", "aborted-host"))).rowCount, 1);
      const backendPid = (await crashed.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      assert.equal(typeof backendPid, "number");
      const stopped = await second.query("SELECT pg_terminate_backend($1) AS stopped", [backendPid]);
      assert.equal(stopped.rows[0]?.stopped, true, "disposable checked-out SQL backend was killed");
      const recovery = await Promise.all([
        first.query(claim, args(abortKey, "new-attempt-A", "request", "recovery-host-A")),
        second.query(claim, args(abortKey, "new-attempt-B", "request", "recovery-host-B")),
      ]);
      assert.deepEqual(recovery.map(result => result.rowCount).toSorted(), [0, 1],
        "after a verified pre-effect rollback, concurrent recovery admits exactly one owner");
      const recovered = await second.query(
        "SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1", [abortKey]);
      assert.equal(recovered.rowCount, 1);
      assert.ok(["recovery-host-A", "recovery-host-B"].includes(recovered.rows[0]?.owner_id),
        "recovery must preserve the one committed owner");
      assert.equal((await first.query(claim, args(abortKey, "another-attempt", "request", "second-recovery"))).rowCount, 0,
        "a durable recovery winner must deny further attempts");
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
      const durableKey = operationKey(scope, "committed-before-crash");
      await committed.query("BEGIN");
      assert.equal((await committed.query(claim, args(durableKey, "attempt", "request", "committed-owner"))).rowCount, 1);
      await committed.query("COMMIT");
      const backendPid = (await committed.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      assert.equal(typeof backendPid, "number");
      const stopped = await second.query("SELECT pg_terminate_backend($1) AS stopped", [backendPid]);
      assert.equal(stopped.rows[0]?.stopped, true, "committed SQL backend was killed");
      const blocked = await Promise.all([
        first.query(claim, args(durableKey, "new-attempt", "request", "post-crash-owner-A")),
        second.query(claim, args(durableKey, "drifted-attempt", "changed-request", "post-crash-owner-B")),
      ]);
      assert.deepEqual(blocked.map(result => result.rowCount), [0, 0],
        "both same-request and drifted concurrent retries must reject a committed UNKNOWN intent");
      const retained = await second.query(
        "SELECT owner_id FROM host_http_egress.m08_admission_spike WHERE intent_key=$1", [durableKey]);
      assert.deepEqual(retained.rows.map(row => row.owner_id), ["committed-owner"],
        "actual post-crash readback must preserve the original durable winner");
    } finally {
      await committed.end().catch(() => {});
    }
  } finally {await Promise.all([first.end(), second.end()]);}
};
