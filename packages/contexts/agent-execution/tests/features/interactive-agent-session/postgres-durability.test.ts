import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {basename, join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {migrateInteractiveSessionStore, verifyInteractiveSessionStore, PostgresInteractiveSessionStore, type InteractivePostgresPool} from "../../../dist/features/interactive-agent-session/adapters/outbound/postgres-session-store.js";
import {InteractiveSessionOwner} from "../../../dist/features/interactive-agent-session/application/use-cases/interactive-session-owner.js";
import {fixture, open, ref, submit} from "./support.ts";

const exec = promisify(execFile);

test("owned PostgreSQL restart preserves admission and unknown dispatch; no provider replay and CAS remains scoped", async () => {
  const root = process.env.TEST_INTERACTIVE_PG_ROOT;
  assert.ok(root && resolve(root) === root && basename(root).startsWith("TEST-interactive-pg."), "requires an explicitly owned disposable cluster");
  const port = Number(process.env.TEST_INTERACTIVE_PG_PORT);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  const schema = `interactive_test_${randomUUID().replaceAll("-", "")}`;
  const config = {host: join(root, "socket"), port, database: "postgres", connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema}`};
  let pool = new Pool(config);
  try {
    const identity = await pool.query("SHOW data_directory");
    assert.equal(identity.rows[0].data_directory, join(root, "data"), "never operate against a user database");
    await pool.query(`CREATE SCHEMA ${schema}`);
    await assert.rejects(verifyInteractiveSessionStore(pool), /interactive_schema_columns_invalid/);
    await migrateInteractiveSessionStore(pool);
    await verifyInteractiveSessionStore(pool);
    let loseCommit = false;
    const transport: InteractivePostgresPool = {connect: async () => {
      const client = await pool.connect();
      return {query: async query => {
        const result = await client.query(query);
        if (query.text === "COMMIT" && loseCommit) {loseCommit = false; throw new Error("TEST commit acknowledgement lost");}
        return result;
      }, release: discard => client.release(discard),
      on: (event, listener) => {client.on(event, listener);}, removeListener: (event, listener) => {client.removeListener(event, listener);}};
    }};
    const store = new PostgresInteractiveSessionStore(transport);
    const f = fixture(store); await open(f);
    const admitted = await submit(f);
    const replay = await f.owner.submit(ref, {commandId: "command-1", inputId: "input-1", content: "private TEST prompt 1"});
    assert.equal(replay.status, "duplicate"); assert.deepEqual(replay.receipt, admitted);
    loseCommit = true;
    assert.equal((await f.owner.dispatch(ref)).status, "unknown"); assert.deepEqual(f.calls.handoffs, []);
    assert.equal((await store.read(ref))!.inputs[0]!.delivery, "dispatching");
    await pool.end();
    await exec("/opt/homebrew/bin/pg_ctl", ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-m", "fast", "-w", "restart"], {timeout: 20000});
    pool = new Pool(config);
    await verifyInteractiveSessionStore(pool);
    const restartedStore = new PostgresInteractiveSessionStore(pool);
    const restartedFixture = fixture(restartedStore);
    const restarted = new InteractiveSessionOwner(restartedFixture.deps);
    assert.equal((await restarted.recover(ref)).status, "unknown");
    assert.equal((await restarted.read(ref))!.status, "reconcile_required");
    assert.equal((await restarted.dispatch(ref)).status, "unavailable");
    assert.equal(restartedFixture.calls.opened, 0); assert.deepEqual(restartedFixture.calls.handoffs, []);
    assert.equal(await restartedStore.read({...ref, tenantId: "foreign"}), undefined);
    const current = (await restartedStore.read(ref))!;
    const results = await Promise.all([
      restartedStore.compareAndSwap(current, {...current, revision: current.revision + 1}),
      restartedStore.compareAndSwap(current, {...current, revision: current.revision + 1}),
    ]);
    assert.deepEqual(results.toSorted(), ["conflict", "written"]);
    assert.equal((await restartedStore.read(ref))!.revision, current.revision + 1);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});

for (const mode of ["read", "write", "migration", "verification"] as const) {
  test(`checked-out PostgreSQL backend termination is contained during ${mode}`, async () => {
    const root = process.env.TEST_INTERACTIVE_PG_ROOT;
    assert.ok(root && resolve(root) === root && basename(root).startsWith("TEST-interactive-pg."), "requires an explicitly owned disposable cluster");
    const port = Number(process.env.TEST_INTERACTIVE_PG_PORT);
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
    const schema = `interactive_disconnect_${randomUUID().replaceAll("-", "")}`;
    const config = {host: join(root, "socket"), port, database: "postgres", connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema}`};
    const pool = new Pool(config); const control = new Pool(config);
    let releaseDiscard: boolean | undefined; let borrowedListenerCount = -1; let listenerRemoved = false; let interrupted = false;
    const statements: string[] = [];
    try {
      assert.equal((await control.query("SHOW data_directory")).rows[0].data_directory, join(root, "data"));
      await control.query(`CREATE SCHEMA ${schema}`); await migrateInteractiveSessionStore(pool);
      const transport: InteractivePostgresPool = {connect: async () => {
        const client = await pool.connect(); const pid = (await client.query<{pid: number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        const ended = new Promise<void>(_resolve => {client.once("end", _resolve);});
        return {
          query: async query => {
            statements.push(query.text); const result = await client.query(query);
            if (!interrupted) {
              interrupted = true; borrowedListenerCount = client.listenerCount("error");
              assert.equal(borrowedListenerCount, 1, "the adapter owns the actual checked-out error listener");
              assert.equal((await control.query<{terminated: boolean}>("SELECT pg_terminate_backend($1) AS terminated", [pid])).rows[0]!.terminated, true);
              await ended;
            }
            return result;
          },
          on: (event, listener) => {client.on(event, listener);},
          removeListener: (event, listener) => {client.removeListener(event, listener); listenerRemoved = !client.listeners("error").includes(listener);},
          release: discard => {releaseDiscard = discard; client.release(discard);},
        };
      }};
      const store = new PostgresInteractiveSessionStore(transport);
      const opening = {...(await recordForDisconnect()), status: "opening" as const, revision: 0};
      const operation = mode === "read" ? store.read(ref) : mode === "write" ? store.create(opening)
        : mode === "migration" ? migrateInteractiveSessionStore(transport) : verifyInteractiveSessionStore(transport);
      await assert.rejects(operation, /interactive_store_connection_failed/u);
      assert.equal(releaseDiscard, true); assert.equal(borrowedListenerCount, 1);
      assert.equal(listenerRemoved, true, "only this adapter registration is removed after release");
      assert.ok(!statements.includes("COMMIT"), "a dead client cannot start a new commit");
      assert.equal((await pool.query("SELECT 1 AS alive")).rows[0].alive, 1, "next borrower uses a healthy client");
      assert.equal((await pool.query("SELECT count(*)::text AS count FROM interactive_session_v1")).rows[0].count, "0");
    } finally {await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await Promise.all([pool.end(), control.end()]);}
  });
}
async function recordForDisconnect() {
  const f = fixture(); await open(f); const current = (await f.store.read(ref))!; return current;
}
