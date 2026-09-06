import assert from "node:assert/strict";
import test from "node:test";
import { createNodeSha256DispatchDigest } from "../dist/composition.js";
import { requestCanonical, settlementCanonical } from "../dist/features/contained-turn-dispatch-authority/application/dispatch-canonical.js";
import { requestId, settlementId } from "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/records.js";
import { authority, createHarness, grant, input, seeded, settlement, unavailable } from "./postgres-dispatch.fixtures.ts";

for (const table of ["consume_requests", "consumptions", "settlement_requests"]) {
  for (const rowCount of [0, null, 2]) {
    test(`${table} acknowledgement of ${rowCount} rows cannot publish a durable result`, async () => {
      const f = await seeded();
      const consumed = table === "settlement_requests" ? await f.api.consumeForDispatch(input()) : undefined;
      f.db.hook = async (_client, sql, _values, execute) => sql.startsWith(`INSERT INTO runtime_security_dispatch_v1.${table}`)
        ? { rows: [], rowCount } : execute();
      if (consumed === undefined) {
        assert.deepEqual(await f.api.consumeForDispatch(input()), unavailable);
        assert.equal(f.db.tables.consume_requests.size, 0);
        assert.equal(f.db.tables.consumptions.size, 0);
      } else {
        assert.equal(consumed.status, "consumed");
        if (consumed.status !== "consumed") {throw new Error("Expected consumption");}
        assert.deepEqual(await f.api.settleDispatchConsumption(settlement(consumed.receipt.consumptionDigest)), unavailable);
        assert.equal(f.db.tables.settlement_requests.size, 0);
        const observed = await f.api.observeDispatchConsumption(input());
        assert.equal(observed.status, "consumed");
        if (observed.status === "consumed") {assert.equal(observed.lifecycleState, "consumed_pending");}
      }
      f.db.assertReleased();
    });
  }
}

test("maximal valid escaped identifiers remain readable after consumption and settlement", async () => {
  const f = createHarness(); await f.repository.migrate();
  const value = "\u0001".repeat(512);
  const request = input();
  for (const key of Object.keys(request)) {
    if (key !== "purpose" && key !== "scope") {(request as unknown as Record<string, unknown>)[key] = value;}
  }
  const scoped = { ...request, scope: { tenantId: value, projectId: value, scopeDigest: value } };
  const head = authority();
  for (const key of Object.keys(head)) {
    if (typeof head[key as keyof typeof head] === "string" &&
      !["purpose", "decision", "ownerEvidenceRef"].includes(key)) {
      (head as unknown as Record<string, unknown>)[key] = value;
    }
  }
  await f.repository.replaceAuthority({ ...head, scope: scoped.scope }, "0");
  const consumed = await f.api.consumeForDispatch(scoped);
  assert.equal(consumed.status, "consumed");
  const fact = [...f.db.tables.consume_requests.values()][0]?.fact;
  assert.ok(typeof fact === "string" && fact.length > 65_536);
  assert.deepEqual(await f.api.consumeForDispatch(scoped), consumed);
  assert.equal((await f.api.observeDispatchConsumption(scoped)).status, "consumed");
  if (consumed.status !== "consumed") {throw new Error("Expected consumption");}
  const settled = await f.api.settleDispatchConsumption(settlement(consumed.receipt.consumptionDigest, {
    scope: scoped.scope, operationId: value, providerId: value, authorityGeneration: value,
    grantRequestId: value, settlementRequestId: value,
  }));
  assert.equal(settled.status, "settled");
  assert.equal((await f.api.observeDispatchConsumption(scoped)).status, "consumed");
  f.db.assertReleased();
});

test("a substituted request fingerprint cannot replay an unrelated claim binding", async () => {
  const f = await seeded(); assert.equal((await f.api.consumeForDispatch(input())).status, "consumed");
  const altered = input({ claimBindingDigest: "altered-claim" });
  const row = f.db.tables.consume_requests.get(requestId(grant()))!;
  const fact = JSON.parse(String(row.fact));
  row.fact = JSON.stringify({ ...fact, requestFingerprint: createNodeSha256DispatchDigest().digestCanonical(requestCanonical(altered)) });
  assert.deepEqual(await f.api.consumeForDispatch(altered), unavailable);
  assert.deepEqual(await f.api.observeDispatchConsumption(altered), unavailable);
  f.db.assertReleased();
});

test("a substituted settlement fingerprint cannot replay an opposing disposition", async () => {
  const f = await seeded(); const consumed = await f.api.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {throw new Error("Expected consumption");}
  const original = settlement(consumed.receipt.consumptionDigest);
  assert.equal((await f.api.settleDispatchConsumption(original)).status, "settled");
  const altered = { ...original, disposition: "abandoned_without_claim" as const };
  const row = f.db.tables.settlement_requests.get(settlementId(original))!;
  const fact = JSON.parse(String(row.fact));
  row.fact = JSON.stringify({ ...fact, settlementDigest: createNodeSha256DispatchDigest().digestCanonical(settlementCanonical(altered)) });
  assert.deepEqual(await f.api.settleDispatchConsumption(altered), unavailable);
  assert.deepEqual(await f.api.observeDispatchConsumption(input()), unavailable);
  f.db.assertReleased();
});
