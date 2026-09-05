import assert from "node:assert/strict";
import test from "node:test";

import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { submitContainedTurnLiveCanary } from "./support/contained-turn-live-canary-submission.mjs";

const command = {
  commandId: "command:one",
  expectedProvider: "codex" as const,
  intent: { mode: "analysis" as const, prompt: "inspect disposable state" },
  scope: { projectId: "project:one", tenantId: "tenant:one" },
};

test("canary submission preserves even an undefined primary rejection when disposal fails", async t => {
  for (const primary of [new Error("synthetic acceptance failure"), undefined]) {
    await t.test(String(primary), async () => {
      const { dependencies } = createDependencies();
      const events: string[] = [];
      await assert.rejects(submitContainedTurnLiveCanary({
        command,
        dependencies: {
          ...dependencies,
          operationStore: {
            ...dependencies.operationStore,
            accept: async () => { events.push("accept"); throw primary; },
          },
        },
        owner: { dispose: async () => { events.push("dispose"); throw new Error("secondary disposal failure"); } },
      }), error => error === primary);
      assert.deepEqual(events, ["accept", "dispose"]);
    });
  }
});

test("canary submission returns verified terminal evidence after disposing once", async () => {
  const { current, dependencies } = createDependencies();
  let disposals = 0;
  const result = await submitContainedTurnLiveCanary({
    command, dependencies, owner: { dispose: async () => { disposals += 1; } },
  });
  assert.equal(disposals, 1);
  assert.equal(result.turn.status, "succeeded");
  assert.deepEqual(result.turn.output, [{ cursor: 0, kind: "assistant", text: "ok" }]);
  assert.deepEqual(result.physicalContainment, current()?.physicalContainment);
  assert.equal(Object.isFrozen(result), true);
});

test("canary submission surfaces disposal failure after successful verification", async () => {
  const { current, dependencies } = createDependencies();
  const failure = new Error("synthetic disposal failure");
  let disposals = 0;
  await assert.rejects(submitContainedTurnLiveCanary({
    command, dependencies,
    owner: { dispose: async () => { disposals += 1; throw failure; } },
  }), error => error === failure);
  assert.equal(disposals, 1);
  assert.equal(current()?.terminal.kind, "final");
});
