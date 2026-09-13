import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHarness, deferred, grant, input, seeded, settlement, unavailable } from "./postgres-dispatch.fixtures.ts";

test("late acquisition is released once and never begins work", async () => {
  const f = createHarness(undefined, { connectTimeoutMs: 15 });
  const acquired = deferred();
  f.db.connectHook = async () => acquired.promise;
  assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
  assert.equal(f.db.events.length, 0);
  assert.equal(f.db.clients[0]?.releaseCount, 0);
  acquired.resolve();
  await new Promise(resolve => {setImmediate(resolve);});
  assert.equal(f.db.clients[0]?.discarded, true);
  f.db.assertReleased();
});

for (const [name, pattern] of [
  ["BEGIN", /^BEGIN/u],
  ["server deadlines", /set_config/u],
  ["schema version", /SELECT version/u],
  ["absent identity lock", /pg_advisory_xact_lock/u],
  ["current authority", /^SELECT operation_key/u],
  ["grant request", /FROM runtime_security_dispatch_v1.consume_requests WHERE/u],
  ["operation consumption", /^SELECT c.operation_key/u],
  ["request write", /^INSERT INTO runtime_security_dispatch_v1.consume_requests/u],
  ["receipt write", /^INSERT INTO runtime_security_dispatch_v1.consumptions/u],
  ["COMMIT", /^COMMIT$/u],
] as const) {
  test(`${name} deadline discards the in-flight connection without queued rollback or retry`, async () => {
    const seed = await seeded();
    const f = createHarness(seed.db, { queryTimeoutMs: 15 });
    const stalled = deferred();
    const before = f.db.clients.length;
    let stage = "";
    f.db.hook = async (_client, sql, _values, execute) => {
      if (pattern.test(sql)) {stage = sql; await stalled.promise; throw new Error("late failure");}
      return execute();
    };
    assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
    assert.ok(stage);
    assert.equal(f.db.clients.length, before + 1);
    assert.equal(f.db.clients.at(-1)?.discarded, true);
    assert.equal(f.db.events.at(-1)?.sql, stage);
    assert.equal(f.db.tables.consumptions.size, 0);
    stalled.resolve();
    await new Promise(resolve => {setImmediate(resolve);});
    f.db.assertReleased();
  });
}

test("ROLLBACK has its own bounded wait and discards on timeout", async () => {
  const seed = await seeded();
  const f = createHarness(seed.db, { queryTimeoutMs: 15 });
  const stalled = deferred();
  f.db.hook = async (_client, sql, _values, execute) => {
    if (sql.startsWith("INSERT INTO runtime_security_dispatch_v1.consumptions")) {throw new Error("write rejected");}
    if (sql === "ROLLBACK") {await stalled.promise; throw new Error("late rollback failure");}
    return execute();
  };
  assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
  assert.equal(f.db.events.at(-1)?.sql, "ROLLBACK");
  assert.equal(f.db.clients.at(-1)?.discarded, true);
  assert.equal(f.db.tables.consume_requests.size, 0);
  stalled.resolve();
  await new Promise(resolve => {setImmediate(resolve);});
  f.db.assertReleased();
});

test("total transaction deadline bounds many individually timely queries", async () => {
  const seed = await seeded();
  const f = createHarness(seed.db, { queryTimeoutMs: 200, transactionTimeoutMs: 25 });
  f.db.hook = async (_client, _sql, _values, execute) => {await delay(8); return execute();};
  let callbacks = 0;
  await assert.rejects(f.repository.consumeAtomically(grant(), () => {
    callbacks += 1; return { outcome: { status: "not_found" } };
  }));
  assert.equal(callbacks, 0);
  assert.equal(f.db.clients.at(-1)?.discarded, true);
  await delay(12);
  f.db.assertReleased();
});

