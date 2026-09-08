import assert from "node:assert/strict";
import test from "node:test";
import {createNodeDockerDeploymentRecipe} from "../../../dist/features/contained-agent-turn/composition/node-docker-deployment-recipe.js";
import {bindContainedTurnRouteEnforcement, createContainedTurnRouteEnforcement,
  readContainedTurnSelectedRouteAdmission} from "../../../dist/features/contained-agent-turn/composition/contained-turn-route-enforcement-capability.js";
import {policy} from "../../fixtures/docker-engine-test-fixture.ts";

const binding = {tenantId: "tenant:test", projectId: "project:test", scopeDigest: "scope:test",
  operationId: "operation:test", attemptId: "attempt:test", custodyId: "custody:test", sourceRevision: "source:test",
  binaryRevision: "binary:test", hostBootId: "boot:test", executionGenerationId: "generation:test",
  adapterRevision: "adapter:test", capabilityManifestRevision: "manifest:test", authorityVectorDigest: "authority:test",
  providerAccountRef: "account:test", accessRef: "access:test", bindingRevision: 3, credentialBindingRef: "credential:test",
  providerRouteRef: "route:test", routeRevision: "revision:1", credentialBindingDigest: "opaque:test", credentialGeneration: 7};
const pin = {path: "/synthetic/tool", sha256: "a".repeat(64)};
const fixture = () => {
  const enginePolicy = policy("/synthetic");
  const node = createNodeDockerDeploymentRecipe({enginePolicy, routeSubject: binding,
    custodyJournalRoot: "/synthetic/custody", resourceJournalRoot: "/synthetic/resources", nsenter: pin, nft: pin,
    consumption: {directory: {path: "/synthetic/consumption", device: "1", inode: "1"},
      readEnvelope() {throw new Error("unused");}}});
  const capability = createContainedTurnRouteEnforcement({enginePolicy, binding, nsenter: pin, nft: pin,
    engine: {async inspect() {throw new Error("unused");}}, qualificationTarget: {
      provider: "codex", providerAdapter: binding.adapterRevision, binaryClosure: binding.binaryRevision,
      platform: "linux-x64", credentialRoute: "route:test", storageTopology: "storage:test",
      transportTopology: "transport:test", failureDomain: "host:test"}});
  return {node, capability};
};

test("provenance refuses self-erasing enginePolicy substitution without invoking the getter", () => {
  const {node, capability} = fixture();
  const preparation = {...node.preparation};
  let reads = 0;
  Object.defineProperty(preparation, "enginePolicy", {configurable: true, enumerable: true, get() {
    reads++;
    preparation.openLifecycle = () => {throw new Error("substituted lifecycle");};
    Object.defineProperty(preparation, "enginePolicy", {value: node.preparation.enginePolicy});
    Object.freeze(preparation);
    return node.preparation.enginePolicy;
  }});
  assert.throws(() => bindContainedTurnRouteEnforcement(capability, binding, {route: node.route, preparation}), TypeError);
  assert.equal(reads, 0);
  // Rejection does not consume the legitimate recipe.
  assert.ok(readContainedTurnSelectedRouteAdmission(bindContainedTurnRouteEnforcement(capability, binding, node)));
});

test("recipe, route and nested preparation accessors and proxies are inert rejections", () => {
  for (const field of ["recipe", "route", "preparation", "enginePolicy", "nested"] as const) {
    for (const proxy of [false, true]) {
      const {node, capability} = fixture();
      let calls = 0;
      const trap = () => {calls++; throw new Error("must not execute");};
      const poison = (value: object) => proxy ? new Proxy(value, {
        get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap,
      }) : Object.defineProperty({...value}, "poison", {get: trap});
      const preparation = {...node.preparation, subjectFacts: {scopeSha256: "original"}};
      let recipe = {route: node.route, preparation};
      if (field === "recipe") {recipe = poison(recipe) as typeof recipe;}
      if (field === "route") {recipe.route = poison(node.route) as typeof node.route;}
      if (field === "preparation") {recipe.preparation = poison(preparation) as typeof preparation;}
      if (field === "enginePolicy") {preparation.enginePolicy = poison(preparation.enginePolicy) as typeof preparation.enginePolicy;}
      if (field === "nested") {preparation.subjectFacts = poison(preparation.subjectFacts) as typeof preparation.subjectFacts;}
      assert.throws(() => bindContainedTurnRouteEnforcement(capability, binding, recipe), TypeError);
      assert.equal(calls, 0, `${field} proxy=${proxy}`);
    }
  }
});

