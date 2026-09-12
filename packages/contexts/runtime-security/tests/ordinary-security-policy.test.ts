import assert from "node:assert/strict";
import test from "node:test";
import {captureOrdinarySecurityInput, captureOrdinarySecurityPolicy, createOrdinarySecretGuard} from "../dist/features/contained-turn-dispatch-authority/domain/ordinary-security-policy.js";
const policy = {provider: "codex", mode: "workspace-write", executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1", ttlMs: 60000, maxOutputBytes: 2000000, maxArtifactBytes: 2000000} as const;
const scope = {tenantId: "TEST", projectId: "TEST"};
const input = {operationId: "operation:TEST", attemptId: "attempt:TEST", scope, provider: policy.provider, mode: policy.mode, executionProfile: policy.executionProfile, effectClass: policy.effectClass, capabilityManifestRevision: policy.capabilityManifestRevision};
test("ordinary policy rejects scope/profile/provider drift, extra keys and unbounded TTL", () => {
  assert.deepEqual(captureOrdinarySecurityInput(input, scope, policy), input);
  assert.throws(() => captureOrdinarySecurityPolicy({...policy, ttlMs: 60001}));
  assert.throws(() => captureOrdinarySecurityInput({...input, scope: {...scope, tenantId: "OTHER"}}, scope, policy));
  assert.throws(() => captureOrdinarySecurityInput({...input, provider: "claude"} as typeof input, scope, policy));
  assert.throws(() => captureOrdinarySecurityPolicy({...policy, extra: true}));
});
test("output refuses before registration and blocks a secret split across canonical chunks", () => {
  const guard = createOrdinarySecretGuard(policy);
  assert.equal(guard.admitOutput("anything"), false);
  assert.equal(guard.registerSecrets(["actual-secret"]), true);
  assert.equal(guard.admitOutput("actual-"), true);
  assert.equal(guard.admitOutput("secret"), false);
  assert.equal(guard.admitOutput("later"), false);
});
test("artifact rejects cross-output secret reconstruction, invalid UTF8 and quotas", () => {
  const guard = createOrdinarySecretGuard(policy); guard.registerSecrets(["actual-secret"]);
  assert.equal(guard.admitOutput("actual-"), true);
  assert.equal(guard.admitArtifact(new TextEncoder().encode("secret")), false);
  const invalid = createOrdinarySecretGuard(policy); invalid.registerSecrets(["token"]);
  assert.equal(invalid.admitArtifact(new Uint8Array([255])), false);
  const quota = createOrdinarySecretGuard({...policy, maxOutputBytes: 2}); quota.registerSecrets(["token"]);
  assert.equal(quota.admitOutput("€"), false);
});
test("secret registration is operation-prepublication only and closure erases admission", () => {
  const guard = createOrdinarySecretGuard(policy); guard.registerSecrets(["token"]);
  assert.equal(guard.admitOutput("safe"), true); assert.equal(guard.registerSecrets(["new"]), false);
  assert.equal(guard.admitArtifact(new TextEncoder().encode("result")), true);
  assert.equal(guard.admitOutput("after artifact"), false);
  guard.dispose(); assert.equal(guard.admitArtifact(new TextEncoder().encode("result")), false);
});
