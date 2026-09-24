import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnOperationProviderAccessPort } from
  "../../../dist/features/contained-agent-turn/composition/provider-access-anti-corruption.js";
import { createContainedTurnSecurityAcceptancePort } from
  "../../../dist/features/contained-agent-turn/composition/runtime-security-acceptance-anti-corruption.js";

const noCall = () => {throw new Error("rejected owner method was invoked");};

test("Provider Access operation bridge rejects accessor methods before capture", () => {
  let reads = 0;
  const dispatchConsumption = Object.freeze({
    consumeForDispatch: noCall, publishAndConsumeForDispatch: noCall,
    observeDispatchConsumption: noCall, settleDispatchConsumption: noCall,
  });
  const outer = Object.freeze({
    resolve: Object.freeze({execute: noCall}), revalidate: Object.freeze({execute: noCall}),
    dispatchConsumption,
  });
  const hostile = Object.freeze(Object.defineProperty({...outer}, "dispatchConsumption", {
    enumerable: true, get() {reads += 1; throw new Error("accessor invoked");},
  }));
  assert.throws(() => createContainedTurnOperationProviderAccessPort(hostile as never), TypeError);
  assert.equal(reads, 0);
});

test("Runtime Security acceptance bridge rejects accessor methods before capture", () => {
  let reads = 0;
  const outer = Object.freeze(Object.defineProperty({
    publishAndConsumeForDispatch: noCall, observeDispatchConsumption: noCall,
    settleDispatchConsumption: noCall,
  }, "evaluateForAcceptance", {
    enumerable: true, get() {reads += 1; throw new Error("accessor invoked");},
  }));
  assert.throws(() => createContainedTurnSecurityAcceptancePort(
    outer as never, Object.freeze({policyRevision: "security-authority:revision"}),
  ), TypeError);
  assert.equal(reads, 0);
});
