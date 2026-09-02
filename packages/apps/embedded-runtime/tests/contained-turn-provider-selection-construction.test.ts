import assert from "node:assert/strict";
import test from "node:test";

import {
  composeHostCustodiedContainedTurn,
} from "../dist/composition/contained-turn-feature-composition.js";
import { composeHostCustodiedAgentRuntimeHost } from
  "../dist/composition/host-custodied-agent-runtime-host.js";
import { ContainedTurnConstructionCleanupError } from
  "../dist/composition/contained-turn-construction-failure.js";

const capability = Object.freeze({
  cancel: Object.freeze({execute: async () => Object.freeze({status: "not_found" as const})}),
  observe: Object.freeze({execute: async () => Object.freeze({status: "not_found" as const})}),
  submit: Object.freeze({execute: async () => Object.freeze({status: "denied" as const})}),
});

const dependencies = (selectedProvider: unknown) => Object.freeze({
  artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
  providerAccess: Object.freeze({}), security: Object.freeze({}), selectedProvider,
  workspace: Object.freeze({}),
});

const harness = (disposeFailure?: Error) => {
  const calls = {claude: 0, codex: 0, dispose: 0, feature: 0};
  const owner = Object.freeze({
    custody: Object.freeze({}),
    dispose() {calls.dispose += 1; if (disposeFailure !== undefined) {throw disposeFailure;}},
    provider: Object.freeze({}),
  });
  return {
    calls,
    factories: Object.freeze({
      claude: (() => {calls.claude += 1; return owner;}) as never,
      codex: (() => {calls.codex += 1; return owner;}) as never,
    }),
    featureFactory: ((input: object) => {
      calls.feature += 1;
      assert.deepEqual(Reflect.ownKeys(input).toSorted(),
        ["artifacts", "custody", "operationStore", "provider", "providerAccess", "security", "workspace"]);
      return capability;
    }) as never,
  };
};

test("exact Codex and Claude selections invoke only the selected owner factory", () => {
  for (const kind of ["codex", "claude"] as const) {
    const selected = Object.freeze({kind, owner: Object.freeze({})});
    const probe = harness();
    const product = composeHostCustodiedContainedTurn(
      dependencies(selected) as never, probe.factories, probe.featureFactory,
    );
    assert.equal(product.feature, capability);
    assert.deepEqual(probe.calls, {
      claude: kind === "claude" ? 1 : 0, codex: kind === "codex" ? 1 : 0, dispose: 0, feature: 1,
    });
    product.dispose();
    product.dispose();
    assert.equal(probe.calls.dispose, 1);
  }
});

test("invalid selection shapes fail before either provider factory and redact unknown IDs", () => {
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessor, {
    kind: {enumerable: true, get: () => "codex"},
    owner: {enumerable: true, value: Object.freeze({})},
  });
  const cases: readonly unknown[] = [
    undefined,
    Object.freeze({owner: Object.freeze({})}),
    Object.freeze({kind: "provider-secret-value", owner: Object.freeze({})}),
    Object.freeze({kind: "codex", owner: Object.freeze({}), provider: "claude"}),
    accessor,
  ];
  for (const selection of cases) {
    const probe = harness();
    let published: unknown;
    assert.throws(
      () => {published = composeHostCustodiedContainedTurn(
        dependencies(selection) as never, probe.factories, probe.featureFactory,
      );},
      error => error instanceof TypeError && error.message === "Contained turn provider selection is invalid" &&
        !error.message.includes("provider-secret-value"),
    );
    assert.equal(published, undefined);
    assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
  }
});

