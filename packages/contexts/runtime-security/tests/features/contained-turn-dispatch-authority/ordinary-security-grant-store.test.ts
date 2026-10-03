import assert from "node:assert/strict";
import {setImmediate} from "node:timers/promises";
import test from "node:test";
import {createPostgresOrdinarySecurityGrantStore, ordinarySecurityDigest} from "../../../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/ordinary-security-owner.js";
import {OrdinarySecurityCommitUnknownError, OrdinarySecurityStoreUnavailableError} from "../../../dist/features/contained-turn-dispatch-authority/application/ports/ordinary-security-grant-store.js";
import {captureOrdinarySecurityInput, newOrdinarySecurityRecord, ordinarySecuritySettlementFor, ordinarySecurityKeyOf, serializeOrdinarySecurityRecord, type OrdinarySecurityGrantRecord} from "../../../dist/features/contained-turn-dispatch-authority/domain/ordinary-security-policy.js";
import type {DispatchPgClient} from "../../../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/transaction.js";

const policy = {provider: "codex", mode: "workspace-write", executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1", ttlMs: 60000, maxOutputBytes: 2000000, maxArtifactBytes: 2000000} as const;
const allowedScope = {tenantId: "TEST", projectId: "TEST"};
const input = captureOrdinarySecurityInput({operationId: "operation:TEST", attemptId: "attempt:TEST", scope: allowedScope, provider: policy.provider, mode: policy.mode, executionProfile: policy.executionProfile, effectClass: policy.effectClass, capabilityManifestRevision: policy.capabilityManifestRevision}, allowedScope, policy);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const candidate = (n: number): OrdinarySecurityGrantRecord => newOrdinarySecurityRecord(input, policy, {grantId: `ordinary-security-grant:${uuid(n)}`, ownerReceiptId: `ordinary-security-consumption:${uuid(n)}`}, Date.now(), ordinarySecurityDigest);
const key = ordinarySecurityKeyOf(input);

const slot = (values: unknown[] | undefined) => (values ?? []).slice(0, 3).join("/");
/** Single-table stand-in for the statements this store issues; the real database is covered by the postgres gate. */
const fakePool = () => {
  const table = new Map<string, {state: string; state_digest: string}>();
  const control = {failCommit: false, failQuery: false, hang: false, released: [] as boolean[], hangingQueries: 0, statements: [] as string[]};
  const pool = {connect: async () => ({
    query: async (sql: string, values?: unknown[]) => {
      control.statements.push(sql);
      if (sql === "COMMIT" && control.failCommit) {throw new Error("synthetic lost acknowledgement");}
      if (/^(SELECT|INSERT|UPDATE)/u.test(sql) && control.failQuery) {throw new Error("synthetic driver failure");}
      if (sql.startsWith("SELECT state")) {
        if (control.hang) {control.hangingQueries += 1; return new Promise<never>(() => {/* never settles; close() must abort it */});}
        const row = table.get(slot(values)); return {rows: row === undefined ? [] : [{...row}], rowCount: row === undefined ? 0 : 1};
      }
      if (sql.startsWith("INSERT")) {
        if (table.has(slot(values))) {return {rows: [], rowCount: 0};}
        table.set(slot(values), {state: values?.[3] as string, state_digest: values?.[4] as string}); return {rows: [], rowCount: 1};
      }
      if (sql.startsWith("UPDATE")) {table.set(slot(values), {state: values?.[3] as string, state_digest: values?.[4] as string}); return {rows: [], rowCount: 1};}
      return {rows: [], rowCount: null};
    },
    release: (discard?: boolean) => {control.released.push(discard === true);},
  } satisfies DispatchPgClient)};
  return {pool, table, control};
};
const storeOver = (pool: ReturnType<typeof fakePool>["pool"], overridePolicy = policy) => createPostgresOrdinarySecurityGrantStore({pool, allowedScope, policy: overridePolicy});

test("ordinary security store keeps one record for parallel insertIfAbsent and returns it byte for byte", async () => {
  const {pool} = fakePool(); const store = storeOver(pool);
  const results = await Promise.all([1, 2, 3, 4].map(n => store.insertIfAbsent(candidate(n))));
  assert.equal(results.filter(result => result.kind === "inserted").length, 1);
  const texts = new Set(results.map(result => serializeOrdinarySecurityRecord(result.record)));
  assert.equal(texts.size, 1);
  assert.equal(serializeOrdinarySecurityRecord((await store.observe(key))!), [...texts][0]);
});

test("ordinary security store refuses tampered rows, another policy and a foreign scope without masking them as unavailable", async () => {
  const {pool, table} = fakePool(); const store = storeOver(pool);
  await store.insertIfAbsent(candidate(1));
  await assert.rejects(storeOver(pool, {...policy, ttlMs: 30000}).observe(key), /ORDINARY_SECURITY_DENIED/u);
  await assert.rejects(store.insertIfAbsent(newOrdinarySecurityRecord({...input, scope: {tenantId: "OTHER", projectId: "TEST"}}, policy, {grantId: `ordinary-security-grant:${uuid(9)}`, ownerReceiptId: `ordinary-security-consumption:${uuid(9)}`}, Date.now(), ordinarySecurityDigest)), /ORDINARY_SECURITY_DENIED/u);
  const row = [...table.values()][0]!;
  const original = {...row};
  row.state_digest = "0".repeat(64);
  await assert.rejects(store.observe(key), /ORDINARY_SECURITY_DENIED/u);
  row.state_digest = original.state_digest;
  row.state = original.state.replace("ordinary-security-grant:", "ordinary-security-grant: ");
  row.state_digest = ordinarySecurityDigest(row.state);
  await assert.rejects(store.observe(key), /ORDINARY_SECURITY_DENIED/u);
  row.state = original.state; row.state_digest = original.state_digest;
  assert.ok(await store.observe(key));
  table.set("TEST/TEST/operation:OTHER", {...original});
  await assert.rejects(store.observe({...key, operationId: "operation:OTHER"}), /ORDINARY_SECURITY_DENIED/u, "a row filed under another key is refused");
});

test("ordinary security store settle is idempotent for one disposition and a conflict for another", async () => {
  const {pool, table} = fakePool(); const store = storeOver(pool); const record = candidate(1);
  assert.deepEqual(await store.settle(key, ordinarySecuritySettlementFor(record.authority, "claim_committed", ordinarySecurityDigest)), {kind: "missing"});
  await store.insertIfAbsent(record);
  const claim = ordinarySecuritySettlementFor(record.authority, "claim_committed", ordinarySecurityDigest);
  assert.deepEqual(await store.settle(key, claim), {kind: "settled", settlement: claim});
  const stored = [...table.values()][0]!.state;
  assert.deepEqual(await store.settle(key, claim), {kind: "already", settlement: claim});
  assert.equal([...table.values()][0]!.state, stored);
  assert.deepEqual(await store.settle(key, ordinarySecuritySettlementFor(record.authority, "abandoned_without_claim", ordinarySecurityDigest)), {kind: "conflict"});
  assert.deepEqual(await store.settle(key, {...claim, settlementReceiptId: "ordinary-security-settlement:forged"}), {kind: "conflict"});
  assert.equal((await store.observe(key))?.settlement?.disposition, "claim_committed");
});

test("ordinary security store classifies commit-unknown and unavailable and never reads back by itself", async () => {
  const lost = fakePool(); const store = storeOver(lost.pool);
  lost.control.failCommit = true;
  await assert.rejects(store.insertIfAbsent(candidate(1)), OrdinarySecurityCommitUnknownError);
  assert.equal(lost.table.size, 1, "the write happened; only the acknowledgement was lost");
  assert.equal(lost.control.released.at(-1), true, "a connection with an unknown commit is discarded");
  assert.equal(lost.control.statements.at(-1), "COMMIT", "nothing is read back after the lost acknowledgement");
  lost.control.failCommit = false; lost.control.failQuery = true;
  await assert.rejects(store.observe(key), OrdinarySecurityStoreUnavailableError);
});

test("ordinary security store close aborts an in-flight transaction and discards its connection", async () => {
  const state = fakePool(); const store = storeOver(state.pool);
  state.control.hang = true;
  const inFlight = assert.rejects(store.observe(key), OrdinarySecurityStoreUnavailableError);
  while (state.control.hangingQueries === 0) {await setImmediate();}
  await store.close(); await inFlight;
  assert.equal(state.control.released.at(-1), true);
  await assert.rejects(store.observe(key), OrdinarySecurityStoreUnavailableError);
});
