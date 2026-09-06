import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnDispatchAuthorityFeature, createInMemoryDispatchConsumptionRepository,
  createNodeSha256DispatchDigest } from "../dist/composition.js";
import { operationId, requestId, settlementId } from
  "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/records.js";
import { dispatchSchemaV1 } from
  "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/schema.js";
import { authority, createHarness, deferred, grant, input, operation, scope, seeded,
  settlement, unavailable } from "./postgres-dispatch.fixtures.ts";

test("construction is inert; explicit migration and reads cannot seed authority", async () => {
  const f = createHarness();
  assert.equal(f.db.clients.length, 0);
  assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
  assert.equal(f.db.tables.authority_heads.size, 0);
  await f.repository.migrate();
  await f.repository.migrate();
  assert.deepEqual(await f.repository.readAuthority(operation()), { headVersion: "0" });
  assert.deepEqual(await f.api.observeDispatchConsumption(input()), { status: "not_found" });
  assert.equal(f.db.tables.authority_heads.size, 0);
  assert.equal(f.db.tables.consume_requests.size, 0);
  f.db.version = 2;
  let callbacks = 0;
  await assert.rejects(f.repository.consumeAtomically(grant(), () => {
    callbacks += 1; return { outcome: { status: "not_found" } };
  }));
  assert.equal(callbacks, 0);
  f.db.assertReleased();
});

test("durable CAS is independent of domain revision and survives replacement instances", async () => {
  const f = await seeded();
  const other = createHarness(f.db);
  const outcomes = await Promise.all([
    f.repository.replaceAuthority(authority({ constraintsDigest: "constraints-b" }), "1"),
    other.repository.replaceAuthority(authority({ constraintsDigest: "constraints-c" }), "1"),
  ]);
  assert.deepEqual(outcomes.map(x => x.status).toSorted(), ["applied", "conflict"]);
  const head = await other.repository.readAuthority(operation());
  assert.equal(head.headVersion, "2");
  assert.equal(head.authority?.authorityRevision, authority().authorityRevision);
  assert.deepEqual(await other.repository.revokeAuthority(operation(), "1"),
    { status: "conflict", headVersion: "2" });
  assert.deepEqual(await other.repository.revokeAuthority(operation(), "2"),
    { status: "applied", headVersion: "3" });
  assert.deepEqual(await f.repository.replaceAuthority(authority(), "2"),
    { status: "conflict", headVersion: "3" });
  const denied = await f.api.consumeForDispatch(input());
  assert.equal(denied.status, "prevented");
  if (denied.status === "prevented") {assert.equal(denied.evidence.reason, "revoked");}
  f.db.assertReleased();
});

test("revocation of an absent head fences stale expected-zero replacement", async () => {
  const f = createHarness();
  await f.repository.migrate();
  assert.deepEqual(await f.repository.revokeAuthority(operation(), "0"),
    { status: "applied", headVersion: "1" });
  assert.deepEqual(await f.repository.readAuthority(operation()), { headVersion: "1" });
  assert.deepEqual(await f.repository.replaceAuthority(authority(), "0"),
    { status: "conflict", headVersion: "1" });
  assert.deepEqual(await f.api.consumeForDispatch(input()), { status: "not_found" });
  await f.repository.replaceAuthority(authority(), "1");
  assert.deepEqual(await f.api.consumeForDispatch(input()), { status: "not_found" });
  assert.equal((await f.api.consumeForDispatch(input({ grantRequestId: "new-grant" }))).status, "consumed");
  f.db.assertReleased();
});

test("two instances serialize absent/current identities before application callbacks", async () => {
  const f = await seeded();
  const other = createHarness(f.db);
  const inside = deferred();
  const release = deferred();
  let held = false;
  f.db.hook = async (_client, sql, _values, execute) => {
    if (sql.startsWith("SELECT operation_key") && !held) {
      held = true; inside.resolve(); await release.promise;
    }
    return execute();
  };
  const first = f.api.consumeForDispatch(input());
  await inside.promise;
  let secondCallbacks = 0;
  const second = other.repository.consumeAtomically(grant(), snapshot => {
    secondCallbacks += 1;
    assert.equal(snapshot.priorRequest?.outcome.status, "consumed");
    return { outcome: snapshot.priorRequest!.outcome };
  });
  await new Promise(resolve => {setImmediate(resolve);});
  assert.equal(secondCallbacks, 0);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.status, "consumed");
  assert.equal(secondCallbacks, 1);
  assert.equal(f.db.tables.consumptions.size, 1);
  f.db.assertReleased();
});

