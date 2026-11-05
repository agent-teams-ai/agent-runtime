import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {Pool} from "pg";
import {migrateInteractiveSessionStore, verifyInteractiveSessionStore, PostgresInteractiveSessionStore, type InteractivePostgresClient} from "../../../dist/features/interactive-agent-session/adapters/outbound/postgres-session-store.js";
import {fixture, open, ref} from "./support.ts";

type ErrorListener = (error: Error) => void;
function observable(operations: Pick<InteractivePostgresClient, "query" | "release">, listeners = new Set<ErrorListener>()) {
  return {...operations, listeners,
    on: (_event: "error", listener: ErrorListener) => {listeners.add(listener);},
    removeListener: (_event: "error", listener: ErrorListener) => {listeners.delete(listener);},
  };
}

async function record() {const f = fixture(); await open(f); const current = (await f.store.read(ref))!; return {...current, status: "opening" as const, revision: 0};}

test("construction does not migrate; migration is explicit and borrows its pool", async () => {
  const calls: string[] = []; let releases = 0;
  const client = observable({query: async config => {calls.push(config.text); return {rows: [], rowCount: 0};}, release: () => {releases++;}});
  const pool = {connect: async () => client}; const store = new PostgresInteractiveSessionStore(pool);
  assert.ok(store);
  assert.equal(calls.length, 0);
  await migrateInteractiveSessionStore(pool);
  assert.match(calls[0]!, /CREATE TABLE IF NOT EXISTS interactive_session_v1/u); assert.equal(releases, 1);
});

test("existing schema missing, weakened or unvalidated CHECK constraints is held before adoption", async () => {
  const columns = ["tenant_id", "project_id", "session_id", "generation", "revision", "state"]
    .map((name, index) => ({name, type: index === 3 || index === 4 ? "bigint" : index === 5 ? "jsonb" : "text", required: true}));
  const healthy = [{expression: "(generation > 0)", definition: "CHECK ((generation > 0))", validated: true}, {expression: "(revision >= 0)", definition: "CHECK ((revision >= 0))", validated: true}];
  const cases = [
    [],
    [healthy[0]!],
    [{...healthy[0]!, expression: "(generation >= 0)"}, healthy[1]!],
    [{...healthy[0]!, validated: false}, healthy[1]!],
    [{...healthy[0]!, definition: "CHECK ((generation > 0)) NOT ENFORCED"}, healthy[1]!],
    [healthy[0]!, healthy[0]!],
    [...healthy, {expression: "(revision < 10)", validated: true}],
  ];
  for (const checks of cases) {
    const calls: string[] = []; let releases = 0;
    const client = observable({query: async config => {
      calls.push(config.text);
      const rows = config.text.includes("FROM pg_attribute") ? columns
        : config.text.includes("contype='p'") ? [{definition: "PRIMARY KEY (tenant_id, project_id, session_id)"}]
        : config.text.includes("contype='c'") ? checks : [];
      return {rows, rowCount: rows.length};
    }, release: () => {releases++;}});
    await assert.rejects(verifyInteractiveSessionStore({connect: async () => client}), /interactive_schema_checks_invalid/u);
    assert.equal(calls.length, 3, "verification is read-only and bounded");
    assert.equal(releases, 1);
  }
});

test("lost COMMIT response returns unknown without readback or retry and discards uncertain connection", async () => {
  const calls: string[] = []; const releases: (boolean | undefined)[] = [];
  const client = observable({query: async config => {
    calls.push(config.text); if (config.text === "COMMIT") {throw new Error("TEST response lost");}
    return {rows: [], rowCount: 1};
  }, release: discard => {releases.push(discard);}});
  const store = new PostgresInteractiveSessionStore({connect: async () => client});
  assert.equal(await store.create(await record()), "unknown");
  assert.equal(calls.filter(sql => sql.startsWith("INSERT")).length, 1);
  assert.equal(calls.at(-1), "COMMIT"); assert.deepEqual(releases, [true]);
});

test("failure before commit rolls back; failed rollback discards the connection and preserves the original failure", async () => {
  const calls: string[] = []; const original = new Error("TEST write failed"); let discarded = false;
  const client = observable({query: async config => {
    calls.push(config.text);
    if (config.text.startsWith("INSERT")) {throw original;}
    if (config.text === "ROLLBACK") {throw new Error("TEST rollback failed");}
    return {rows: [], rowCount: 0};
  }, release: discard => {discarded = discard === true;}});
  const store = new PostgresInteractiveSessionStore({connect: async () => client});
  await assert.rejects(store.create(await record()), error => error === original);
  assert.equal(calls.at(-1), "ROLLBACK"); assert.equal(discarded, true); assert.ok(!calls.includes("COMMIT"));
});

