import assert from "node:assert/strict";
import test from "node:test";
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
  const healthy = [{expression: "(generation > 0)", validated: true}, {expression: "(revision >= 0)", validated: true}];
  const cases = [
    [],
    [healthy[0]!],
    [{...healthy[0]!, expression: "(generation >= 0)"}, healthy[1]!],
    [{...healthy[0]!, validated: false}, healthy[1]!],
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

test("a throwing release does not remove the guard before client custody is transferred", async () => {
  const listeners = new Set<ErrorListener>();
  const client = observable({query: async () => ({rows: [], rowCount: 0}), release: () => {throw new Error("TEST release failed");}}, listeners);
  await assert.rejects(migrateInteractiveSessionStore({connect: async () => client}), /TEST release failed/u);
  assert.equal(listeners.size, 1); assert.doesNotThrow(() => {for (const listener of listeners) {listener(new Error("TEST late failure"));}});
});