test("concurrent grants consume once; replay preserves bytes after expiry, revoke and settlement", async () => {
  const f = await seeded();
  const other = createHarness(f.db);
  const requests = [input(), input({ grantRequestId: "grant-b" })];
  const outcomes = await Promise.all(requests.map((r, i) => (i ? other.api : f.api).consumeForDispatch(r)));
  assert.deepEqual(outcomes.map(x => x.status).toSorted(), ["consumed", "prevented"]);
  const winner = outcomes.findIndex(x => x.status === "consumed");
  const consumed = outcomes[winner]!;
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const original = JSON.stringify(consumed);
  const originalStored = f.db.tables.consumptions.get(operationId(operation()))?.receipt;
  const chosen = requests[winner]!;
  await f.repository.revokeAuthority(operation(), "1");
  f.setTime(500);
  const settled = await f.api.settleDispatchConsumption(settlement(consumed.receipt.consumptionDigest,
    { grantRequestId: chosen.grantRequestId }));
  assert.equal(settled.status, "settled");
  assert.equal(JSON.stringify(await f.api.consumeForDispatch(chosen)), original);
  assert.equal(f.db.tables.consumptions.get(operationId(operation()))?.receipt, originalStored);
  assert.deepEqual(await f.api.consumeForDispatch({ ...chosen, expectedAuthorityRevision: "changed" }),
    { status: "conflict", reason: "grant_request_digest_conflict" });
  const observed = await other.api.observeDispatchConsumption(chosen);
  assert.equal(observed.status, "consumed");
  if (observed.status === "consumed") {assert.equal(observed.lifecycleState, "claim_committed");}
  f.db.assertReleased();
});

for (const initial of ["absent", "current"] as const) {
  test(`${initial} authority replacement/revocation uses the same lock as dispatch`, async () => {
    const f = initial === "current" ? await seeded() : createHarness();
    if (initial === "absent") {await f.repository.migrate();}
    const entered = deferred();
    const release = deferred();
    let held = false;
    f.db.hook = async (_client, sql, _values, execute) => {
      if (sql.startsWith("SELECT operation_key") && !held) {
        held = true; entered.resolve(); await release.promise;
      }
      return execute();
    };
    const consuming = f.api.consumeForDispatch(input());
    await entered.promise;
    let controlled = false;
    const control = (initial === "current" ? f.repository.revokeAuthority(operation(), "1") :
      f.repository.replaceAuthority(authority(), "0")).then(value => {controlled = true; return value;});
    await new Promise(resolve => {setImmediate(resolve);});
    assert.equal(controlled, false);
    release.resolve();
    assert.equal((await consuming).status, initial === "current" ? "consumed" : "not_found");
    assert.equal((await control).status, "applied");
    assert.equal((await f.api.consumeForDispatch(input())).status, initial === "current" ? "consumed" : "not_found");
    f.db.assertReleased();
  });
}

test("expiry is evaluated inside the locked callback, after database waits", async () => {
  const f = await seeded();
  const entered = deferred();
  const release = deferred();
  f.db.hook = async (_client, sql, _values, execute) => {
    if (sql.startsWith("SELECT c.operation_key")) {entered.resolve(); await release.promise;}
    return execute();
  };
  const consuming = f.api.consumeForDispatch(input());
  await entered.promise;
  f.setTime(200);
  release.resolve();
  const outcome = await consuming;
  assert.equal(outcome.status, "prevented");
  if (outcome.status === "prevented") {assert.equal(outcome.evidence.reason, "expired");}
  assert.equal(f.db.tables.consumptions.size, 0);
  f.db.assertReleased();
});

