import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {test} from "node:test";
import type {Pool} from "pg";
import {PostgresHttpEgressEvidence, initializePostgresHttpEgressEvidence} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/postgres-http-egress-evidence.js";
import {HTTP_EVIDENCE_FENCE} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/postgres-http-egress-evidence-transactions.js";
import {initialHttpEgressState} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-settlement.js";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {createEgressFixture} from "./http-egress-test-fixture.ts";

const scope = {tenantId: "tenant-1", projectId: "project-1", deploymentId: "deployment-1"};
const receipt = () => ({schema: "agent-runtime.host-http-egress-receipt/v1" as const,
  operationId: "operation-1", attemptId: "attempt-1", requestId: "request-1", ...initialHttpEgressState()});
const fakePool = () => {
  const rows = new Map<string, string>();
  const calls: string[] = []; const releases: boolean[] = [];
  let loseCommit = false; let failRead = false; let format = HTTP_EVIDENCE_FENCE;
  const pool = {connect: async () => ({query: async (sql: string, values: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("SELECT version")) {return {rows: [{version: 1, format}]};}
    const key = JSON.stringify(values.slice(0, 6));
    if (sql.includes("INSERT INTO host_http_egress.receipt") && !rows.has(key)) {rows.set(key, values[6] as string);}
    if (sql.includes("SELECT canonical_receipt")) {
      if (failRead) {throw new Error("read unavailable");}
      return {rows: rows.has(key) ? [{canonical_receipt: rows.get(key)}] : []};
    }
    if (sql === "COMMIT" && loseCommit) {loseCommit = false; throw new Error("ack lost after commit");}
    return {rows: []};
  }, release: (destroy: boolean) => releases.push(destroy)})} as unknown as Pool;
  return {pool, rows, calls, releases, loseCommit: () => {loseCommit = true;},
    failRead: () => {failRead = true;}, wrongFence: () => {format = "other";}};
};

test("constructor is inert, snapshots scope, and digest hashes concatenated bytes without framing", async () => {
  const fake = fakePool(); const mutable = {...scope}; const owner = new PostgresHttpEgressEvidence(fake.pool, mutable);
  mutable.tenantId = "changed";
  assert.equal(fake.calls.length, 0);
  const parts = [new Uint8Array([0, 255]), new Uint8Array([128, 10])];
  assert.equal(owner.digest(parts), createHash("sha256").update(Buffer.concat(parts)).digest("hex"));
  assert.equal(owner.digest([]), createHash("sha256").digest("hex"));
  assert.equal(await owner.record(receipt()), "recorded");
  assert.equal(JSON.parse([...fake.rows.keys()][0]!)[0], scope.tenantId);
});

test("complete canonical replay ignores field order and conflicts on changed evidence", async () => {
  const fake = fakePool(); const owner = new PostgresHttpEgressEvidence(fake.pool, scope); const original = receipt();
  assert.equal(await owner.record(original), "recorded");
  assert.equal(await owner.record(Object.fromEntries(Object.entries(original).toReversed()) as typeof original), "recorded");
  for (const change of [{anomalyCode: "evidence_ack_lost"}, {inboundRequestBytes: 1}, {requestDigest: "another-digest"},
    {outboundResponseWriteUncertain: true}, {upstreamClosure: "unknown"}]) {
    assert.equal(await owner.record({...original, ...change} as typeof original), "conflict");
  }
  assert.equal(fake.rows.size, 1);
});

test("rejects accessors, proxies, unknown fields, raw payload and unsafe values before I/O", async () => {
  const fake = fakePool(); const owner = new PostgresHttpEgressEvidence(fake.pool, scope);
  let touched = false;
  const accessor = Object.defineProperty(receipt(), "requestDigest", {get: () => {touched = true; return "secret";}});
  const proxy = new Proxy(receipt(), {ownKeys: () => {touched = true; throw new Error("trap");}});
  const revoked = Proxy.revocable(receipt(), {}); revoked.revoke();
  for (const invalid of [accessor, proxy, revoked.proxy, {...receipt(), body: "secret"},
    {...receipt(), [Symbol("raw")]: "secret"}, {...receipt(), operationId: "bad\nidentity"},
    {...receipt(), requestDigest: "x".repeat(513)}, {...receipt(), requestDigest: "\ud800"},
    {...receipt(), selectedPeer: "https://user:password@example.org/body"},
    {...receipt(), inboundRequestBytes: NaN}, {...receipt(), upstreamRequestBytes: -1},
    {...receipt(), attemptCount: 2}, {...receipt(), anomalyCode: "unknown"}, {...receipt(), schema: "v2"}]) {
    await assert.rejects(owner.record(invalid as typeof accessor), TypeError);
  }
  assert.equal(touched, false); assert.equal(fake.calls.length, 0);
  assert.throws(() => new PostgresHttpEgressEvidence(fake.pool, {...scope, tenantId: ""}), TypeError);
});

test("ambiguous commit preserves original; replay is storage-only and read/fence uncertainty fails closed", async () => {
  const fake = fakePool(); const owner = new PostgresHttpEgressEvidence(fake.pool, scope);
  fake.loseCommit(); assert.equal(await owner.record(receipt()), "unknown");
  const saved = [...fake.rows.values()][0];
  assert.equal(fake.releases.at(-1), true);
  assert.equal(await owner.record(receipt()), "recorded");
  assert.equal(await owner.record({...receipt(), anomalyCode: "evidence_ack_lost"}), "conflict");
  assert.equal([...fake.rows.values()][0], saved);
  fake.failRead(); assert.equal(await owner.record(receipt()), "unknown");
  const fenced = fakePool(); fenced.wrongFence();
  assert.equal(await new PostgresHttpEgressEvidence(fenced.pool, scope).record(receipt()), "unknown");
  assert.equal(fenced.rows.size, 0);
});

