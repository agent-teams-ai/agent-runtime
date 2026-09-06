import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresMaterializationAuthorization } from "../../../dist/features/contained-turn-access/composition/postgres-materialization-authorization.js";
import { createPostgresMaterializationRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-repository.js";
import { createPostgresCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/postgres-credential-rendering-owner.js";
import { renderingFixture, selectorFor } from "./credential-rendering-test-fixture.ts";

// Opt-in only: a newly created, caller-owned test database. No ambient application URL.
const databaseUrl = process.env.PA_POSTGRES_DISPOSABLE_URL;

test("PA-M1 PostgreSQL durability and concurrent current-owner contract", {skip: !databaseUrl, timeout: 30_000}, async t => {
  const url = new URL(databaseUrl!);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), "Disposable loopback PostgreSQL only");
  assert.match(url.pathname, /^\/ar69_pa_test_[a-z0-9]+$/u);
  const {Pool} = await import("pg");
  const pools: InstanceType<typeof Pool>[] = [];
  const pool = () => {
    const value = new Pool({connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000,
      query_timeout: 5_000, idleTimeoutMillis: 1_000, application_name: "ar69-pa-m1-disposable-test"});
    pools.push(value); return value;
  };
  const a = pool(); const b = pool();
  t.after(async () => {await Promise.all(pools.map(value => value.end()));});
  const existing = await a.query("SELECT 1 FROM pg_namespace WHERE nspname = 'provider_access'");
  assert.equal(existing.rowCount, 0, "Test refuses an existing PA schema");
  const one = createPostgresMaterializationAuthorization(a);
  const two = createPostgresMaterializationAuthorization(b);
  const owners = [one, two];
  t.after(() => {for (const owner of owners) {owner.dispose();}});
  // The orchestration harness owns dropping this entire disposable database,
  // including after an uncertain test result. No existing DB/schema is cleaned here.
  await Promise.all([one.control.migrate(), two.control.migrate()]);
  const f = renderingFixture(); const binding = f.selection.binding;
  assert.equal(await one.control.replaceBinding(binding, 0), 1);
  const request = await f.request();

  await t.test("two repositories serialize one fresh authorization and exact replay", async () => {
    const outcomes = await Promise.all(Array.from({length: 12}, (_, index) =>
      (index % 2 ? one : two).authorization.authorize(request)));
    assert.equal(outcomes.filter(value => value.kind === "authorized").length, 1);
    assert.equal(outcomes.filter(value => value.kind === "observed").length, 11);
    const count = await a.query("SELECT count(*) AS count FROM provider_access.materialization_authorization");
    assert.equal(count.rows[0]?.count, "1");
    const conflict = await f.request({accessRef: "access:changed"});
    assert.equal((await two.authorization.authorize(conflict)).kind, "conflict");
  });

  await t.test("owner scope prevents foreign receipt lookup", async () => {
    for (const change of [{tenantId: "tenant:foreign"}, {projectId: "project:foreign"},
      {scopeDigest: "scope:foreign"}, {provider: "claude" as const}]) {
      assert.deepEqual(await two.authorization.observe({...selectorFor(request), ...change}), {kind: "indeterminate"});
    }
  });

  await t.test("current rotation, revocation and availability do not rewrite historical receipts", async () => {
    let headVersion = 1;
    for (const [change, reason] of [
      [{credentialGeneration: 2}, "credential_generation_changed"],
      [{revocation: "revoked" as const}, "revoked"],
      [{availability: "unavailable" as const}, "availability_changed"],
    ] as const) {
      assert.equal(await one.control.replaceBinding({...binding, ...change}, headVersion), ++headVersion);
      const observed = await two.authorization.observe(selectorFor(request));
      assert.equal(observed.kind, "rejected");
      if (observed.kind !== "rejected") {throw new Error("Expected current owner rejection");}
      assert.equal(observed.reason, reason); assert.equal(observed.receipt.decision, "authorized");
      assert.equal(observed.receipt.credentialGeneration, 1);
    }
    assert.equal(await one.control.replaceBinding(binding, headVersion), 5);
    const updates = await Promise.all([one, two].map(owner => owner.control.replaceBinding(binding, 5)));
    assert.deepEqual(updates.toSorted(), [6, undefined]);
    assert.equal(await one.control.replaceBinding(binding, 5), undefined);
  });

  await t.test("fresh connection observes committed history and SQL cannot rewrite receipts", async () => {
    const third = createPostgresMaterializationAuthorization(pool()); owners.push(third);
    assert.equal((await third.authorization.authorize(request)).kind, "observed");
    await assert.rejects(a.query("UPDATE provider_access.materialization_authorization SET receipt = receipt"), /immutable/u);
    await assert.rejects(a.query("DELETE FROM provider_access.materialization_authorization"), /immutable/u);
  });

  await t.test("lost real commit acknowledgement produces indeterminate then historical observation", async () => {
    let loseCommit = true;
    const uncertain = createPostgresMaterializationAuthorization({
      async connect() {
        const client = await b.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && loseCommit) {loseCommit = false; throw new Error("synthetic acknowledgement loss after real commit");}
            return result;
          },
          release(discard?: boolean) {client.release(discard);},
        };
      },
    });
    owners.push(uncertain);
    const input = await f.request({authorizationRequestId: "request:uncertain"});
    assert.deepEqual(await uncertain.authorization.authorize(input), {kind: "indeterminate"});
    assert.equal((await one.authorization.authorize(input)).kind, "observed");
  });

  await t.test("rolled-back authorization never becomes visible", async () => {
    const repository = createPostgresMaterializationRepository(a);
    t.after(() => {repository.dispose();});
    const input = await f.request({authorizationRequestId: "request:rollback"});
    const {requestDigest: _digest, ...selector} = selectorFor(input);
    await assert.rejects(repository.repository.transact(selector, async transaction => {
      await transaction.saveAuthorization({...input, decision: "authorized", rejectionReason: null});
      throw new Error("rollback fixture");
    }), /rollback fixture/u);
    assert.deepEqual(await one.authorization.observe(selectorFor(input)), {kind: "indeterminate"});
  });

  await t.test("actual PA resolve reads durable heads without inserting missing operation scopes", async () => {
    const current = createPostgresCredentialRenderingOwner(a, f.selection);
    const absent = createPostgresCredentialRenderingOwner(b, {...f.selection,
      binding: {...binding, scopeDigest: "scope:absent-observation"}});
    t.after(current.owner.dispose); t.after(absent.owner.dispose);
    const input = {provider: binding.provider, scope: {tenantId: binding.tenantId, projectId: binding.projectId}};
    const before = await a.query("SELECT count(*) AS count FROM provider_access.materialization_owner");
    assert.equal((await current.providerAccess.resolve.execute(input)).kind, "resolved");
    const missing = await absent.providerAccess.resolve.execute(input);
    assert.equal(missing.kind, "unavailable");
    if (missing.kind === "unavailable") {assert.equal(missing.reason, "not_found");}
    const after = await b.query("SELECT count(*) AS count FROM provider_access.materialization_owner");
    assert.deepEqual(after.rows, before.rows, "Observation must not create a missing head");
  });

  await t.test("actual durable PA renderer keeps freshness private and rereads revocation before acquisition", async () => {
    const renderFixture = renderingFixture();
    const attached = createPostgresCredentialRenderingOwner(a, renderFixture.selection, renderFixture.acquisition);
    const owner = attached.owner; t.after(owner.dispose);
    const accessInput = {provider: binding.provider, scope: {tenantId: binding.tenantId, projectId: binding.projectId}};
    const resolved = await attached.providerAccess.resolve.execute(accessInput);
    if (resolved.kind !== "resolved") {throw new Error("Expected same-store PA resolution");}
    const input = await renderFixture.request({authorizationRequestId: "request:render-durable"});
    const fresh = await owner.authorization.authorize(input);
    assert.equal(fresh.kind, "authorized");
    if (fresh.kind !== "authorized") {throw new Error("Expected fresh persistent PA authorization");}
    assert.deepEqual(await owner.rendering.render({...fresh.receipt}), {kind: "denied"});
    const credentials = await owner.rendering.render(fresh.receipt);
    assert.equal(credentials.kind, "rendered");
    if (credentials.kind !== "rendered") {throw new Error("Expected fixture credential rendering");}
    try {
      assert.equal(renderFixture.requests[0]?.authorization, fresh.receipt);
      assert.equal(new TextDecoder().decode(credentials.credentials.fields[0]?.valueBytes), "Bearer fixture-pa");
      for (const raw of renderFixture.raw) {
        assert.equal(raw.kind, "acquired");
        if (raw.kind === "acquired") {for (const field of raw.fields) {assert.ok(field.valueBytes.every(value => value === 0));}}
      }
    } finally {credentials.credentials.release();}
    assert.ok(credentials.credentials.fields.every(field => field.valueBytes.every(value => value === 0)));
    assert.deepEqual(await owner.rendering.render(fresh.receipt), {kind: "denied"});
    assert.equal((await two.authorization.authorize(input)).kind, "observed");
    const pending = await owner.authorization.authorize(await renderFixture.request({authorizationRequestId: "request:render-revoked"}));
    assert.equal(pending.kind, "authorized");
    if (pending.kind !== "authorized") {throw new Error("Expected fresh pre-revocation receipt");}
    assert.equal(await two.control.replaceBinding({...binding, revocation: "revoked"}, 6), 7);
    const revalidated = await attached.providerAccess.revalidate.execute({...accessInput, binding: resolved.binding});
    assert.equal(revalidated.kind, "rejected");
    if (revalidated.kind === "rejected") {assert.equal(revalidated.reason, "revoked");}
    assert.deepEqual(await owner.rendering.render(pending.receipt), {kind: "denied"});
    assert.equal(renderFixture.requests.length, 1, "Revocation must deny before another acquisition");
    owner.dispose();
    await assert.rejects(attached.control.replaceBinding(binding, 7), /closed/u);
  });
});
