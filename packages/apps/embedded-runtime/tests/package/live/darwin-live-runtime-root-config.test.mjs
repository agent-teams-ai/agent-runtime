import assert from "node:assert/strict";
import test from "node:test";

import {createAnyTestAccountApproval} from "./darwin-live-runtime-root-config.mjs";

test("local any-test-account policy approves only exact isolated capture metadata without serialization", async () => {
  const scope = {tenantId: "tenant", projectId: "project", scopeDigest: "scope", descriptor: {provider: "codex"},
    validFromControlTime: 1, claimBeforeControlTime: 2, expiresAtControlTime: 3};
  const approval = createAnyTestAccountApproval(scope);
  assert.equal(typeof approval.approveCapture, "function");
  assert.equal(JSON.stringify(approval).includes("approveCapture"), false);
  const metadata = {accountId: "test-account-discovered-by-official-rpc", generation: 1, captureRef: "capture",
    provenance: "operator-owned-private-isolated-official-test-session",
    scope: {...scope, testSessionProvenance: "operator-owned-private-isolated-official-test-session"}};
  assert.equal(await approval.approveCapture(metadata), true);
  assert.equal(await approval.approveCapture({...metadata, scope: {...metadata.scope, tenantId: "foreign"}}), false);
  assert.equal(await approval.approveCapture({...metadata, captureRef: ""}), false);
  assert.throws(() => createAnyTestAccountApproval({...scope, approvedAccountId: "serialized-account"}), /RUNTIME_CONFIG_REFUSED/u);
});

test("runtime config import is inert and rejects unpinned owner modules", async () => {
  const module = await import("./darwin-live-runtime-root-config.mjs");
  await assert.rejects(module.acquireDarwinLiveOwners({files: [], paRuntimeModulePath: "/tmp/pa.mjs",
    infrastructureModulePath: "/tmp/infrastructure.mjs"}), /RUNTIME_CONFIG_REFUSED/);
  await assert.rejects(module.preflightDarwinInfrastructure({files: [],
    infrastructureModulePath: "/tmp/infrastructure.mjs"}), /RUNTIME_CONFIG_REFUSED/);
});
