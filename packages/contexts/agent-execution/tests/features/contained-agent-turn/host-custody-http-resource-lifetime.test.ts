import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { hostHttpAbortOperations } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-http-resource-lifetime.js";

test("HTTP lifetime cleanup invokes the retained abort Disposable", () => {
  let disposed = 0;
  hostHttpAbortOperations.remove({ [Symbol.dispose]() { disposed += 1; } });
  assert.equal(disposed, 1);
});

test("HTTP lifetime disposal removes the listener and is idempotent before abort", () => {
  const controller = new AbortController();
  let calls = 0;
  const subscription = hostHttpAbortOperations.subscribe(controller.signal, () => { calls += 1; });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  hostHttpAbortOperations.remove(subscription);
  hostHttpAbortOperations.remove(subscription);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  assert.equal(calls, 0);
});

test("HTTP lifetime abort survives stopped propagation and disposal after delivery", () => {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  let calls = 0;
  const subscription = hostHttpAbortOperations.subscribe(controller.signal, () => { calls += 1; });
  controller.abort();
  hostHttpAbortOperations.remove(subscription);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
});


test("HTTP lifetime disposal ignores signal cleanup replaced after subscription", () => {
  const controller = new AbortController();
  let reads = 0;
  let calls = 0;
  const subscription = hostHttpAbortOperations.subscribe(controller.signal, () => { calls += 1; });
  Object.defineProperty(controller.signal, "removeEventListener", {
    get() { reads += 1; throw new Error("mutable cleanup"); },
  });
  hostHttpAbortOperations.remove(subscription);
  hostHttpAbortOperations.remove(subscription);
  assert.equal(reads, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  assert.equal(calls, 0);
});
