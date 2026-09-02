import assert from "node:assert/strict";
import test from "node:test";

import { runContainedTurnLiveCanaryLifecycle } from "./contained-turn-live-canary-lifecycle.mjs";

test("failure before kernel open preserves the primary error without inventing containment", async () => {
  const primary = new Error("secret provider open failure");
  let containmentCalls = 0;
  let disposeCalls = 0;

  await assert.rejects(runContainedTurnLiveCanaryLifecycle({
    dispose: async () => { disposeCalls += 1; },
    execute: async () => { throw new Error("execution must not run"); },
    open: async () => { throw primary; },
    requestPhysicalContainment: async () => {
      containmentCalls += 1;
      throw new Error("containment must not run");
    },
  }), error => error === primary);

  assert.equal(containmentCalls, 0);
  assert.equal(disposeCalls, 1);
});

test("failure after kernel open requests containment and preserves the primary error", async () => {
  const primary = new Error("secret provider start failure");
  const events = [];

  await assert.rejects(runContainedTurnLiveCanaryLifecycle({
    dispose: async () => {
      events.push("dispose");
      throw new Error("secondary disposal failure");
    },
    execute: async reservation => {
      assert.deepEqual(reservation, { custodyId: "custody:synthetic" });
      events.push("execute");
      throw primary;
    },
    open: async () => {
      events.push("open");
      return Object.freeze({ custodyId: "custody:synthetic" });
    },
    requestPhysicalContainment: async () => {
      events.push("contain");
      throw new Error("secondary containment failure");
    },
  }), error => error === primary);

  assert.deepEqual(events, ["open", "execute", "contain", "dispose"]);
});

test("containment failure after successful execution remains primary and disposal still runs", async () => {
  const containmentFailure = new Error("synthetic containment failure");
  const events = [];

  await assert.rejects(runContainedTurnLiveCanaryLifecycle({
    dispose: async () => {
      events.push("dispose");
      throw new Error("synthetic secondary disposal failure");
    },
    execute: async reservation => {
      assert.deepEqual(reservation, { custodyId: "custody:synthetic" });
      events.push("execute");
      return Object.freeze({ status: "completed" });
    },
    open: async () => {
      events.push("open");
      return Object.freeze({ custodyId: "custody:synthetic" });
    },
    requestPhysicalContainment: async () => {
      events.push("contain");
      throw containmentFailure;
    },
  }), error => error === containmentFailure);

  assert.deepEqual(events, ["open", "execute", "contain", "dispose"]);
});

test("disposal failure remains visible after successful execution and containment", async () => {
  const disposalFailure = new Error("synthetic disposal failure");
  const events = [];

  await assert.rejects(runContainedTurnLiveCanaryLifecycle({
    dispose: async () => {
      events.push("dispose");
      throw disposalFailure;
    },
    execute: async reservation => {
      assert.deepEqual(reservation, { custodyId: "custody:synthetic" });
      events.push("execute");
      return Object.freeze({ status: "completed" });
    },
    open: async () => {
      events.push("open");
      return Object.freeze({ custodyId: "custody:synthetic" });
    },
    requestPhysicalContainment: async () => {
      events.push("contain");
      return Object.freeze({ status: "contained" });
    },
  }), error => error === disposalFailure);

  assert.deepEqual(events, ["open", "execute", "contain", "dispose"]);
});
