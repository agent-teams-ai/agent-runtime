import assert from "node:assert/strict";
import test from "node:test";
import { execFileAsync } from "../live/provider-candidate-source.mjs";

// A fresh process installs the import guard before either live entrypoint loads.
// Its module cache and process-wide hooks cannot be primed by another test.
test("live imports are inert and missing separately trusted data causes zero candidate imports", async () => {
  const probe = new URL("./support/provider-canary-entrypoint-inertness.mjs", import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [probe.pathname], {
    env: {}, timeout: 30_000, maxBuffer: 1024 ** 2,
  });
  assert.equal(stdout, "canary entrypoint inertness assertions passed\n");
  assert.equal(stderr, "");
});
