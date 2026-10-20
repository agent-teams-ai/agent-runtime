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
      }, release: discard => client.release(discard)};
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