test("failure between request and receipt insert rolls back both; no fabricated fresh result", async () => {
  const f = await seeded();
  f.db.hook = async (_client, sql, _values, execute) => {
    if (sql.startsWith("INSERT INTO runtime_security_dispatch_v1.consumptions")) {throw new Error("synthetic write failure");}
    return execute();
  };
  assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
  assert.equal(f.db.tables.consume_requests.size, 0);
  assert.equal(f.db.tables.consumptions.size, 0);
  assert.equal(f.db.events.at(-1)?.sql, "ROLLBACK");
  f.db.hook = undefined;
  assert.equal((await f.api.consumeForDispatch(input())).status, "consumed");
  f.db.assertReleased();
});

test("commit acknowledgement loss has no automatic retry; explicit reads/replays recover durable facts", async () => {
  const f = await seeded();
  const loseCommit = () => {
    f.db.hook = async (_client, sql, _values, execute) => {
      const result = await execute();
      if (sql === "COMMIT") {throw new Error("synthetic lost acknowledgement");}
      return result;
    };
  };
  loseCommit();
  const before = f.db.clients.length;
  assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
  assert.equal(f.db.clients.length, before + 1);
  assert.equal(f.db.clients.at(-1)?.discarded, true);
  assert.equal(f.db.events.at(-1)?.sql, "COMMIT");
  f.db.hook = undefined;
  const restarted = createHarness(f.db);
  const consumed = await restarted.api.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const request = settlement(consumed.receipt.consumptionDigest);
  loseCommit();
  assert.deepEqual(await restarted.api.settleDispatchConsumption(request), unavailable);
  f.db.hook = undefined;
  const observed = await f.api.observeDispatchConsumption(input());
  assert.equal(observed.status, "consumed");
  if (observed.status === "consumed") {assert.equal(observed.lifecycleState, "claim_committed");}
  assert.equal((await f.api.settleDispatchConsumption(request)).status, "settled");
  assert.equal(f.db.tables.settlement_requests.size, 1);
  f.db.assertReleased();
});

test("settlement requests preserve replay, digest conflict, not-found and monotonic meanings", async () => {
  const f = await seeded();
  const consumed = await f.api.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const request = settlement(consumed.receipt.consumptionDigest);
  const missing = { ...request, settlementRequestId: "missing", consumptionDigest: "absent" };
  assert.deepEqual(await f.api.settleDispatchConsumption(missing), { status: "not_found" });
  assert.deepEqual(await f.api.settleDispatchConsumption(missing), { status: "not_found" });
  assert.deepEqual(await f.api.settleDispatchConsumption({ ...missing, disposition: "abandoned_without_claim" }),
    { status: "conflict", reason: "settlement_request_digest_conflict" });
  assert.deepEqual(await f.api.settleDispatchConsumption({ ...missing, consumptionDigest: request.consumptionDigest }),
    unavailable); // Existing application treats a changed consumption identity as corrupt replay.
  const other = createHarness(f.db);
  const results = await Promise.all([
    f.api.settleDispatchConsumption(request),
    other.api.settleDispatchConsumption({ ...request, settlementRequestId: "other", disposition: "abandoned_without_claim" }),
  ]);
  assert.deepEqual(results.map(x => x.status).toSorted(), ["conflict", "settled"]);
  const won = results[0]!.status === "settled" ? request :
    { ...request, settlementRequestId: "other", disposition: "abandoned_without_claim" as const };
  const settled = await other.api.settleDispatchConsumption(won);
  assert.equal(settled.status, "settled");
  assert.deepEqual(await f.api.settleDispatchConsumption({ ...won, disposition:
    won.disposition === "claim_committed" ? "abandoned_without_claim" : "claim_committed" }),
  { status: "conflict", reason: "settlement_request_digest_conflict" });
  const reuse = await f.api.consumeForDispatch(input({ grantRequestId: "cannot-reopen" }));
  assert.equal(reuse.status, "prevented");
  if (reuse.status === "prevented") {assert.equal(reuse.evidence.reason, "already_consumed");}
  f.db.assertReleased();
});

