import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresDispatchConsumption, createPostgresCredentialRenderingOwner } from "../../../dist/composition.js";
import { createPostgresDispatchConsumptionRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/dispatch-postgres-repository.js";
import { createPostgresMaterializationRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-repository.js";
import { createContainedTurnDispatchConsumptionV1 } from "../../../dist/features/contained-turn-access/composition/dispatch-consumption-v1-factory.js";
import { createSha256DispatchConsumptionDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import { seed, inputFor, settlementFor } from "./dispatch-consumption-test-fixture.ts";
import { renderingFixture } from "./credential-rendering-test-fixture.ts";
import { validateDisposablePostgresUrl } from "./postgres-materialization-url.fixtures.ts";

const databaseUrl = process.env.PA_POSTGRES_DISPOSABLE_URL;
// Missing DB is NOT durability evidence. test:postgres:dispatch refuses absence
// before the test runner. This skip is solely for the ordinary synthetic suite.
test("PA dispatch disposable PostgreSQL durability", {skip: !databaseUrl, timeout: 60_000}, async t => {
  const connectionString = validateDisposablePostgresUrl(databaseUrl!);
  const {Pool} = await import("pg");
  const pools: InstanceType<typeof Pool>[] = [];
  const pool = () => {const value = new Pool({connectionString, max: 4, connectionTimeoutMillis: 2_000,
    query_timeout: 5_000, idleTimeoutMillis: 1_000, application_name: "ar69-pa-dispatch-disposable"}); pools.push(value); return value;};
  t.after(async () => {await Promise.all(pools.map(value => value.end()));});
  const a = pool(); const b = pool();
  assert.equal((await a.query("SELECT 1 FROM pg_namespace WHERE nspname='provider_access'")).rowCount, 0, "Refuse existing PA schema");
  // The orchestrator owns deleting the whole disposable DB after any outcome.
  const one = createPostgresDispatchConsumption(a); const two = createPostgresDispatchConsumption(b);
  t.after(one.dispose); t.after(two.dispose);
  await Promise.all([one.control.migrate(), two.control.migrate()]);
  const now = Number((await a.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
  const head = {...seed({claimBeforeControlTime: now + 120_000, expiresAtControlTime: now + 180_000}), availability: "available" as const, revocation: "active" as const};
  const owner = {provider: head.provider, scope: {tenantId: head.tenantId, projectId: head.projectId, scopeDigest: head.scopeDigest}};
  const publication = {head, publicationRequestId: "publish:1", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0};
  const request = await inputFor(head);

  await t.test("missing heads persist negative replay; publishing never upgrades that request", async () => {
    const absent = await inputFor(head, {grantRequestId: "grant:missing"});
    assert.deepEqual(await one.dispatchConsumption.consumeForDispatch(absent), {kind: "not_found"});
    const results = await Promise.all([one.control.publishHead(publication), two.control.publishHead(publication)]);
    assert.deepEqual(results, [{headVersion: 1, materializationHeadVersion: 1}, {headVersion: 1, materializationHeadVersion: 1}]);
    assert.deepEqual(await two.dispatchConsumption.consumeForDispatch(absent), {kind: "not_found"});
    await assert.rejects(two.control.publishHead({...publication, head: {...head, credentialGeneration: 2}}), /request conflict/u);
    await assert.rejects(two.control.publishHead({...publication, publicationRequestId: "publish:cas-loser"}), /CAS conflict/u);
  });

  const requests = await Promise.all(Array.from({length: 12}, (_, i) => inputFor(head, {grantRequestId: `grant:race:${i}`, operationId: `operation:race:${i}`})));
  const outcomes = await Promise.all(requests.map((value, i) => (i % 2 ? one : two).dispatchConsumption.consumeForDispatch(value)));
  assert.equal(outcomes.filter(value => value.kind === "consumed").length, 1);
  assert.equal(outcomes.filter(value => value.kind === "prevented" && value.prevention.reason === "already_consumed").length, 11);
  const winnerIndex = outcomes.findIndex(value => value.kind === "consumed");
  const winner = outcomes[winnerIndex]!; if (winner.kind !== "consumed") {throw new Error("Expected single durable consumption");}
  const winningRequest = requests[winnerIndex]!;

  await t.test("reconstructed owner observes exact replay and rejects conflicting grants", async () => {
    const rebuilt = createPostgresDispatchConsumption(pool()); t.after(rebuilt.dispose);
    assert.deepEqual(await rebuilt.dispatchConsumption.consumeForDispatch(winningRequest), winner);
    const conflict = await inputFor(head, {grantRequestId: winningRequest.grantRequestId, operationId: "operation:conflict"});
    assert.equal((await rebuilt.dispatchConsumption.consumeForDispatch(conflict)).kind, "conflict");
    for (const scope of [{...owner.scope, tenantId: "tenant:foreign"}, {...owner.scope, projectId: "project:foreign"}, {...owner.scope, scopeDigest: "scope:foreign"}]) {
      assert.deepEqual(await rebuilt.dispatchConsumption.observeDispatchConsumption({grantRequestId: winningRequest.grantRequestId,
        requestDigest: winningRequest.requestDigest, provider: owner.provider, scope}), {kind: "not_found"});
    }
    assert.equal((await a.query("SELECT count(*) AS n FROM provider_access.dispatch_consumption")).rows[0].n, "1");
    await assert.rejects(a.query("UPDATE provider_access.dispatch_consumption SET record=record"), /immutable/u);
    await assert.rejects(a.query("DELETE FROM provider_access.dispatch_grant"), /immutable/u);
  });

  await t.test("same owner publication feeds actual materialization and revocation denies rendering", async () => {
    const materialization = createPostgresMaterializationRepository(a); t.after(materialization.dispose);
    const binding = (await one.control.observeHead(owner)).materializationBinding; assert.ok(binding);
    assert.deepEqual(await materialization.observeBinding({...owner.scope, provider: owner.provider}), binding);
    assert.equal(binding.credentialGeneration, winner.receipt.credentialGeneration);
    assert.equal(binding.credentialBindingDigest, winner.receipt.credentialBindingDigest);
    assert.equal(binding.providerRouteRef, winner.receipt.providerRouteRef);
    const f = renderingFixture();
    // Use the retained DB projection, not a separately seeded materialization head.
    const attached = createPostgresCredentialRenderingOwner(a, {...f.selection, operationRef: winner.receipt.operationId, binding}, f.acquisition); t.after(attached.owner.dispose);
    const authorization = await attached.owner.authorization.authorize(await f.request({
      ...binding, authorizationRequestId: "authorization:from-dispatch"}));
    assert.equal(authorization.kind, "authorized");
    if (authorization.kind !== "authorized") {throw new Error("Expected real materialization authorization");}
    const rendered = await attached.owner.rendering.render(authorization.receipt);
    assert.equal(rendered.kind, "rendered"); if (rendered.kind === "rendered") {rendered.credentials.release();}
    const pending = await attached.owner.authorization.authorize(await f.request({...binding, authorizationRequestId: "authorization:revoked"}));
    assert.equal(pending.kind, "authorized"); if (pending.kind !== "authorized") {throw new Error("Expected pending materialization");}
    await one.control.publishHead({...publication, head: {...head, revocation: "revoked"}, publicationRequestId: "publish:revoke", expectedHeadVersion: 1, expectedMaterializationHeadVersion: 1});
    assert.deepEqual(await attached.owner.rendering.render(pending.receipt), {kind: "denied"});
    assert.equal(f.requests.length, 1);
    const denied = await two.dispatchConsumption.consumeForDispatch(request);
    assert.equal(denied.kind, "prevented"); if (denied.kind === "prevented") {assert.equal(denied.prevention.reason, "revoked");}
    await assert.rejects(one.control.publishHead({...publication, publicationRequestId: "publish:revive", expectedHeadVersion: 2, expectedMaterializationHeadVersion: 2}), /revived/u);
  });

  await t.test("settlement survives revocation, concurrent conflict, restart and never reopens use", async () => {
    const settlement = settlementFor(winner.receipt, {disposition: "claim_committed"});
    const alternatives = await Promise.all([one.dispatchConsumption.settleDispatchConsumption(settlement),
      two.dispatchConsumption.settleDispatchConsumption({...settlement, settlementRequestId: "settlement:competitor", disposition: "abandoned_without_claim"})]);
    assert.equal(alternatives.filter(value => value.kind === "settled").length, 1);
    assert.equal(alternatives.filter(value => value.kind === "conflict").length, 1);
    const success = alternatives.find(value => value.kind === "settled")!; if (success.kind !== "settled") {throw new Error("Expected settlement");}
    const rebuilt = createPostgresDispatchConsumption(pool()); t.after(rebuilt.dispose);
    assert.deepEqual(await rebuilt.dispatchConsumption.settleDispatchConsumption(settlementFor(winner.receipt,
      {settlementRequestId: success.receipt.settlementRequestId, disposition: success.receipt.disposition})), success);
    assert.equal((await a.query("SELECT count(*) AS n FROM provider_access.dispatch_settlement")).rows[0].n, "1");
    await assert.rejects(a.query("DELETE FROM provider_access.dispatch_settlement"), /immutable/u);
  });

  await t.test("rollback leaves neither publication nor projected binding; control time cannot regress", async () => {
    const next = {...head, bindingRevision: 2, credentialGeneration: 2, authorityHeadDigest: "head:2"};
    await assert.rejects(one.control.publishHead({head: next, publicationRequestId: "publish:rollback", expectedHeadVersion: 2, expectedMaterializationHeadVersion: 99}), /CAS conflict/u);
    assert.equal((await one.control.observeHead(owner)).headVersion, 2);
    assert.equal((await a.query("SELECT count(*) AS n FROM provider_access.dispatch_head_identity WHERE authority_digest='head:2'")).rows[0].n, "0");
    await one.control.advanceControlTime(owner, now + 500_000);
    const rebuilt = createPostgresDispatchConsumption(pool()); t.after(rebuilt.dispose);
    assert.ok((await rebuilt.control.observeHead(owner)).controlTime >= now + 500_000);
    await assert.rejects(rebuilt.control.advanceControlTime(owner, now), /regress/u);
    await one.control.publishHead({head: next, publicationRequestId: "publish:2", expectedHeadVersion: 2, expectedMaterializationHeadVersion: 2});
    const stale = await two.dispatchConsumption.consumeForDispatch(await inputFor(head, {grantRequestId: "grant:stale"}));
    assert.equal(stale.kind, "prevented");
    const expired = await two.dispatchConsumption.consumeForDispatch(await inputFor(next, {grantRequestId: "grant:expired"}));
    assert.equal(expired.kind, "prevented"); if (expired.kind === "prevented") {assert.equal(expired.prevention.reason, "expired");}
    // Historical publication replay is an acknowledgement, never head restoration.
    assert.deepEqual(await two.control.publishHead(publication), {headVersion: 1, materializationHeadVersion: 1});
    assert.equal((await one.control.observeHead(owner)).headVersion, 3);
  });

  await t.test("real commit with lost acknowledgement is indeterminate, then exact durable observation", async () => {
    const fresh = {...head, scopeDigest: "scope:ack"};
    await one.control.publishHead({head: fresh, publicationRequestId: "publish:ack", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0});
    let lose = true;
    const uncertain = createPostgresDispatchConsumption({async connect() {const client = await b.connect(); return {
      async query(sql: string, values?: unknown[]) {const result = await client.query(sql, values);
        if (sql === "COMMIT" && lose) {lose = false; throw new Error("lost ack after real commit");} return result;},
      release(discard?: boolean) {client.release(discard);},
    };}}); t.after(uncertain.dispose);
    const input = await inputFor(fresh);
    assert.deepEqual(await uncertain.dispatchConsumption.consumeForDispatch(input), {kind: "indeterminate"});
    const observed = await one.dispatchConsumption.observeDispatchConsumption({grantRequestId: input.grantRequestId, provider: input.provider, scope: input.scope, requestDigest: input.requestDigest});
    assert.equal(observed.kind, "consumed");
    if (observed.kind !== "consumed") {throw new Error("Expected recovered consumption");}
    lose = true;
    const settlement = settlementFor(observed.receipt);
    assert.deepEqual(await uncertain.dispatchConsumption.settleDispatchConsumption(settlement), {kind: "indeterminate"});
    assert.equal((await one.dispatchConsumption.settleDispatchConsumption(settlement)).kind, "settled");
    assert.equal((await one.control.observeConsumption({provider: input.provider, scope: input.scope}, observed.receipt.consumptionDigest))?.state, "abandoned_without_claim");
    const ackPublication = {head: {...fresh, scopeDigest: "scope:publication-ack"}, publicationRequestId: "publish:lost-ack", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0};
    lose = true;
    await assert.rejects(uncertain.control.publishHead(ackPublication), /indeterminate/u);
    assert.deepEqual(await one.control.publishHead(ackPublication), {headVersion: 1, materializationHeadVersion: 1});
    const store = createPostgresDispatchConsumptionRepository(a); t.after(store.dispose);
    await assert.rejects(store.repository.transact({...owner, kind: "consume", grantRequestId: "grant:rollback"}, async () => {throw new Error("rollback fixture");}), /rollback fixture/u);
    assert.equal(await store.repository.observeGrantRequest({...owner, grantRequestId: "grant:rollback"}), undefined);
  });
  await t.test("consumption and journal roll back together; rotation preserves unsettled debt", async () => {
    const scopedHead = {...head, scopeDigest: "scope:rollback-debt"};
    await one.control.publishHead({head: scopedHead, publicationRequestId: "publish:debt", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0});
    const store = createPostgresDispatchConsumptionRepository(a); t.after(store.dispose);
    const faulted = createContainedTurnDispatchConsumptionV1({digest: createSha256DispatchConsumptionDigest(), repository: {
      observeGrantRequest: store.repository.observeGrantRequest,
      async transact(selector, work) {return store.repository.transact(selector, async tx => {await work(tx); throw new Error("after staged consumption and journal");});},
    }});
    const input = await inputFor(scopedHead);
    assert.deepEqual(await faulted.consumeForDispatch(input), {kind: "indeterminate"});
    assert.equal(await store.repository.observeGrantRequest({provider: input.provider, scope: input.scope, grantRequestId: input.grantRequestId}), undefined);
    const consumed = await one.dispatchConsumption.consumeForDispatch(input);
    assert.equal(consumed.kind, "consumed"); if (consumed.kind !== "consumed") {throw new Error("Expected rollback to release one use");}
    const debtOwner = {provider: input.provider, scope: input.scope};
    await two.control.publishHead({head: {...scopedHead, authorityHeadDigest: "head:debt:2", bindingRevision: 2, credentialGeneration: 2},
      publicationRequestId: "publish:debt:2", expectedHeadVersion: 1, expectedMaterializationHeadVersion: 1});
    assert.equal((await one.dispatchConsumption.settleDispatchConsumption(settlementFor(consumed.receipt))).kind, "conflict");
    const rebuilt = createPostgresDispatchConsumption(pool()); t.after(rebuilt.dispose);
    assert.equal((await rebuilt.control.observeConsumption(debtOwner, consumed.receipt.consumptionDigest))?.state, "consumed_pending");
    assert.deepEqual(await rebuilt.dispatchConsumption.consumeForDispatch(input), consumed, "Historical replay is never fresh admission");
  });

  await t.test("independent materialization revocation cannot leave a consumable stale dispatch head", async () => {
    const scopedHead = {...head, scopeDigest: "scope:independent-revocation"};
    await one.control.publishHead({head: scopedHead, publicationRequestId: "publish:independent", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0});
    const input = await inputFor(scopedHead);
    const selected = {provider: input.provider, scope: input.scope};
    const binding = (await one.control.observeHead(selected)).materializationBinding; assert.ok(binding);
    const materialization = createPostgresMaterializationRepository(b); t.after(materialization.dispose);
    assert.equal(await materialization.replaceBinding({...binding, revocation: "revoked"}, 1), 2);
    assert.deepEqual(await one.dispatchConsumption.consumeForDispatch(input), {kind: "indeterminate"});
    assert.deepEqual(await one.dispatchConsumption.observeDispatchConsumption({grantRequestId: input.grantRequestId,
      requestDigest: input.requestDigest, ...selected}), {kind: "not_found"});
  });

  await t.test("matching CAS cannot overwrite independently revoked or rotated materialization authority", async () => {
    const materialization = createPostgresMaterializationRepository(b); t.after(materialization.dispose);
    const cases = [
      {name: "revocation", current: {revocation: "revoked" as const}, proposed: {}, error: /revived/u},
      {name: "availability", current: {availability: "unavailable" as const}, proposed: {}, error: /revived/u},
      {name: "same-revision-credential", current: {credentialGeneration: 2}, proposed: {}, error: /rebound/u},
      {name: "revision", current: {bindingRevision: 3}, proposed: {bindingRevision: 2, authorityHeadDigest: "head:revision:2"}, error: /advance/u},
      {name: "credential", current: {bindingRevision: 2, credentialGeneration: 2, credentialBindingRef: "credential:rotated"},
        proposed: {bindingRevision: 3, authorityHeadDigest: "head:credential:3"}, error: /advance/u},
    ];
    for (const scenario of cases) {
      const initial = {...head, scopeDigest: `scope:publication-${scenario.name}`};
      const selected = {provider: initial.provider, scope: {tenantId: initial.tenantId, projectId: initial.projectId, scopeDigest: initial.scopeDigest}};
      const original = {head: initial, publicationRequestId: "publish:initial", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0};
      assert.deepEqual(await one.control.publishHead(original), {headVersion: 1, materializationHeadVersion: 1});
      const binding = await materialization.observeBinding({...selected.scope, provider: selected.provider}); assert.ok(binding);
      const independent = {...binding, ...scenario.current};
      assert.equal(await materialization.replaceBinding(independent, 1), 2);
      const proposed = {...initial, ...scenario.proposed};
      const rejected = {head: proposed, publicationRequestId: "publish:rejected", expectedHeadVersion: 1, expectedMaterializationHeadVersion: 2};
      await assert.rejects(two.control.publishHead(rejected), scenario.error);
      assert.deepEqual(await materialization.observeBinding({...selected.scope, provider: selected.provider}), independent);
      const observed = await one.control.observeHead(selected);
      assert.equal(observed.headVersion, 1); assert.deepEqual(observed.head, initial);
      const journal = await a.query(`SELECT count(*) AS n FROM provider_access.dispatch_publication p
        JOIN provider_access.dispatch_owner o USING(owner_id) WHERE o.owner=$1::jsonb AND p.request_id=$2`,
        [JSON.stringify(selected), rejected.publicationRequestId]);
      assert.equal(journal.rows[0].n, "0");
      const input = await inputFor(initial);
      assert.deepEqual(await one.dispatchConsumption.consumeForDispatch(input), {kind: "indeterminate"});
      // Acknowledged history stays replayable, without undoing independent changes.
      assert.deepEqual(await two.control.publishHead(original), {headVersion: 1, materializationHeadVersion: 1});
      assert.deepEqual(await materialization.observeBinding({...selected.scope, provider: selected.provider}), independent);
      // Only genuinely advancing authority may replace the independent binding.
      const next = {...initial, bindingRevision: 4, credentialGeneration: 2, credentialBindingRef: "credential:rotated",
        authorityHeadDigest: proposed.authorityHeadDigest === initial.authorityHeadDigest ? "head:advanced" : proposed.authorityHeadDigest};
      assert.deepEqual(await one.control.publishHead({head: next, publicationRequestId: "publish:advanced",
        expectedHeadVersion: 1, expectedMaterializationHeadVersion: 2}), {headVersion: 2, materializationHeadVersion: 3});
      const advanced = await materialization.observeBinding({...selected.scope, provider: selected.provider});
      assert.equal(advanced?.bindingRevision, 4); assert.equal(advanced?.credentialGeneration, 2);
      assert.deepEqual(await two.control.publishHead(original), {headVersion: 1, materializationHeadVersion: 1});
      assert.deepEqual((await one.control.observeHead(selected)).head, next);
      assert.deepEqual(await materialization.observeBinding({...selected.scope, provider: selected.provider}), advanced);
    }
  });

});
