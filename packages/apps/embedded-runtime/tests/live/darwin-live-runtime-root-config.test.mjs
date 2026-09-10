import assert from "node:assert/strict";
import test from "node:test";

test("runtime config import is inert and rejects unpinned owner modules", async () => {
  const module = await import("./darwin-live-runtime-root-config.mjs");
  await assert.rejects(module.acquireDarwinLiveOwners({files: [], paRuntimeModulePath: "/tmp/pa.mjs",
    infrastructureModulePath: "/tmp/infrastructure.mjs"}), /RUNTIME_CONFIG_REFUSED/);
  await assert.rejects(module.preflightDarwinInfrastructure({files: [],
    infrastructureModulePath: "/tmp/infrastructure.mjs"}), /RUNTIME_CONFIG_REFUSED/);
});
