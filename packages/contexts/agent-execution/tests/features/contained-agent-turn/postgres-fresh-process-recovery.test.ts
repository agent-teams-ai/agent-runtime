import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { postgresTest } from "./postgres-contained-turn-test-helpers.ts";

postgresTest("committed PostgreSQL authority survives fresh Node processes without redispatch or debt upgrade", () => {
  const worker = fileURLToPath(new URL("./support/postgres-fresh-process-worker.ts", import.meta.url));
  const run = (phase: string, input?: string) => {
    const child = spawnSync(process.execPath, [worker, phase], {
      env: { POSTGRES_DURABILITY_URL: process.env.POSTGRES_DURABILITY_URL },
      encoding: "utf8", input, timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  // spawnSync waits for process exit; no pool, store, or module cache survives.
  const committed = run("seed");
  const recovered = JSON.parse(run("recover", committed));
  assert.equal(recovered.recovered, true);
  assert.notEqual(recovered.pid, JSON.parse(committed).pid);
});

test("fresh-process worker fails closed without the expected PostgreSQL URL", () => {
  const worker = fileURLToPath(new URL("./support/postgres-fresh-process-worker.ts", import.meta.url));
  const child = spawnSync(process.execPath, [worker, "seed"], {
    env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /fresh process requires POSTGRES_DURABILITY_URL/u);
});
