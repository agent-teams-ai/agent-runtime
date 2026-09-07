import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnDispatchAuthorityFeature, createNodeSha256DispatchDigest,
  createDispatchAcceptanceFeature, createPostgresDispatchAcceptanceStore } from "../dist/composition.js";
import { createPostgresDispatchConsumptionRepository } from
  "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/dispatch-consumption-repository.js";
import { lockId } from "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/records.js";
import type { DispatchPgPool } from
  "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/transaction.js";
import { authority, input, scope } from "./contained-turn-dispatch-authority.fixtures.ts";
import { validateDisposablePostgresUrl } from "./postgres-dispatch-url.fixtures.ts";

const databaseUrl = process.env.RS_POSTGRES_DISPOSABLE_URL;
const operation = (operationId: string) => ({ scope, operationId, providerId: "provider-a",
  authorityGeneration: "generation-a" });

test("RS PostgreSQL 18 durable dispatch owner contract", { skip: !databaseUrl, timeout: 45_000 }, async t => {
  const connectionString = validateDisposablePostgresUrl(databaseUrl!);
  const { Pool } = await import("pg");
  const pools: InstanceType<typeof Pool>[] = [];
  const pool = () => {
    const p = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000,
      query_timeout: 5_000, idleTimeoutMillis: 1_000, application_name: "ar69-rs-disposable-test" });
    pools.push(p); return p;
  };
  t.after(async () => {await Promise.all(pools.map(p => p.end()));});
  const a = pool(); const b = pool();
  const version = await a.query("SHOW server_version_num");
  assert.ok(Number(version.rows[0]?.server_version_num) >= 180000, "Requires PostgreSQL 18 or newer");
  const existing = await a.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('runtime_security_dispatch_v1', 'runtime_security_dispatch_acceptance_v1')");
  assert.equal(existing.rowCount, 0, "Refuse an existing RS schema; orchestration owns the new database");
  const owners: ReturnType<typeof createPostgresDispatchConsumptionRepository>[] = [];
  t.after(() => {for (const owner of owners) {owner.close();}});
  const make = (driver: DispatchPgPool, queryTimeoutMs = 10_000) => {
    const digest = createNodeSha256DispatchDigest();
    const repository = createPostgresDispatchConsumptionRepository({ pool: driver, digest,
      connectTimeoutMs: 5_000, queryTimeoutMs, transactionTimeoutMs: 20_000 });
    owners.push(repository);
    return { repository, api: createContainedTurnDispatchAuthorityFeature({ repository, digest,
      clock: { now: () => 100 } }).dispatchAuthorityV1 };
  };
  const one = make(a); const two = make(b);
  await Promise.all([one.repository.migrate(), two.repository.migrate()]);
  const seed = async (id: string) => {
    assert.deepEqual(await one.repository.replaceAuthority(authority({ operationId: id }), "0"),
      { status: "applied", headVersion: "1" });
    return input({ operationId: id });
  };

  await t.test("separate connections serialize competing grants and retain exact replay", async () => {
    const request = await seed("concurrent");
    const requests = Array.from({ length: 8 }, (_, i) => ({ ...request, grantRequestId: `grant-${i}` }));
    const results = await Promise.all(requests.map((r, i) => (i % 2 ? one : two).api.consumeForDispatch(r)));
    assert.equal(results.filter(r => r.status === "consumed").length, 1);
    assert.equal(results.filter(r => r.status === "prevented").length, 7);
    const winner = results.findIndex(r => r.status === "consumed");
    const original = results[winner]!; const chosen = requests[winner]!;
    assert.equal((await a.query("SELECT count(*) FROM runtime_security_dispatch_v1.consumptions")).rows[0]?.count, "1");
    assert.deepEqual(await two.api.consumeForDispatch(chosen), original);
    assert.equal((await two.api.consumeForDispatch({ ...chosen, expectedAuthorityRevision: "changed" })).status, "conflict");
    await one.repository.revokeAuthority(operation("concurrent"), "1");
    assert.deepEqual(await two.api.consumeForDispatch(chosen), original);
    assert.equal(original.status, "consumed");
    if (original.status !== "consumed") {throw new Error("Expected consumed grant");}
    const settlement = { ...operation("concurrent"), grantRequestId: chosen.grantRequestId,
      settlementRequestId: "settlement-a", consumptionDigest: original.receipt.consumptionDigest,
      disposition: "claim_committed" as const };
    const settled = await one.api.settleDispatchConsumption(settlement);
    assert.equal(settled.status, "settled");
    assert.deepEqual(await two.api.settleDispatchConsumption(settlement), settled);
    assert.equal((await two.api.settleDispatchConsumption({ ...settlement, disposition: "abandoned_without_claim" })).status, "conflict");
    const third = make(pool());
    assert.deepEqual(await third.api.consumeForDispatch(chosen), original);
    const observed = await third.api.observeDispatchConsumption(chosen);
    assert.equal(observed.status, "consumed");
    if (observed.status === "consumed") {assert.equal(observed.lifecycleState, "claim_committed");}
  });

  await t.test("current head CAS and absent revocation survive new repository instances", async () => {
    await seed("cas");
    const results = await Promise.all([one, two].map(o => o.repository.revokeAuthority(operation("cas"), "1")));
    assert.deepEqual(results.map(r => r.status).toSorted(), ["applied", "conflict"]);
    assert.equal((await two.api.consumeForDispatch(input({ operationId: "cas" }))).status, "prevented");
    await one.repository.revokeAuthority(operation("absent"), "0");
    assert.deepEqual(await two.repository.replaceAuthority(authority({ operationId: "absent" }), "0"),
      { status: "conflict", headVersion: "1" });
    assert.deepEqual(await two.repository.readAuthority(operation("missing")), { headVersion: "0" });
    assert.equal((await a.query("SELECT count(*) FROM runtime_security_dispatch_v1.authority_heads")).rows[0]?.count, "3");
  });

  await t.test("tenant, project, scope, provider and generation isolate equal request identities", async () => {
    const request = await seed("isolation");
    assert.equal((await one.api.consumeForDispatch(request)).status, "consumed");
    for (const delta of [
      { scope: { ...scope, tenantId: "foreign" } }, { scope: { ...scope, projectId: "foreign" } },
      { scope: { ...scope, scopeDigest: "foreign" } }, { providerId: "foreign" },
      { authorityGeneration: "foreign" },
    ]) {assert.deepEqual(await two.api.observeDispatchConsumption({ ...request, ...delta }), { status: "not_found" });}
  });

  await t.test("accepted lone UTF-16 surrogates survive actual PostgreSQL persistence", async () => {
    const request = input({ operationId: "operation-\ud800", grantRequestId: "grant-\udfff",
      scope: { tenantId: "tenant-\ud800", projectId: "project-\udfff", scopeDigest: "scope-\ud800" } });
    await one.repository.replaceAuthority(authority({ operationId: request.operationId, scope: request.scope }), "0");
    const consumed = await one.api.consumeForDispatch(request);
    assert.equal(consumed.status, "consumed");
    assert.deepEqual(await two.api.consumeForDispatch(request), consumed);
    assert.equal((await two.api.observeDispatchConsumption(request)).status, "consumed");
  });

  await t.test("SQL cannot update, delete or truncate historical facts or rewind the head", async () => {
    for (const table of ["consume_requests", "consumptions", "settlement_requests"]) {
      for (const statement of [`UPDATE ${table} SET operation_key = operation_key`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
        await assert.rejects(a.query(statement.replace(table, `runtime_security_dispatch_v1.${table}`)), /immutable/u);
      }
    }
    await assert.rejects(a.query("UPDATE runtime_security_dispatch_v1.authority_heads SET head_version = head_version"), /invalid dispatch head version/u);
    await assert.rejects(a.query("DELETE FROM runtime_security_dispatch_v1.authority_heads"), /cannot be removed/u);
  });

  const faultedPool = (shouldFail: (sql: string) => boolean, afterExecution: boolean): DispatchPgPool => ({
    async connect() {
      const client = await b.connect();
      return {
        async query(sql, values) {
          if (shouldFail(sql) && !afterExecution) {throw new Error("synthetic failure before real query");}
          const result = await client.query(sql, values);
          if (shouldFail(sql) && afterExecution) {throw new Error("synthetic lost acknowledgement after real query");}
          return result;
        },
        release(discard) {client.release(discard);},
      };
    },
  });
  await t.test("lost COMMIT acknowledgement never authorizes retry and a new connection finds the receipt", async () => {
    const request = await seed("commit-uncertain");
    const uncertain = make(faultedPool(sql => sql === "COMMIT", true));
    assert.deepEqual(await uncertain.api.consumeForDispatch(request), { status: "indeterminate", reason: "owner_unavailable" });
    const observed = await two.api.observeDispatchConsumption(request);
    assert.equal(observed.status, "consumed");
    const replay = await one.api.consumeForDispatch(request);
    assert.equal(replay.status, "consumed");
    if (observed.status === "consumed" && replay.status === "consumed") {assert.deepEqual(replay.receipt, observed.receipt);}
  });

  await t.test("failed receipt insert rolls back its request in the real transaction", async () => {
    const request = await seed("rollback");
    const broken = make(faultedPool(sql => sql.startsWith("INSERT INTO runtime_security_dispatch_v1.consumptions"), false));
    assert.deepEqual(await broken.api.consumeForDispatch(request), { status: "indeterminate", reason: "owner_unavailable" });
    assert.deepEqual(await two.api.observeDispatchConsumption(request), { status: "not_found" });
  });

  await t.test("a PostgreSQL trigger suppressing an INSERT cannot fabricate consumption", async () => {
    const request = await seed("suppressed-insert");
    await a.query(`CREATE FUNCTION runtime_security_dispatch_v1.suppress_test_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$;
      CREATE TRIGGER suppress_test_receipt BEFORE INSERT ON runtime_security_dispatch_v1.consumptions
      FOR EACH ROW WHEN (NEW.receipt::jsonb->>'operationId' = 'suppressed-insert')
      EXECUTE FUNCTION runtime_security_dispatch_v1.suppress_test_receipt()`);
    try {
      assert.deepEqual(await one.api.consumeForDispatch(request), { status: "indeterminate", reason: "owner_unavailable" });
      assert.deepEqual(await two.api.observeDispatchConsumption(request), { status: "not_found" });
    } finally {
      await a.query("DROP TRIGGER suppress_test_receipt ON runtime_security_dispatch_v1.consumptions");
    }
  });

  await t.test("real lock contention is bounded and does not execute the decision callback", async () => {
    const key = operation("locked-absence"); const blocker = await a.connect();
    const bounded = make(b, 50); let callbacks = 0;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId(key)]);
      await assert.rejects(bounded.repository.consumeAtomically({ ...key, grantRequestId: "grant" }, () => {
        callbacks += 1; return { outcome: { status: "not_found" } };
      }));
      assert.equal(callbacks, 0);
    } finally {await blocker.query("ROLLBACK"); blocker.release();}
    assert.deepEqual(await two.repository.readAuthority(key), { headVersion: "0" });
  });
  await t.test("real acceptance persistence and publication before consumption across owners", async () => {
    const options = { connectTimeoutMs: 5_000, queryTimeoutMs: 10_000, transactionTimeoutMs: 20_000 };
    const decisionsA = createPostgresDispatchAcceptanceStore({ pool: a, ...options });
    const decisionsB = createPostgresDispatchAcceptanceStore({ pool: b, ...options });
    t.after(() => {decisionsA.close(); decisionsB.close();});
    await decisionsA.migrate();
    const intent = { scope, operationId: "accepted-publication", providerId: "provider-a",
      intentDigest: "intent-a", policyRevision: "authority-revision-7" };
    const policy = { scope, providerId: intent.providerId, intentDigest: intent.intentDigest,
      policyRevision: intent.policyRevision, enabled: true, revoked: false,
      constraintsDigest: "constraints-digest-a", containmentPolicyDigest: "containment-policy-digest-a",
      validFromControlTime: 0, claimBeforeControlTime: 200 };
    const deps = { policy: { async read() {return policy;} }, clock: { now: () => 100 },
      digest: createNodeSha256DispatchDigest() };
    const ownerA = createDispatchAcceptanceFeature({ ...deps, repository: one.repository, decisions: decisionsA });
    const ownerB = createDispatchAcceptanceFeature({ ...deps, repository: two.repository, decisions: decisionsB });
    const accepted = await ownerA.evaluateForAcceptance(intent);
    assert.equal(accepted.status, "allowed");
    if (accepted.status !== "allowed") {throw new Error("expected scoped decision");}
    assert.deepEqual(await ownerB.evaluateForAcceptance(intent), accepted);
    const request = input({ operationId: intent.operationId,
      acceptedAuthorityDigest: accepted.decision.decisionDigest,
      expectedAuthorityHeadDigest: accepted.decision.decisionDigest });
    const projection = { acceptance: intent, decisionDigest: accepted.decision.decisionDigest,
      authorityGeneration: request.authorityGeneration, providerBindingDigest: request.providerBindingDigest,
      claimBindingDigest: request.claimBindingDigest, requestDigest: request.requestDigest,
      grantRequestId: request.grantRequestId };
    const results = await Promise.all([ownerA.publishAndConsumeForDispatch(projection, request),
      ownerB.publishAndConsumeForDispatch(projection, request)]);
    assert.equal(results[0]!.status, "consumed");
    assert.deepEqual(results[0], results[1]);
    assert.equal((await two.repository.readAuthority(operation(intent.operationId))).headVersion, "1");
    await t.test("maximum 512-character Unicode acceptance selectors persist through actual SQL", async () => {
      let seed = 69;
      const identifier = () => Array.from({ length: 512 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return String.fromCharCode(0x800 + (seed >>> 8) % 0xd000);
      }).join('');
      const unicodeIntent = { ...intent, operationId: identifier(),
        scope: { tenantId: identifier(), projectId: identifier(), scopeDigest: identifier() } };
      assert.ok(Buffer.byteLength(JSON.stringify({ operationId: unicodeIntent.operationId,
        scope: unicodeIntent.scope })) > 6000);
      const unicodeDeps = { ...deps, policy: { async read() {
        return { ...policy, scope: unicodeIntent.scope };
      } } };
      const firstOwner = createDispatchAcceptanceFeature({ ...unicodeDeps,
        repository: one.repository, decisions: decisionsA });
      const otherOwner = createDispatchAcceptanceFeature({ ...unicodeDeps,
        repository: two.repository, decisions: decisionsB });
      const first = await firstOwner.evaluateForAcceptance(unicodeIntent);
      assert.equal(first.status, "allowed");
      if (first.status !== "allowed") {throw new Error("expected Unicode acceptance");}
      assert.deepEqual(await otherOwner.evaluateForAcceptance(unicodeIntent), first);
      assert.deepEqual(await decisionsB.read(unicodeIntent), first.decision);
      const rows = await a.query("SELECT operation_key, decision FROM runtime_security_dispatch_acceptance_v1.decisions");
      const row = rows.rows.find(row => JSON.parse(row.decision).operationId === unicodeIntent.operationId);
      assert.ok(row, "actual SQL retained the complete Unicode selector");
      assert.match(row.operation_key, /^[a-f0-9]{64}$/u);
      assert.deepEqual(JSON.parse(row.decision), first.decision);
    });
    await assert.rejects(a.query("UPDATE runtime_security_dispatch_acceptance_v1.decisions SET decision = decision"));
    await assert.rejects(a.query("DELETE FROM runtime_security_dispatch_acceptance_v1.decisions"));
    await one.repository.revokeAuthority(operation(intent.operationId), "1");
    assert.deepEqual(await ownerB.publishAndConsumeForDispatch(projection, request), results[0]);
  });


});
