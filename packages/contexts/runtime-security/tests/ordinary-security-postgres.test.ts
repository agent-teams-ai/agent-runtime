import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {Pool} from "pg";
import {createOrdinarySecurityOwner} from "../dist/composition.js";
const connectionString = process.env.ORDINARY_TEST_POSTGRES_URL;
test("ordinary security durable consumed identity, unknown-commit readback, settlement and no persisted secrets", {skip: connectionString === undefined}, async () => {
  const schema = `ordinary_rs_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({connectionString, max: 1}); const pool = new Pool({connectionString, options: `-c search_path=${schema}`, max: 4});
  const policy = {provider: "codex", mode: "workspace-write", executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1", ttlMs: 60000, maxOutputBytes: 2000000, maxArtifactBytes: 2000000} as const;
  const allowedScope = {tenantId: "TEST", projectId: "TEST"};
  const input = {operationId: "operation:TEST", attemptId: "attempt:TEST", scope: allowedScope, provider: policy.provider, mode: policy.mode, executionProfile: policy.executionProfile, effectClass: policy.effectClass, capabilityManifestRevision: policy.capabilityManifestRevision};
  let loseCommit = false;
  const wrapped = {connect: async () => {const client = await pool.connect(); return {query: async (sql: string, values?: unknown[]) => {const result = await client.query(sql, values); if (sql === "COMMIT" && loseCommit) {loseCommit = false; throw new Error("synthetic lost acknowledgement");} return result;}, release: (discard?: boolean) => client.release(discard)};}};
  const owner = createOrdinarySecurityOwner({pool: wrapped, allowedScope, policy});
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await owner.migrate(); loseCommit = true;
    const grant = await owner.resolveAndConsume(input);
    assert.equal((await owner.observe(input))?.authority.ownerReceiptId, grant.authority.ownerReceiptId);
    const duplicates = await Promise.all([owner.resolveAndConsume(input), owner.resolveAndConsume(input)]);
    assert.ok(duplicates.every(item => item.authority.grantId === grant.authority.grantId));
    assert.equal(owner.registerSecrets("unknown", ["secret-token"]), false);
    assert.equal(owner.registerSecrets(input.operationId, ["secret-token"]), true);
    assert.equal(grant.admitOutput("safe"), true);
    assert.equal(grant.admitArtifact(new TextEncoder().encode("safe result")), true);
    loseCommit = true; const settlement = await grant.settle("claim_committed");
    assert.equal((await owner.observe(input))?.settlement?.settlementReceiptId, settlement.settlementReceiptId);
    assert.equal(grant.admitOutput("late"), false);
    await assert.rejects(grant.settle("abandoned_without_claim"));
    await assert.rejects(owner.resolveAndConsume({...input, attemptId: "attempt:OTHER"}));
    const rows = await pool.query("SELECT state FROM runtime_security_ordinary_grants_v1");
    assert.equal(rows.rowCount, 1); assert.equal(JSON.stringify(rows.rows).includes("secret-token"), false);
    await owner.dispose(); assert.equal((await pool.query("SELECT 1 AS alive")).rows[0].alive, 1);
  } finally {await owner.dispose(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();}
});
