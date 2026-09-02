import assert from "node:assert/strict";
import test from "node:test";

import {
  composeHostCustodiedContainedTurn,
  createHostCustodiedContainedTurn,
  ProviderRouteEnforcementUnsupportedError,
} from "../dist/composition/contained-turn-feature-composition.js";
import { composeHostCustodiedAgentRuntimeHost } from
  "../dist/composition/host-custodied-agent-runtime-host.js";
import { ContainedTurnConstructionCleanupError, ContainedTurnOwnerDisposalError } from
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

const invalidSelectionMessage = "Contained turn provider selection is invalid";

const captureThrown = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to throw");
};

const assertRedactedValidationError = (
  published: unknown,
  original: unknown,
  markers: readonly string[],
  message = invalidSelectionMessage,
) => {
  assert.ok(published instanceof TypeError);
  assert.notEqual(published, original);
  assert.equal(published.message, message);
  assert.equal("cause" in published, false);
  assert.equal("custom" in published, false);
  assert.deepEqual(Reflect.ownKeys(published).toSorted(), ["message", "stack"]);
  const diagnostic = `${published.message}\n${published.stack ?? ""}`;
  for (const marker of markers) {assert.equal(diagnostic.includes(marker), false);}
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

test("production provider selection fails closed before every construction effect", () => {
  for (const kind of ["codex", "claude"] as const) {
    let reads = 0;
    const routeClaims = Object.freeze({
      authorityDigest: "sha256:claimed-authority",
      canaryReceipt: "receipt:claimed-canary",
      manifest: "manifest:claimed-provider",
      providerRouteRef: `route:${kind}:claimed-egress`,
    });
    const input = new Proxy({selectedProvider: Object.freeze({kind, owner: routeClaims})}, {
      get() {reads += 1; throw new Error("production gate read candidate dependencies");},
      getOwnPropertyDescriptor() {reads += 1; throw new Error("production gate inspected candidate dependencies");},
      ownKeys() {reads += 1; throw new Error("production gate enumerated candidate dependencies");},
    });
    let published: unknown;
    assert.throws(() => {published = createHostCustodiedContainedTurn(input as never);}, error =>
      error instanceof ProviderRouteEnforcementUnsupportedError &&
      error.reason === "route-enforcement-unqualified" &&
      error.message === "route-enforcement-unqualified" && Object.isFrozen(error));
    assert.equal(published, undefined);
    assert.equal(reads, 0);
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

test("hostile selection traps and trap accessors cannot publish thrown validation details", () => {
  const secret = "credential-secret-7fc2";
  const path = "/private/runtime/customer-42";
  const provider = "unqualified-provider-customer-42";
  const causes = [
    () => Object.assign(new TypeError(invalidSelectionMessage), {
      cause: new Error(secret), custom: path, provider, stack: `hostile-stack ${provider}`,
    }),
    () => Object.assign(new TypeError(`nonmatching ${secret}`), {
      cause: path, custom: provider, stack: `hostile-stack ${path}`,
    }),
    () => Object.assign(new Error(`ordinary ${path}`), {
      cause: provider, custom: secret, stack: `hostile-stack ${secret}`,
    }),
    () => ({cause: secret, custom: path, message: invalidSelectionMessage, provider,
      stack: `hostile-stack ${secret} ${path} ${provider}`}),
  ] as const;

  for (const makeOriginal of causes) {
    for (const seam of ["proxy-trap", "trap-accessor"] as const) {
      const original = makeOriginal();
      const selectedProvider = seam === "proxy-trap"
        ? Object.freeze({kind: "codex", owner: Object.freeze({})})
        : new Proxy({kind: "codex", owner: Object.freeze({})}, Object.defineProperty(
          {}, "ownKeys", {get() {throw original;}},
        ) as ProxyHandler<{kind: string; owner: object}>);
      const input = seam === "proxy-trap"
        ? new Proxy(dependencies(selectedProvider), {
          getOwnPropertyDescriptor() {throw original;},
        })
        : dependencies(selectedProvider);
      const probe = harness();

      const published = captureThrown(() => composeHostCustodiedContainedTurn(
        input as never, probe.factories, probe.featureFactory,
      ));

      assertRedactedValidationError(
        published, original, [secret, path, provider],
        seam === "proxy-trap" ? "Contained turn Provider Access dependency is invalid" : invalidSelectionMessage,
      );
      assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
    }
  }
});

test("own descriptor snapshot rejects accessor dependencies and observable mutation races", () => {
  const selectionAccessor = Object.freeze(Object.defineProperty({
    artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
    providerAccess: Object.freeze({}), security: Object.freeze({}), workspace: Object.freeze({}),
  }, "selectedProvider", {
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

test("cleanup failure publishes only a fixed private bounded diagnostic", () => {
  const primary = new Error("primary-secret-credential");
  const cleanup = new Error("cleanup-secret-path");
  const probe = harness(cleanup);
  const error = captureThrown(() => composeHostCustodiedContainedTurn(
    dependencies(Object.freeze({kind: "claude", owner: Object.freeze({})})) as never,
    probe.factories, (() => {probe.calls.feature += 1; throw primary;}) as never,
  ));
  assert.ok(error instanceof ContainedTurnConstructionCleanupError);
  assert.equal(error.code, "contained_turn_construction_cleanup_failed");
  assert.equal(error.name, "ContainedTurnConstructionCleanupError");
  assert.equal(error.message, "Contained turn construction cleanup failed");
  assert.equal(error.stack, undefined);
  assert.equal("cause" in error, false);
  assert.equal("errors" in error, false);
  assert.deepEqual(Reflect.ownKeys(error).toSorted(), ["code", "message", "name"]);
  assert.doesNotMatch(`${error.name}:${error.message}:${error.stack ?? ""}:${JSON.stringify(error)}`,
    /primary-secret|cleanup-secret/u);
  assert.deepEqual(probe.calls, {claude: 1, codex: 0, dispose: 1, feature: 1});
});

test("provider owner result is captured as exact data before feature dependencies are observed", () => {
  const valid = Object.freeze({custody: Object.freeze({}), dispose() {}, provider: Object.freeze({})});
  let hostileTrapCalls = 0;
  const hostileHandler = {
    get() {hostileTrapCalls += 1; throw new Error("owner-proxy-secret");},
    getOwnPropertyDescriptor() {hostileTrapCalls += 1; throw new Error("owner-proxy-secret");},
    getPrototypeOf() {hostileTrapCalls += 1; throw new Error("owner-proxy-secret");},
    ownKeys() {hostileTrapCalls += 1; throw new Error("owner-proxy-secret");},
  } satisfies ProxyHandler<object>;
  const disposeProxy = new Proxy(() => {}, hostileHandler);
  const accessor = Object.freeze(Object.defineProperties({}, {
    custody: {enumerable: true, value: Object.freeze({})},
    dispose: {enumerable: true, get() {hostileTrapCalls += 1; return () => {};}},
    provider: {enumerable: true, value: Object.freeze({})},
  }));
  const cases = [
    new Proxy(valid, hostileHandler),
    {custody: valid.custody, dispose: valid.dispose, provider: valid.provider},
    Object.freeze({custody: valid.custody, dispose: valid.dispose}),
    Object.freeze({...valid, extra: true}),
    Object.freeze(Object.assign(Object.create({authority: true}), valid)),
    accessor,
    Object.freeze({custody: valid.custody, dispose: disposeProxy, provider: valid.provider}),
  ];
  for (const owner of cases) {
    const probe = harness();
    let featureCalls = 0;
    const error = captureThrown(() => composeHostCustodiedContainedTurn(
      dependencies(Object.freeze({kind: "codex", owner: Object.freeze({})})) as never,
      Object.freeze({...probe.factories, codex: (() => owner) as never}),
      (() => {featureCalls += 1; return capability;}) as never,
    ));
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "Contained turn provider owner is invalid");
    assert.equal("cause" in error, false);
    assert.equal(featureCalls, 0);
  }
  assert.equal(hostileTrapCalls, 0);
});

test("real Host composition rejects Provider Access accessors before all other ports and owners", () => {
  const secret = "provider-access-getter-secret";
  let providerAccessReads = 0;
  let otherReads = 0;
  const hostile = Object.defineProperties({}, {
    providerAccess: {enumerable: true, get() {providerAccessReads += 1; throw new Error(secret);}},
    operationStore: {get() {otherReads += 1;}},
    security: {get() {otherReads += 1;}},
    workspace: {get() {otherReads += 1;}},
    artifacts: {get() {otherReads += 1;}},
    hostCustody: {get() {otherReads += 1;}},
    selectedProvider: {get() {otherReads += 1;}},
  });
  const probe = harness();
  const error = captureThrown(() => composeHostCustodiedContainedTurn(
    hostile as never, probe.factories, probe.featureFactory,
  ));
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, "Contained turn Provider Access dependency is invalid");
  assert.equal("cause" in error, false);
  assert.doesNotMatch(`${error.name}:${error.message}:${error.stack ?? ""}`, /provider-access-getter-secret/u);
  assert.equal(providerAccessReads, 0);
  assert.equal(otherReads, 0);
  assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
});

test("contained owner disposal is retryable and redacts the failed attempt", () => {
  let disposeCalls = 0;
  const owner = Object.freeze({
    custody: Object.freeze({}),
    dispose() {
      disposeCalls += 1;
      if (disposeCalls === 1) {throw new Error("owner-disposal-secret");}
    },
    provider: Object.freeze({}),
  });
  const probe = harness();
  const product = composeHostCustodiedContainedTurn(
    dependencies(Object.freeze({kind: "codex", owner: Object.freeze({})})) as never,
    Object.freeze({...probe.factories, codex: (() => owner) as never}), probe.featureFactory,
  );
  const error = captureThrown(product.dispose);
  assert.ok(error instanceof ContainedTurnOwnerDisposalError);
  assert.equal(error.code, "contained_turn_owner_disposal_failed");
  assert.deepEqual(Reflect.ownKeys(error).toSorted(), ["code", "message", "name"]);
  assert.doesNotMatch(JSON.stringify(error), /owner-disposal-secret/u);
  product.dispose();
  product.dispose();
  assert.equal(disposeCalls, 2);
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

test("Host construction plus owner-cleanup failure is redacted", () => {
  const primary = new Error("host-construction-primary-secret");
  const cleanup = new Error("host-construction-cleanup-secret");
  const error = captureThrown(() => composeHostCustodiedAgentRuntimeHost({
    capabilities: Object.freeze({claudeCodeSetup: Object.freeze({}), codexSetup: Object.freeze({})}),
    containedTurn: Object.freeze({}),
  } as never, () => Object.freeze({
    feature: capability,
    dispose() {throw cleanup;},
  }), () => {throw primary;}));
  assert.ok(error instanceof ContainedTurnConstructionCleanupError);
  assert.equal(error.name, "ContainedTurnConstructionCleanupError");
  assert.equal(error.message, "Contained turn construction cleanup failed");
  assert.equal(error.stack, undefined);
  assert.equal("cause" in error, false);
  assert.equal("errors" in error, false);
  assert.deepEqual(Reflect.ownKeys(error).toSorted(), ["code", "message", "name"]);
  assert.doesNotMatch(`${error.name}:${error.message}:${error.stack ?? ""}:${JSON.stringify(error)}`,
    /host-construction-(primary|cleanup)-secret/u);
});

test("Host wrapper retries contained-owner disposal after a failed attempt", async () => {
  let hostDisposals = 0;
  let ownerDisposals = 0;
  const host = composeHostCustodiedAgentRuntimeHost({
    capabilities: Object.freeze({claudeCodeSetup: Object.freeze({}), codexSetup: Object.freeze({})}),
    containedTurn: Object.freeze({}),
  } as never, () => Object.freeze({
    feature: capability,
    dispose() {
      ownerDisposals += 1;
      if (ownerDisposals === 1) {throw new ContainedTurnOwnerDisposalError();}
    },
  }), () => Object.freeze({
    bindAccess() {throw new Error("unused");},
    async dispose() {hostDisposals += 1;},
  }) as never);
  await assert.rejects(host.dispose(), error => error instanceof ContainedTurnOwnerDisposalError);
  await host.dispose();
  await host.dispose();
  assert.equal(ownerDisposals, 2);
  assert.equal(hostDisposals, 3);
});