test("broker acknowledgement loss does not rewrite original or retry provider", async () => {
  const fixture = createEgressFixture(); const fake = fakePool();
  const owner = new PostgresHttpEgressEvidence(fake.pool, scope); fake.loseCommit();
  const result = await createStrictHttpEgressBroker({...fixture.ports, evidence: owner}).execute(fixture.operation);
  assert.equal(result.anomalyCode, "evidence_ack_lost");
  assert.equal(result.outcome, "reconcile_required");
  assert.equal(fixture.observations.dispatches, 1);
  const original = JSON.parse([...fake.rows.values()][0]!);
  assert.equal(original.anomalyCode, "none");
  assert.equal(await owner.record(original), "recorded");
  assert.equal(await owner.record(result), "conflict");
  assert.equal(fixture.observations.dispatches, 1);
});

// Explicit opt-in only. The root creates a new dedicated database; this test
// never creates/drops databases or resets schemas and refuses any nonempty DB.
const longId = () => randomBytes(256).toString("hex");
const url = process.env.HOST_HTTP_EVIDENCE_TEST_DATABASE_URL;
test("real PostgreSQL race, ambiguous COMMIT and fresh-pool reload", {skip: !url}, async () => {
  assert.equal(process.env.HOST_HTTP_EVIDENCE_TEST_FRESH_DATABASE, "yes");
  const target = new URL(url!);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  assert.match(databaseName, /^http_evidence_test_[a-z0-9_]+$/);
  const {Pool: PgPool} = await import("pg");
  const config = {connectionString: url, connectionTimeoutMillis: 5_000,
    query_timeout: 5_000, statement_timeout: 4_000, max: 6};
  const pool = new PgPool(config);
  let poolEnded = false;
  try {
    // Verify the connected target as well as URL spelling before any owner DDL.
    const connected = await pool.query("SELECT current_database() AS name");
    assert.equal(connected.rows[0]?.name, databaseName, "connection must match the explicitly disposable target");
    const existing = await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','p','v','m','S','f')`);
    assert.equal(existing.rows.length, 0, "requires a fresh disposable database");
    const schemas = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = 'host_http_egress'");
    assert.equal(schemas.rows.length, 0);
    const owner = new PostgresHttpEgressEvidence(pool, scope);
    assert.equal(await owner.record(receipt()), "unknown", "no automatic initialization");
    await initializePostgresHttpEgressEvidence(pool);
    await initializePostgresHttpEgressEvidence(pool);
    assert.deepEqual(await Promise.all(Array.from({length: 6}, () => owner.record(receipt()))), Array(6).fill("recorded"));
    const longScope = {tenantId: longId(), projectId: longId(), deploymentId: longId()};
    const longReceipt = {...receipt(), operationId: longId(), attemptId: longId(), requestId: longId()};
    const longOwner = new PostgresHttpEgressEvidence(pool, longScope);
    assert.equal(await longOwner.record(longReceipt), "recorded", "bounded IDs must fit the fixed-size index");
    assert.equal(await longOwner.record(longReceipt), "recorded");
    const raced = {...receipt(), requestId: "race"};
    const outcomes = await Promise.all([owner.record(raced), owner.record({...raced, inboundRequestBytes: 1})]);
    assert.deepEqual(outcomes.toSorted(), ["conflict", "recorded"]);
    for (const changedScope of [{...scope, tenantId: "tenant-2"}, {...scope, projectId: "project-2"},
      {...scope, deploymentId: "deployment-2"}]) {
      assert.equal(await new PostgresHttpEgressEvidence(pool, changedScope).record({...receipt(), inboundRequestBytes: 2}), "recorded");
    }
    let lost = false;
    const ambiguousPool = {connect: async () => {
      const client = await pool.connect();
      return {release: (destroy: boolean) => client.release(destroy), query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql === "COMMIT" && !lost) {lost = true; throw new Error("ack lost after actual COMMIT");}
        return result;
      }};
    }} as unknown as Pool;
    const ambiguous = {...receipt(), requestId: "ambiguous"};
    assert.equal(await new PostgresHttpEgressEvidence(ambiguousPool, scope).record(ambiguous), "unknown");
    await pool.end(); poolEnded = true;
    const fresh = new PgPool(config);
    try {
      const reloaded = new PostgresHttpEgressEvidence(fresh, scope);
      assert.equal(await reloaded.record(ambiguous), "recorded");
      assert.equal(await reloaded.record({...ambiguous, anomalyCode: "evidence_ack_lost"}), "conflict");
      const stored = await fresh.query("SELECT canonical_receipt FROM host_http_egress.receipt WHERE request_id='ambiguous'");
      assert.deepEqual(JSON.parse(stored.rows[0].canonical_receipt), ambiguous);
      await fresh.query("UPDATE host_http_egress.version_fence SET version=2");
      assert.equal(await reloaded.record(receipt()), "unknown");
      await assert.rejects(initializePostgresHttpEgressEvidence(fresh), /fence mismatch/);
    } finally {await fresh.end();}
  } finally {if (!poolEnded) {await pool.end();}}
});