test("own descriptor snapshot rejects accessor dependencies and observable mutation races", () => {
  const selectionAccessor = Object.freeze(Object.defineProperty({}, "selectedProvider", {
    enumerable: true, get: () => Object.freeze({kind: "codex", owner: Object.freeze({})}),
  }));
  const probe = harness();
  assert.throws(() => composeHostCustodiedContainedTurn(
    selectionAccessor as never, probe.factories, probe.featureFactory,
  ), /provider selection is invalid/u);

  let reads = 0;
  const drifting = new Proxy({kind: "codex", owner: Object.freeze({})}, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === "kind" && descriptor !== undefined) {
        reads += 1;
        return {...descriptor, value: reads === 1 ? "codex" : "claude"};
      }
      return descriptor;
    },
  });
  assert.throws(() => composeHostCustodiedContainedTurn(
    dependencies(drifting) as never, probe.factories, probe.featureFactory,
  ), /provider selection is invalid/u);
  assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
});

test("selection mutation while factory options are read is rejected before factory invocation", () => {
  const probe = harness();
  const selected: {kind: string; owner: object} = {kind: "codex", owner: Object.freeze({})};
  selected.owner = new Proxy({}, {
    ownKeys() {selected.kind = "claude"; return [];},
  });
  assert.throws(() => composeHostCustodiedContainedTurn(
    dependencies(selected) as never, probe.factories, probe.featureFactory,
  ), /provider selection is invalid/u);
  assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
});

test("selected factory failure publishes nothing and invokes no later construction", () => {
  const probe = harness();
  const failure = new Error("synthetic selected factory failure");
  const factories = Object.freeze({...probe.factories,
    codex: (() => {probe.calls.codex += 1; throw failure;}) as never});
  let published: unknown;
  assert.throws(() => {published = composeHostCustodiedContainedTurn(
    dependencies(Object.freeze({kind: "codex", owner: Object.freeze({})})) as never,
    factories, probe.featureFactory,
  );}, error => error === failure);
  assert.equal(published, undefined);
  assert.deepEqual(probe.calls, {claude: 0, codex: 1, dispose: 0, feature: 0});
});

test("later feature failure disposes its owner exactly once and publishes no capability", () => {
  const primary = new Error("synthetic feature construction failure");
  const probe = harness();
  let published: unknown;
  assert.throws(() => {published = composeHostCustodiedContainedTurn(
    dependencies(Object.freeze({kind: "codex", owner: Object.freeze({})})) as never,
    probe.factories, (() => {probe.calls.feature += 1; throw primary;}) as never,
  );}, error => error === primary);
  assert.equal(published, undefined);
  assert.deepEqual(probe.calls, {claude: 0, codex: 1, dispose: 1, feature: 1});
});

test("cleanup failure has a bounded classification and preserves both failures", () => {
  const primary = new Error("synthetic feature construction failure");
  const cleanup = new Error("synthetic owner cleanup failure");
  const probe = harness(cleanup);
  assert.throws(() => composeHostCustodiedContainedTurn(
    dependencies(Object.freeze({kind: "claude", owner: Object.freeze({})})) as never,
    probe.factories, (() => {probe.calls.feature += 1; throw primary;}) as never,
  ), error => error instanceof ContainedTurnConstructionCleanupError &&
    error.code === "contained_turn_construction_cleanup_failed" && error.cause === primary &&
    error.errors[0] === primary && error.errors[1] === cleanup);
  assert.deepEqual(probe.calls, {claude: 1, codex: 0, dispose: 1, feature: 1});
});

test("later Host construction failure disposes the contained owner and publishes no Host", () => {
  const failure = new Error("synthetic Host construction failure");
  let disposed = 0;
  let published: unknown;
  assert.throws(() => {published = composeHostCustodiedAgentRuntimeHost({
    capabilities: Object.freeze({claudeCodeSetup: Object.freeze({}), codexSetup: Object.freeze({})}),
    containedTurn: Object.freeze({}),
  } as never, () => Object.freeze({feature: capability, dispose: () => {disposed += 1;}}),
  () => {throw failure;});}, error => error === failure);
  assert.equal(published, undefined);
  assert.equal(disposed, 1);
});
