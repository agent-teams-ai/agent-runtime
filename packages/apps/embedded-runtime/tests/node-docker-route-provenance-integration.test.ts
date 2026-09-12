import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import test from "node:test";

// The APP owns deployment composition; putting this in AE would invert the
// package dependency. Keep process-wide module mocks in an isolated test worker.
test("deployment route provenance integration", () => {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [...process.execArgv,
    "--experimental-test-module-mocks", "--test",
    new URL("./support/route-provenance-integration.mjs", import.meta.url).pathname],
  {env, encoding: "utf8", timeout: 30_000});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS actual deployment -> nominal admission/);
});
