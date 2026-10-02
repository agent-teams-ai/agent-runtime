import assert from "node:assert/strict";
import test from "node:test";
import {createOrdinarySecurityGrantOwner} from "../../../dist/features/contained-turn-dispatch-authority/application/ordinary-security-owner.js";
import {OrdinarySecurityCommitUnknownError, OrdinarySecurityStoreUnavailableError, type OrdinarySecurityGrantStore} from "../../../dist/features/contained-turn-dispatch-authority/application/ports/ordinary-security-grant-store.js";
import {ordinarySecurityDigest} from "../../../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/ordinary-security-owner.js";
import {decideOrdinarySecuritySettle, ordinarySecurityDenied, serializeOrdinarySecurityRecord, type OrdinarySecurityGrantRecord} from "../../../dist/features/contained-turn-dispatch-authority/domain/ordinary-security-policy.js";

const policy = {provider: "codex", mode: "workspace-write", executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1", ttlMs: 60000, maxOutputBytes: 2000000, maxArtifactBytes: 2000000} as const;
const allowedScope = {tenantId: "TEST", projectId: "TEST"};
const input = {operationId: "operation:TEST", attemptId: "attempt:TEST", scope: allowedScope, provider: policy.provider, mode: policy.mode, executionProfile: policy.executionProfile, effectClass: policy.effectClass, capabilityManifestRevision: policy.capabilityManifestRevision};

const slot = (key: {tenantId: string; projectId: string; operationId: string}) => `${key.tenantId}/${key.projectId}/${key.operationId}`;
/** In-memory store with the port contract, plus one-shot failures injected per method. */
const fixture = () => {
  const rows = new Map<string, OrdinarySecurityGrantRecord>();
  const calls = {insert: 0, observe: 0, settle: 0};
  const failures: {insert?: Error; settle?: Error; observe?: Error; afterWrite?: boolean} = {};
  const store: OrdinarySecurityGrantStore = {
    async insertIfAbsent(record) {
      calls.insert += 1;
      const key = slot({...record.input.scope, operationId: record.input.operationId});
      const failure = failures.insert; failures.insert = undefined;
      if (failure !== undefined && failures.afterWrite !== true) {throw failure;}
      const existing = rows.get(key); if (existing === undefined) {rows.set(key, record);}
      if (failure !== undefined) {throw failure;}
      return existing === undefined ? {kind: "inserted", record} : {kind: "existing", record: existing};
    },
    async observe(key) {
      calls.observe += 1;
      const failure = failures.observe; failures.observe = undefined; if (failure !== undefined) {throw failure;}
      return rows.get(slot(key));
    },
    async settle(key, settlement) {
      calls.settle += 1;
      const prior = rows.get(slot(key)); if (prior === undefined) {return {kind: "missing"};}
      const failure = failures.settle; failures.settle = undefined;
      if (failure !== undefined && failures.afterWrite !== true) {throw failure;}
      const decision = decideOrdinarySecuritySettle(prior, settlement, ordinarySecurityDigest);
      if (decision.kind === "settle") {rows.set(slot(key), {...prior, settlement: decision.settlement});}
      if (failure !== undefined) {throw failure;}
      return decision.kind === "conflict" ? {kind: "conflict"} : {kind: decision.kind === "settle" ? "settled" : "already", settlement: decision.settlement};
    },
  };
  let clock = 1_000_000; let counter = 0;
  const owner = createOrdinarySecurityGrantOwner({store, allowedScope, policy, now: () => clock, digest: ordinarySecurityDigest,
    newId: () => `00000000-0000-4000-8000-${String(counter += 1).padStart(12, "0")}`});
  return {owner, rows, calls, failures, advance: (ms: number) => {clock += ms;}};
};

test("ordinary security consume is idempotent within the TTL and refused after settlement or expiry", async () => {
  const {owner, calls, advance} = fixture();
  const [first, second] = await Promise.all([owner.resolveAndConsume(input), owner.resolveAndConsume(input)]);
  assert.equal(first, second);
  assert.equal((await owner.resolveAndConsume(input)).authority.grantId, first.authority.grantId);
  assert.equal(calls.observe, 0);
  assert.equal(first.admitOutput("safe"), false, "admission needs registered secrets first");
  advance(policy.ttlMs);
  assert.equal(first.admitOutput("late"), false);
  await assert.rejects(owner.resolveAndConsume(input), /ORDINARY_SECURITY_DENIED/u);
  const settled = fixture(); const grant = await settled.owner.resolveAndConsume(input);
  await grant.settle("claim_committed");
  await assert.rejects(settled.owner.resolveAndConsume(input), /ORDINARY_SECURITY_DENIED/u);
});

test("ordinary security reads back only after commit-unknown or unavailable, never after a refusal", async () => {
  const refused = fixture();
  refused.failures.insert = ordinarySecurityDenied();
  await assert.rejects(refused.owner.resolveAndConsume(input), /ORDINARY_SECURITY_DENIED/u);
  assert.equal(refused.calls.observe, 0, "a decoder or policy refusal must not be masked as readback");

  const unknown = fixture();
  unknown.failures.insert = new OrdinarySecurityCommitUnknownError(); unknown.failures.afterWrite = true;
  const grant = await unknown.owner.resolveAndConsume(input);
  assert.equal(unknown.calls.observe, 1);
  assert.equal(grant.authority.grantId, [...unknown.rows.values()][0]?.authority.grantId);

  const lost = fixture();
  lost.failures.insert = new OrdinarySecurityStoreUnavailableError();
  await assert.rejects(lost.owner.resolveAndConsume(input), /ORDINARY_SECURITY_DENIED/u);
  assert.equal(lost.calls.observe, 1);

  const broken = fixture();
  broken.failures.insert = new TypeError("not a store outcome");
  await assert.rejects(broken.owner.resolveAndConsume(input), TypeError);
  assert.equal(broken.calls.observe, 0);
});

test("ordinary security settle is idempotent for one disposition, a conflict for another, and reads back only when uncertain", async () => {
  const state = fixture(); const grant = await state.owner.resolveAndConsume(input);
  const receipt = await grant.settle("claim_committed");
  assert.deepEqual(await grant.settle("claim_committed"), receipt);
  await assert.rejects(grant.settle("abandoned_without_claim"), /ORDINARY_SECURITY_DENIED/u);
  assert.equal(state.calls.observe, 0);

  const unknown = fixture(); const pending = await unknown.owner.resolveAndConsume(input);
  unknown.failures.settle = new OrdinarySecurityCommitUnknownError(); unknown.failures.afterWrite = true;
  const accepted = await pending.settle("abandoned_without_claim");
  assert.equal(accepted.disposition, "abandoned_without_claim"); assert.equal(unknown.calls.observe, 1);

  const refused = fixture(); const again = await refused.owner.resolveAndConsume(input);
  refused.failures.settle = ordinarySecurityDenied();
  await assert.rejects(again.settle("claim_committed"), /ORDINARY_SECURITY_DENIED/u);
  assert.equal(refused.calls.observe, 0);

  const other = fixture(); const wrong = await other.owner.resolveAndConsume(input);
  other.failures.settle = new OrdinarySecurityStoreUnavailableError();
  await assert.rejects(wrong.settle("claim_committed"), /ORDINARY_SECURITY_DENIED/u);
  assert.equal(other.calls.observe, 1);
  assert.equal(await other.owner.observe(input).then(found => found?.settlement), null);
});

test("ordinary security observe refuses another input and the stored record carries no secrets", async () => {
  const {owner, rows} = fixture(); const grant = await owner.resolveAndConsume(input);
  assert.equal(owner.registerSecrets(input.operationId, ["secret-token"]), true);
  assert.equal(grant.admitOutput("safe"), true);
  assert.equal(grant.admitOutput("leaks secret-token"), false);
  await assert.rejects(owner.observe({...input, attemptId: "attempt:OTHER"}), /ORDINARY_SECURITY_DENIED/u);
  await assert.rejects(owner.resolveAndConsume({...input, attemptId: "attempt:OTHER"}), /ORDINARY_SECURITY_DENIED/u);
  assert.equal((await owner.observe(input))?.authority.grantId, grant.authority.grantId);
  const text = [...rows.values()].map(serializeOrdinarySecurityRecord).join("");
  assert.equal(text.includes("secret-token"), false);
  await owner.dispose();
  await assert.rejects(owner.observe(input), /ORDINARY_SECURITY_DENIED/u);
});