test("CAS rejects a cross-scope record or a resurrection before issuing SQL", async () => {
  let connections = 0;
  const store = new PostgresInteractiveSessionStore({connect: async () => {connections++; throw new Error("must not connect");}});
  const before = await record();
  assert.throws(() => store.compareAndSwap(before, {...before, tenantId: "foreign", revision: 1}));
  assert.throws(() => store.compareAndSwap(before, {...before, generation: 2, revision: 1}));
  assert.equal(connections, 0);
});

for (const missing of ["on", "removeListener"]) {
  test(`missing required checked-out error registration fails closed: ${missing}`, async () => {
    let queries = 0; const releases: (boolean | undefined)[] = [];
    const client = observable({query: async () => {queries++; return {rows: [], rowCount: 0};}, release: discard => {releases.push(discard);}});
    Reflect.deleteProperty(client, missing);
    await assert.rejects(migrateInteractiveSessionStore({connect: async () => client}), /interactive_store_acquisition_failed/u);
    assert.equal(queries, 0); assert.deepEqual(releases, [true]);
  });
}

test("checked-out error after a query rejects safely, discards and removes only its listener", async () => {
  const listeners = new Set<ErrorListener>(); const external = () => {assert.ok(listeners.size > 0);}; listeners.add(external);
  const releases: (boolean | undefined)[] = []; const calls: string[] = [];
  const client = observable({query: async config => {
    calls.push(config.text); for (const listener of listeners) {listener(new Error("TEST checked-out failure"));}
    return {rows: [], rowCount: 0};
  }, release: discard => {assert.equal(listeners.size, 2, "guard owns errors through release"); releases.push(discard);}}, listeners);
  await assert.rejects(new PostgresInteractiveSessionStore({connect: async () => client}).read(ref), /interactive_store_connection_failed/u);
  assert.equal(calls.length, 1); assert.deepEqual(releases, [true]); assert.deepEqual([...listeners], [external]);
});

test("checked-out failure during COMMIT remains unknown without replay and cleans registration", async () => {
  const listeners = new Set<ErrorListener>(); const calls: string[] = []; const releases: (boolean | undefined)[] = [];
  const client = observable({query: async config => {
    calls.push(config.text); if (config.text === "COMMIT") {for (const listener of listeners) {listener(new Error("TEST commit socket lost"));}}
    return {rows: [], rowCount: 1};
  }, release: discard => {releases.push(discard);}}, listeners);
  assert.equal(await new PostgresInteractiveSessionStore({connect: async () => client}).create(await record()), "unknown");
  assert.equal(calls.filter(sql => sql.startsWith("INSERT")).length, 1); assert.equal(calls.at(-1), "COMMIT");
  assert.deepEqual(releases, [true]); assert.equal(listeners.size, 0);
});

for (const phase of ["read", "migration"] as const) {
  test(`socket fault during release fails closed after a successful ${phase} query`, async () => {
    const listeners = new Set<ErrorListener>(); let releases = 0;
    const client = observable({query: async () => ({rows: [], rowCount: 0}), release: () => {
      releases++;
      for (const listener of listeners) {listener(new Error("TEST release socket fault"));}
    }}, listeners);
    const pool = {connect: async () => client};
    const action = phase === "read" ? new PostgresInteractiveSessionStore(pool).read(ref) : migrateInteractiveSessionStore(pool);
    await assert.rejects(action, /interactive_store_connection_failed/u);
    assert.equal(releases, 1, "custody must transfer once");
    assert.equal(listeners.size, 0, "the adapter's listener is removed after transfer");
  });
}

test("release-time socket fault after COMMIT yields unknown and never replays the write", async () => {
  const listeners = new Set<ErrorListener>(); const queries: string[] = []; let releases = 0;
  const client = observable({query: async config => {
    queries.push(config.text); return {rows: [], rowCount: 1};
  }, release: () => {
    releases++;
    for (const listener of listeners) {listener(new Error("TEST late COMMIT socket fault"));}
  }}, listeners);
  const store = new PostgresInteractiveSessionStore({connect: async () => client});
  assert.equal(await store.create(await record()), "unknown");
  assert.equal(queries.filter(sql => sql.startsWith("INSERT")).length, 1);
  assert.equal(queries.filter(sql => sql === "COMMIT").length, 1);
  assert.equal(releases, 1); assert.equal(listeners.size, 0);
});

test("throwing release after COMMIT preserves unknown and the error guard", async () => {
  const listeners = new Set<ErrorListener>(); const queries: string[] = []; let releases = 0;
  const client = observable({query: async config => {
    queries.push(config.text); return {rows: [], rowCount: 1};
  }, release: () => {releases++; throw new Error("TEST ownership transfer unproved");}}, listeners);
  const store = new PostgresInteractiveSessionStore({connect: async () => client});
  assert.equal(await store.create(await record()), "unknown");
  assert.equal(queries.filter(sql => sql === "COMMIT").length, 1);
  assert.equal(releases, 1); assert.equal(listeners.size, 1, "guard stays when transfer is unproved");
});