for (const [name, change] of Object.entries({
  tenant: { scope: { ...scope, tenantId: "tenant-b" } },
  project: { scope: { ...scope, projectId: "project-b" } },
  scopeDigest: { scope: { ...scope, scopeDigest: "scope-b" } },
  provider: { providerId: "provider-b" }, generation: { authorityGeneration: "generation-b" },
  operation: { operationId: "operation-b" },
  unicode: { scope: { tenantId: "界".repeat(512), projectId: "界".repeat(512), scopeDigest: "界".repeat(512) } },
})) {
  test(`full composite ${name} identity isolates equal grant and settlement IDs`, async () => {
    const f = await seeded();
    const changed = input(change);
    assert.deepEqual(await f.api.observeDispatchConsumption(changed), { status: "not_found" });
    await f.repository.replaceAuthority(authority(change), "0");
    for (const candidate of [input(), changed]) {
      const consumed = await f.api.consumeForDispatch(candidate);
      assert.equal(consumed.status, "consumed");
      if (consumed.status !== "consumed") {return;}
      assert.equal((await f.api.settleDispatchConsumption({ ...settlement(consumed.receipt.consumptionDigest),
        ...grant(candidate) })).status, "settled");
      const observed = await f.api.observeDispatchConsumption(candidate);
      assert.equal(observed.status, "consumed");
      if (observed.status === "consumed") {assert.deepEqual(observed.receipt.scope, candidate.scope);}
    }
    assert.equal(f.db.tables.consumptions.size, 2);
    assert.equal(f.db.tables.settlement_requests.size, 2);
    f.db.assertReleased();
  });
}

test("grant and settlement keys are scoped independently, including not-found requests", async () => {
  const f = await seeded();
  const consumed = await f.api.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const request = settlement(consumed.receipt.consumptionDigest);
  assert.deepEqual(await f.api.settleDispatchConsumption({ ...request, grantRequestId: "foreign-grant" }),
    { status: "not_found" });
  assert.equal((await f.api.settleDispatchConsumption(request)).status, "settled");
  assert.equal(f.db.tables.settlement_requests.size, 2);
  assert.deepEqual(await f.api.observeDispatchConsumption(input({ grantRequestId: "foreign-grant" })),
    { status: "not_found" });
  f.db.assertReleased();
});

test("PostgreSQL outcomes match the existing application with the in-memory owner", async () => {
  for (const change of [
    { expectedAuthorityRevision: "stale" }, { expectedConstraintsDigest: "drift" },
    { expectedContainmentPolicyDigest: "drift" }, { requestDigest: "other" },
    { providerBindingDigest: "other" }, { claimBindingDigest: "other" },
    { acceptedAuthorityDigest: "other" }, { expectedAuthorityHeadDigest: "other" },
  ]) {
    const f = await seeded();
    const memory = createContainedTurnDispatchAuthorityFeature({
      repository: createInMemoryDispatchConsumptionRepository([authority()]),
      digest: createNodeSha256DispatchDigest(), clock: { now: () => 100 },
    }).dispatchAuthorityV1;
    const candidate = input(change);
    assert.deepEqual(await f.api.consumeForDispatch(candidate), await memory.consumeForDispatch(candidate));
    assert.deepEqual(await f.api.consumeForDispatch(candidate), await memory.consumeForDispatch(candidate));
    assert.deepEqual(await f.api.observeDispatchConsumption(candidate), await memory.observeDispatchConsumption(candidate));
    f.db.assertReleased();
  }
});

test("authority ingress captures data once and rejects proxies, accessors and unknowns", async () => {
  const f = createHarness();
  await f.repository.migrate();
  const head = authority({ scope: { ...scope } });
  const pending = f.repository.replaceAuthority(head, "0");
  (head.scope as { tenantId: string }).tenantId = "changed";
  await pending;
  assert.equal((await f.api.consumeForDispatch(input())).status, "consumed");
  assert.equal(Object.isFrozen(head), false);
  let traps = 0;
  const proxy = new Proxy(authority(), { getOwnPropertyDescriptor() {traps += 1; throw new Error("trap");} });
  const accessor = Object.defineProperty(authority(), "revoked", { get() {traps += 1; return false;} });
  const calls = f.db.clients.length;
  for (const bad of [proxy, accessor, { ...authority(), extra: true }]) {
    await assert.rejects(f.repository.replaceAuthority(bad, "1"));
  }
  await assert.rejects(f.repository.replaceAuthority(authority(), "01"));
  assert.equal(f.db.clients.length, calls);
  assert.equal(traps, 0);
  f.db.assertReleased();
});