test("a fresh consumed outcome waits for acknowledgement of COMMIT", async () => {
  const f = await seeded();
  const atCommit = deferred();
  const acknowledge = deferred();
  f.db.hook = async (_client, sql, _values, execute) => {
    if (sql === "COMMIT") {atCommit.resolve(); await acknowledge.promise;}
    return execute();
  };
  let resolved = false;
  const pending = f.api.consumeForDispatch(input()).then(result => {resolved = true; return result;});
  await atCommit.promise;
  assert.equal(resolved, false);
  assert.equal(f.db.tables.consumptions.size, 0);
  acknowledge.resolve();
  assert.equal((await pending).status, "consumed");
  f.db.assertReleased();
});

test("commit may succeed after observation timed out; no retry and immutable replay recover it", async () => {
  const seed = await seeded();
  const f = createHarness(seed.db, { queryTimeoutMs: 15 });
  const stalled = deferred();
  f.db.hook = async (_client, sql, _values, execute) => {
    const value = await execute();
    if (sql === "COMMIT") {await stalled.promise;}
    return value;
  };
  assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
  assert.equal(f.db.tables.consumptions.size, 1);
  assert.equal(f.db.clients.at(-1)?.discarded, true);
  stalled.resolve();
  f.db.hook = undefined;
  const restarted = createHarness(f.db);
  const replay = await restarted.api.consumeForDispatch(input());
  assert.equal(replay.status, "consumed");
  assert.equal(f.db.tables.consumptions.size, 1);
  f.db.assertReleased();
});

for (const stage of ["acquire", "read", "commit"] as const) {
  test(`close during ${stage} seals callbacks, bounds waits and leaves pool ownership with caller`, async () => {
    const f = await seeded();
    const entered = deferred();
    const resume = deferred();
    let callbacks = 0;
    if (stage === "acquire") {
      f.db.connectHook = async () => {entered.resolve(); await resume.promise;};
    } else {
      f.db.hook = async (_client, sql, _values, execute) => {
        if (stage === "read" ? sql.startsWith("SELECT c.operation_key") : sql === "COMMIT") {
          entered.resolve(); await resume.promise; throw new Error("closed query");
        }
        return execute();
      };
    }
    const pending = f.repository.consumeAtomically(grant(), () => {
      callbacks += 1;
      return { outcome: { status: "indeterminate", reason: "owner_unavailable" } };
    });
    await entered.promise;
    f.repository.close();
    f.repository.close();
    await assert.rejects(pending);
    assert.equal(callbacks, stage === "commit" ? 1 : 0);
    const calls = f.db.clients.length;
    assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
    assert.deepEqual(await f.api.observeDispatchConsumption(input()), unavailable);
    assert.deepEqual(await f.api.settleDispatchConsumption(settlement("missing")), unavailable);
    await assert.rejects(f.repository.migrate());
    assert.equal(f.db.clients.length, calls);
    resume.resolve();
    await new Promise(resolve => {setImmediate(resolve);});
    f.db.connectHook = undefined;
    f.db.hook = undefined;
    assert.equal((await createHarness(f.db).api.consumeForDispatch(input())).status, "consumed");
    f.db.assertReleased();
  });
}

test("settlement write timeout cannot publish a settled result or change the receipt", async () => {
  const seed = await seeded();
  const f = createHarness(seed.db, { queryTimeoutMs: 15 });
  const consumed = await f.api.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const bytes = [...f.db.tables.consumptions.values()][0]?.receipt;
  const stalled = deferred();
  f.db.hook = async (_client, sql, _values, execute) => {
    if (sql.startsWith("INSERT INTO runtime_security_dispatch_v1.settlement_requests")) {
      await stalled.promise; throw new Error("late write");
    }
    return execute();
  };
  assert.deepEqual(await f.api.settleDispatchConsumption(settlement(consumed.receipt.consumptionDigest)), unavailable);
  assert.equal(f.db.tables.settlement_requests.size, 0);
  assert.equal([...f.db.tables.consumptions.values()][0]?.receipt, bytes);
  stalled.resolve();
  await new Promise(resolve => {setImmediate(resolve);});
  f.db.assertReleased();
});