test("failed write preserves its original error when release also throws before COMMIT", async () => {
  const original = new Error("TEST insert rejected");
  const listeners = new Set<ErrorListener>(); const queries: string[] = [];
  const client = observable({query: async config => {
    queries.push(config.text);
    if (config.text.startsWith("INSERT")) {throw original;}
    return {rows: [], rowCount: 1};
  }, release: () => {throw new Error("TEST release failed");}}, listeners);
  const store = new PostgresInteractiveSessionStore({connect: async () => client});
  await assert.rejects(store.create(await record()), error => error === original);
  assert.equal(queries.filter(sql => sql === "ROLLBACK").length, 1);
  assert.equal(queries.filter(sql => sql === "COMMIT").length, 0);
  assert.equal(listeners.size, 1, "guard stays when transfer is unproved");
});

test("a throwing release does not remove the guard before client custody is transferred", async () => {
  const listeners = new Set<ErrorListener>();
  const client = observable({query: async () => ({rows: [], rowCount: 0}), release: () => {throw new Error("TEST release failed");}}, listeners);
  await assert.rejects(migrateInteractiveSessionStore({connect: async () => client}), /TEST release failed/u);
  assert.equal(listeners.size, 1); assert.doesNotThrow(() => {for (const listener of listeners) {listener(new Error("TEST late failure"));}});
});

test("CI disposable PostgreSQL checks actual interactive session constraints", {
  skip: process.env.POSTGRES_DURABILITY_URL === undefined,
}, async () => {
  // The existing isolated PostgreSQL qualification runner passes only an explicit
  // disposable target URL into its child; never use ambient or a user database.
  const databaseUrl = process.env.POSTGRES_DURABILITY_URL;
  assert.ok(databaseUrl);
  const target = new URL(databaseUrl);
  assert.equal(target.protocol, "postgresql:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "5432");
  assert.equal(target.pathname, "/contained_turn_test");

  const admin = new Pool({connectionString: databaseUrl});
  const schema = `test_interactive_schema_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    const observed = await admin.query("SELECT current_database() AS name");
    assert.equal(observed.rows[0]?.name, "contained_turn_test");
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`});
    try {
      await assert.rejects(verifyInteractiveSessionStore(pool), /interactive_schema_columns_invalid/u);
      await migrateInteractiveSessionStore(pool);
      await verifyInteractiveSessionStore(pool);
      await pool.query("ALTER TABLE interactive_session_v1 DROP CONSTRAINT interactive_session_v1_generation_check");
      await assert.rejects(verifyInteractiveSessionStore(pool), /interactive_schema_checks_invalid/u);
      await pool.query("ALTER TABLE interactive_session_v1 ADD CONSTRAINT interactive_session_v1_generation_check CHECK (generation >= 0)");
      await assert.rejects(verifyInteractiveSessionStore(pool), /interactive_schema_checks_invalid/u);
      await pool.query("ALTER TABLE interactive_session_v1 DROP CONSTRAINT interactive_session_v1_generation_check");
      await pool.query("ALTER TABLE interactive_session_v1 ADD CONSTRAINT interactive_session_v1_generation_check CHECK (generation > 0)");
      await pool.query("ALTER TABLE interactive_session_v1 DROP CONSTRAINT interactive_session_v1_revision_check");
      await pool.query("ALTER TABLE interactive_session_v1 ADD CONSTRAINT interactive_session_v1_revision_check CHECK (revision >= 0) NOT VALID");
      await assert.rejects(verifyInteractiveSessionStore(pool), /interactive_schema_checks_invalid/u);
      await pool.query("ALTER TABLE interactive_session_v1 VALIDATE CONSTRAINT interactive_session_v1_revision_check");
      await verifyInteractiveSessionStore(pool);
      await pool.query("ALTER TABLE interactive_session_v1 DROP CONSTRAINT interactive_session_v1_generation_check");
      await pool.query("ALTER TABLE interactive_session_v1 ADD CONSTRAINT interactive_session_v1_generation_check CHECK (generation > 0) NOT ENFORCED");
      await assert.rejects(verifyInteractiveSessionStore(pool), /interactive_schema_checks_invalid/u);
      await pool.query("ALTER TABLE interactive_session_v1 DROP CONSTRAINT interactive_session_v1_generation_check");
      await pool.query("ALTER TABLE interactive_session_v1 ADD CONSTRAINT interactive_session_v1_generation_check CHECK (generation > 0)");
      await verifyInteractiveSessionStore(pool);
    } finally {await pool.end();}
  } finally {
    try {if (created) {await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}
    finally {await admin.end();}
  }
});
