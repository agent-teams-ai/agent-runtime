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

test("failure evidence retains persisted terminal and result facts when owner teardown rejects", async () => {
  const { createCandidateRunObservation } = await import("../../live/provider-candidate-run-observation.mjs");
  const { safeObservations } = await import("../../live/provider-candidate-evidence-schema.mjs");
  const { current, dependencies } = createDependencies();
  const observation = createCandidateRunObservation();
  const failure = new Error("synthetic-secret-that-must-not-be-retained");
  await assert.rejects(submitContainedTurnLiveCanary({
    command, dependencies, onObserved: observation.result,
    owner: {dispose: () => observation.dispose("ownerDisposal", async () => {throw failure;})},
  }), error => error === failure);
  await observation.dispose("runtimeDisposal", async () => {});
  const facts = safeObservations(observation.evidence("failed").observations);
  assert.equal(current()?.terminal.kind, "final");
  assert.equal(facts.terminalStatus, "succeeded");
  assert.equal(facts.ownerDisposal, "failed");
  assert.equal(facts.runtimeDisposal, "completed");
  assert.match(facts.resultRefDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(facts.artifactManifestRefDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(facts), /synthetic-secret|errorDigest|artifact:one|result:one/u);
  assert.equal(facts.outputDigest, undefined, "unverified output is not hashed on failure");
});

test("runtime teardown failure cannot erase owner teardown or persisted kernel truth", async () => {
  const { createCandidateRunObservation } = await import("../../live/provider-candidate-run-observation.mjs");
  const { dependencies } = createDependencies();
  const observation = createCandidateRunObservation();
  await submitContainedTurnLiveCanary({
    command, dependencies, onObserved: observation.result,
    owner: {dispose: () => observation.dispose("ownerDisposal", async () => {})},
  });
  await assert.rejects(observation.dispose("runtimeDisposal", async () => {throw new Error("cleanup failed");}));
  const facts = observation.evidence("failed").observations;
  assert.equal(facts.terminalStatus, "succeeded");
  assert.equal(facts.ownerDisposal, "completed");
  assert.equal(facts.runtimeDisposal, "failed");
});
