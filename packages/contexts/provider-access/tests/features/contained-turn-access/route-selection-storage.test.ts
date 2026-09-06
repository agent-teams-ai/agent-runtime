import assert from "node:assert/strict";
import test from "node:test";
import { deferred, harness, selection } from "./route-selection-fixture.ts";

const turn = () => new Promise<void>(resolve => {setImmediate(resolve);});

test("explicit migration is separately versioned and idempotent; ordinary reads perform no DDL or inserts", async () => {
  const h = await harness(); h.state.migrated = false; const owner = h.owner();
  assert.equal(await owner.readCurrent(), undefined);
  assert.equal(h.calls.some(({sql}) => /INSERT|CREATE|UPDATE|DELETE/u.test(sql)), false);
  await owner.control.migrate(); await owner.control.migrate();
  assert.equal(h.calls.filter(({sql}) => sql.includes("CREATE TABLE provider_access.route_selection")).length, 1);
  assert.equal(h.state.rows.length, 0);
  const ddl = h.calls.find(({sql}) => sql.includes("CREATE TABLE provider_access.route_selection"))!.sql;
  assert.match(ddl, /PRIMARY KEY \(owner_id, binding_revision\)/u);
  assert.match(ddl, /BEFORE UPDATE OR DELETE/u);
  assert.match(ddl, /REFERENCES provider_access.materialization_owner/u);
  assert.equal((ddl.match(/BETWEEN 1 AND 9007199254740991/gu) ?? []).length, 2);
  assert.equal(await owner.readCurrent(), undefined); owner.dispose();
});

test("schema mismatch, insert acknowledgement mismatch and outage never publish endorsement", async () => {
  for (const insertCount of [0, null, 2]) {
    const h = await harness(); const owner = h.owner(); h.state.insertCount = insertCount;
    await assert.rejects(owner.control.endorse(1), /acknowledgement/u);
    assert.equal(h.state.rows.length, 0, "transaction rolled back"); owner.dispose();
  }
  for (const condition of ["schemaBad", "unavailable", "duplicateHead"] as const) {
    const h = await harness(); const owner = h.owner(); await owner.control.endorse(1);
    h.state[condition] = true; assert.equal(await owner.readCurrent(), undefined);
    await assert.rejects(owner.control.endorse(1)); owner.dispose();
  }
  const h = await harness(); const owner = h.owner(); h.state.migrated = false; h.state.insertCount = 0;
  await assert.rejects(owner.control.migrate(), /acknowledgement/u); owner.dispose();
});

test("invalid head generations and CAS expectations fail closed", async () => {
  const h = await harness(); const owner = h.owner();
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(owner.control.endorse(version), /head version/u);
  }
  assert.equal(h.connects(), 0);
  for (const headVersion of ["0", "-1", "01", "1.5", "9007199254740992"]) {
    h.state.headVersion = headVersion;
    assert.equal(await owner.readCurrent(), undefined); await assert.rejects(owner.control.endorse(1));
  }
  const max = Number.MAX_SAFE_INTEGER;
  const upper = {...h.input, binding: {...h.input.binding, bindingRevision: max, credentialGeneration: max}};
  h.state.headVersion = String(max); h.state.binding = upper.binding;
  const bounded = h.owner(upper); assert.equal((await bounded.control.endorse(max)).routeGeneration, String(max));
  owner.dispose(); bounded.dispose();
});

test("a historical row with foreign identity or malformed recipe cannot admit a later endorsement", async () => {
  const h = await harness(); const one = h.owner(); const store = h.store(); await one.control.endorse(1);
  const original = structuredClone(h.state.rows[0]!); const saved = original.endorsement as Record<string, unknown>;
  const nextInput = {...h.input, binding: {...h.input.binding, bindingRevision: 2}};
  await store.replaceBinding(nextInput.binding, 1); const two = h.owner(nextInput);
  const corruptions = [
    {...saved, binding: {...h.input.binding, tenantId: "foreign"}}, {...saved, recipe: "unknown"},
    {...saved, routeAuthorityDigest: "sha256:forged"}, {...saved, routeGeneration: "2"},
    {...saved, descriptor: {...h.input.descriptor, originHost: "evil.example"}}, {...saved, extra: "field"},
  ];
  for (const endorsement of corruptions) {
    h.state.rows[0] = {...original, endorsement};
    await assert.rejects(two.control.endorse(2)); assert.equal(h.state.rows.length, 1);
  }
  h.state.rows[0] = original; await two.control.endorse(2);
  one.dispose(); two.dispose(); store.dispose();
});

test("lost commit acknowledgement rejects with no retry; next explicit observation recovers durable fact", async () => {
  const h = await harness(); const owner = h.owner(); let fail = true;
  h.setHook(async sql => {if (sql === "COMMIT" && fail) {fail = false; throw new Error("Synthetic commit acknowledgement lost");}});
  await assert.rejects(owner.control.endorse(1), /indeterminate/u);
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.calls.filter(({sql}) => sql === "COMMIT").length, 1);
  assert.deepEqual(h.releases, [true]);
  assert.ok(await owner.readCurrent()); owner.dispose();
});

test("abort while waiting for the locked head never inserts, and abort is one-way", async () => {
  const controller = new AbortController(); const h = await harness({...selection(), operationAbortSignal: controller.signal});
  const owner = h.owner(); const entered = deferred<void>(); const release = deferred<void>();
  h.setHook(async sql => {if (sql.includes("FOR UPDATE")) {entered.resolve(); await release.promise;}});
  const pending = owner.control.endorse(1); await entered.promise; controller.abort();
  await assert.rejects(pending); release.resolve(); await turn(); await turn();
  assert.equal(h.calls.some(({sql}) => sql.startsWith("INSERT INTO provider_access.route_selection(")), false);
  assert.equal(await owner.readCurrent(), undefined); owner.dispose();
});

test("deadline and disposal cut off late query results without owning the borrowed pool", async () => {
  for (const cutoff of ["deadline", "dispose"] as const) {
    const h = await harness({...selection(), deadline: performance.now() + (cutoff === "deadline" ? 40 : 60_000)});
    const owner = h.owner(h.input, {statementMs: 100, transactionMs: 200});
    const entered = deferred<void>(); const release = deferred<void>();
    h.setHook(async sql => {if (sql.includes("FOR UPDATE")) {entered.resolve(); await release.promise;}});
    const pending = owner.control.endorse(1); await entered.promise;
    if (cutoff === "dispose") {owner.dispose(); release.resolve();}
    await assert.rejects(pending); release.resolve(); await turn(); await turn();
    assert.equal(h.calls.some(({sql}) => sql.startsWith("INSERT INTO provider_access.route_selection(")), false);
    const before = h.connects(); assert.equal(await owner.readCurrent(), undefined); assert.equal(h.connects(), before);
    const client = await h.pool.connect(); client.release(); owner.dispose();
  }
});

test("cutoff during commit cannot publish a late successful current read", async () => {
  const h = await harness(); const owner = h.owner(); await owner.control.endorse(1);
  h.setHook(async sql => {if (sql === "COMMIT") {owner.dispose();}});
  assert.equal(await owner.readCurrent(), undefined); assert.equal(h.releases.at(-1), true);
});