test("malformed owner decisions cannot overwrite request history or reopen a receipt", async () => {
  const f = await seeded();
  const consumed = await f.api.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const before = structuredClone([...f.db.tables.consumptions]);
  await assert.rejects(f.repository.consumeAtomically(grant(), () => ({
    outcome: { status: "not_found" }, persistRequest: {
      requestDigest: "rewrite", requestFingerprint: "rewrite", outcome: { status: "not_found" },
    },
  })));
  const request = settlement(consumed.receipt.consumptionDigest);
  const { disposition: _disposition, ...key } = request;
  await assert.rejects(f.repository.settleAtomically(key, () => ({
    result: { status: "settled", receipt: { contractVersion: "contained-turn-dispatch-settlement/v1",
      settlementRequestId: request.settlementRequestId, providerId: "foreign",
      authorityGeneration: request.authorityGeneration, consumptionDigest: request.consumptionDigest,
      disposition: "claim_committed", settledAtControlTime: 100 } },
    persist: { settlementDigest: "wrong", settle: true },
  })));
  assert.deepEqual([...f.db.tables.consumptions], before);
  assert.equal(f.db.tables.settlement_requests.size, 0);
  f.db.assertReleased();
});

for (const corrupt of ["authority", "request", "receipt", "settlement", "missing-request", "foreign-key"]) {
  test(`corrupt/foreign ${corrupt} persisted facts fail closed`, async () => {
    const f = await seeded();
    const consumed = await f.api.consumeForDispatch(input());
    assert.equal(consumed.status, "consumed");
    if (consumed.status !== "consumed") {return;}
    const request = settlement(consumed.receipt.consumptionDigest);
    await f.api.settleDispatchConsumption(request);
    if (corrupt === "authority") {
      const row = f.db.tables.authority_heads.get(operationId(operation()))!;
      row.authority = JSON.stringify({ ...authority(), providerId: "foreign" });
    } else if (corrupt === "request") {
      const row = f.db.tables.consume_requests.get(requestId(grant()))!;
      row.fact = JSON.stringify({ ...JSON.parse(String(row.fact)), scope: { ...scope, tenantId: "foreign" } });
    } else if (corrupt === "receipt") {
      const row = f.db.tables.consumptions.get(operationId(operation()))!;
      row.receipt = JSON.stringify({ ...consumed.receipt, consumptionDigest: "forged" });
    } else if (corrupt === "settlement") {
      const row = f.db.tables.settlement_requests.get(settlementId(request))!;
      const fact = JSON.parse(String(row.fact));
      fact.outcome.receipt.authorityGeneration = "foreign";
      row.fact = JSON.stringify(fact);
    } else if (corrupt === "missing-request") {
      f.db.tables.consume_requests.delete(requestId(grant()));
    } else {
      f.db.tables.consumptions.get(operationId(operation()))!.request_key = "foreign";
    }
    assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
    if (corrupt !== "authority" && corrupt !== "missing-request") {
      assert.deepEqual(await f.api.observeDispatchConsumption(input()), unavailable);
      assert.deepEqual(await f.api.settleDispatchConsumption(request), unavailable);
    }
    f.db.assertReleased();
  });
}

test("versioned schema retains historical receipts, request outcomes and durable head versions", () => {
  assert.match(dispatchSchemaV1, /head_version bigint NOT NULL CHECK \(head_version > 0\)/u);
  assert.match(dispatchSchemaV1, /NEW.head_version <> OLD.head_version \+ 1/u);
  assert.match(dispatchSchemaV1, /ON runtime_security_dispatch_v1.settlement_requests \(operation_key\) WHERE applies/u);
  for (const name of ["dispatch_request_immutable", "dispatch_consumption_immutable", "dispatch_settlement_immutable"]) {
    assert.ok(dispatchSchemaV1.includes(`${name} BEFORE UPDATE OR DELETE OR TRUNCATE`));
  }
});