test("callback proxies and class port accessors are rejected without running caller code", () => {
  for (const kind of ["callback", "class"] as const) {
    const {node, capability} = fixture();
    let calls = 0;
    const trap = () => {calls++; throw new Error("must not execute");};
    class Clock {get read() {return trap();} within() {return true;}}
    const preparation = {...node.preparation,
      ...(kind === "callback" ? {openLifecycle: new Proxy(node.preparation.openLifecycle, {apply: trap, get: trap})}
        : {resources: {localCut: {clock: new Clock()}}})};
    assert.throws(() => bindContainedTurnRouteEnforcement(capability, binding, {route: node.route, preparation}), TypeError);
    assert.equal(calls, 0);
  }
});

test("selection retains immutable nested facts and exact lifecycle functions while borrowing class ports", async () => {
  const {node, capability} = fixture();
  class Clock {
    #count = 0;
    read() {return ++this.#count;}
    within() {return true;}
  }
  const clock = new Clock();
  const cancellation = new AbortController();
  const preparation = {...node.preparation, enginePolicy: {...node.preparation.enginePolicy,
    allowedEnvironmentKeys: [...node.preparation.enginePolicy.allowedEnvironmentKeys]},
    create: {arguments: ["original"], environment: {KEY: "original"}},
    subjectFacts: {scopeSha256: "original"}, initOptions: {signal: cancellation.signal, authority: {expectedIdentity: {generation: "original"}}},
    deadlines: {routeMs: 100}, resources: {localCut: {clock, expectedClock: {generation: "original"}}, consumption: node.consumption}};
  const recipe = {route: node.route, preparation};
  const selected = bindContainedTurnRouteEnforcement(capability, binding, recipe);
  const captured: typeof preparation = selected.preparation;
  assert.notEqual(captured, preparation);
  assert.equal(captured.openLifecycle, node.preparation.openLifecycle);
  assert.equal(captured.engineIdentity, node.preparation.engineIdentity);
  assert.equal(captured.openResourceJournal, node.preparation.openResourceJournal);
  preparation.create.arguments[0] = "changed";
  preparation.create.environment.KEY = "changed";
  preparation.enginePolicy.allowedEnvironmentKeys.push("CHANGED");
  preparation.subjectFacts.scopeSha256 = "changed";
  preparation.initOptions.authority.expectedIdentity.generation = "changed";
  preparation.deadlines.routeMs = 0;
  preparation.resources.localCut.expectedClock.generation = "changed";
  preparation.openLifecycle = () => {throw new Error("changed");};
  recipe.preparation = {...preparation};
  clock.read = () => -1;
  assert.equal(captured.create.arguments[0], "original");
  assert.equal(captured.create.environment.KEY, "original");
  assert.equal(captured.subjectFacts.scopeSha256, "original");
  assert.equal(captured.initOptions.authority.expectedIdentity.generation, "original");
  assert.equal(captured.resources.localCut.expectedClock.generation, "original");
  assert.equal(captured.deadlines.routeMs, 100);
  assert.equal(captured.enginePolicy.allowedEnvironmentKeys.includes("CHANGED"), false);
  assert.equal(captured.resources.localCut.clock.read(), 1);
  assert.equal(captured.resources.localCut.clock.read(), 2);
  assert.equal(Object.isFrozen(clock), false);
  assert.equal(Object.isFrozen(preparation), false);
  assert.equal(Object.isFrozen(captured.create.arguments), true);
  assert.equal(captured.openLifecycle, node.preparation.openLifecycle);
  assert.throws(() => captured.openLifecycle({...captured.enginePolicy, allowedNetworkName: "ar-unallocated"}), /lifecycle order/);
  assert.equal(captured.initOptions.signal.aborted, false);
  cancellation.abort("closed");
  assert.equal(captured.initOptions.signal.aborted, true);
  assert.equal(captured.initOptions.signal.reason, "closed");
  assert.equal(Object.isFrozen(cancellation.signal), false);
  assert.deepEqual(Object.keys(capability), ["admission"]);
  assert.equal(await node.releaseAfterHostCleanup({signal: new AbortController().signal, deadlineEpochMs: Date.now() + 1000}), "released");
});
