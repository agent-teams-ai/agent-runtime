import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { postgresTest } from "./postgres-contained-turn-test-helpers.ts";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { createPostgresReplayApplication } from "./support/postgres-replay-application.ts";

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
  assert.equal(recovered.preventedReceiptReplayed, true);
  assert.equal(JSON.parse(committed).providerCalls, 1);
  assert.equal(recovered.providerCalls, 0);
  assert.equal(recovered.totalProviderCalls, 1);
  assert.notEqual(recovered.pid, JSON.parse(committed).pid);
});

test("synthetic application seed reaches one counted provider and durably records ambiguity", async () => {
  const store = createDependencies().dependencies.operationStore;
  const scope = { projectId: "project:one", tenantId: "tenant:one" };
  const input = { commandId: "command:one", expectedProvider: "codex" as const,
    intent: { mode: "analysis" as const, prompt: "Inspect the disposable workspace." }, scope };
  const seed = createPostgresReplayApplication(store, scope);
  const result = await seed.application.submit(input);
  assert.equal(result.status, "observed");
  if (result.status !== "observed") {throw new Error("missing synthetic submission");}
  assert.equal(seed.providerCalls.value, 1);
  assert.equal(seed.starts.value, 1);
  assert.equal(result.operation.reconciliation.kind, "required");
  assert.equal(result.operation.providerProcessStart.kind, "execution_started");
  assert.equal(result.operation.output.chunks[0]?.text, "committed before process exit");
  assert.equal(seed.claims.length, 1);
  assert.deepEqual(await store.read({ operationId: result.operation.operationId, scope }), result.operation);
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
