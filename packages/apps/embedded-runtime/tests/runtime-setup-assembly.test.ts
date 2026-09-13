import { compileComposition, defineModule } from "@get-modular/core";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDefaultAgentRuntimeHost, AgentRuntimeHostCreationError } from "../dist/composition.js";
import { createRuntimeSetupAttempt } from "../dist/composition/default-agent-runtime-host.js";
import { bindRuntimeSetup, runtimeSetupDeclarations, runtimeSetupProfile, createRuntimeSetupFactories } from "../dist/composition/runtime-setup-assembly.js";
import { createExactParityHost, fixtureScope, registerPassiveSetupScenarios } from "./helpers/assembly-direct-reference.ts";

registerPassiveSetupScenarios("Assembly", () => createDefaultAgentRuntimeHost());

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((_resolve, _reject) => { resolve = _resolve; reject = _reject; });
  return { promise, resolve, reject };
};

test("already cancelled bootstrap performs zero product work", async () => {
  const controller = new AbortController();
  controller.abort({ secret: "must not escape" });
  let calls = 0;
  await assert.rejects(createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    calls += 1;
    return createRuntimeSetupFactories(platform);
  }), (error: unknown) => error instanceof AgentRuntimeHostCreationError && error.code === "cancelled");
  assert.equal(calls, 0);
});

test("hostile genuine signal accessor at preflight rejects safely without product work", async () => {
  const controller = new AbortController();
  let reasonReads = 0;
  let calls = 0;
  const getterCause = { secret: "test-fixture-literal" };
  Object.defineProperty(controller.signal, "aborted", { get() { throw getterCause; } });
  Object.defineProperty(controller.signal, "reason", { get() { reasonReads += 1; throw "TEST-reason-secret"; } });
  await assert.rejects(createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    calls += 1;
    return createRuntimeSetupFactories(platform);
  }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.notEqual(error, getterCause);
    assert.equal(error.code, "invalid_options");
    assert.equal(error.phase, "options");
    assert.equal(error.cancellationObserved, false);
    assert.equal(error.cleanupFailed, false);
    assert.deepEqual(error.diagnostics, []);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /test-fixture-literal|TEST-reason-secret/);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(reasonReads, 0);
});

test("abort during preflight is checked before run and options signal is captured once", async () => {
  const controller = new AbortController();
  let reads = 0;
  let factoriesCreated = 0;
  let productCalls = 0;
  let runsObserved = 0;
  const noProduct = (): never => { productCalls += 1; throw new Error("preflight started product work"); };
  await assert.rejects(createRuntimeSetupAttempt({ get signal() {
    reads += 1;
    return controller.signal;
  } }, () => {
    factoriesCreated += 1;
    // This is after successful async compile, before async preparation settles.
    controller.abort();
    return { security: noProduct, discovery: noProduct, codexConfiguration: noProduct,
      claudeConfiguration: noProduct, codexPlanner: noProduct, claudePlanner: noProduct, host: noProduct };
  }, { observeOutcome: () => { runsObserved += 1; } }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.phase, "prepare");
    assert.equal(error.cancellationObserved, true);
    return true;
  });
  assert.equal(reads, 1);
  assert.equal(factoriesCreated, 1);
  assert.equal(productCalls, 0);
  assert.equal(runsObserved, 0);
});

test("input capture errors reject with closed diagnostics", async () => {
  let calls = 0;
  const secret = { get toJSON() { calls += 1; throw new Error("secret"); } };
  const result = createDefaultAgentRuntimeHost({ get signal(): AbortSignal { throw secret; } });
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "invalid_options");
    assert.equal("cause" in error, false);
    assert.doesNotMatch(JSON.stringify(error), /secret/);
    assert.ok(structuredClone(error));
    return true;
  });
  assert.equal(calls, 0);
});

test("raw rejection prototype traps are never inspected", async () => {
  let traps = 0;
  const raw = new Proxy({}, { getPrototypeOf() { traps += 1; throw new Error("secret trap"); } });
  await assert.rejects(createDefaultAgentRuntimeHost({ get signal(): AbortSignal { throw raw; } }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "invalid_options");
    assert.doesNotMatch(JSON.stringify(error), /secret trap/);
    return true;
  });
  assert.equal(traps, 0);
});

for (const key of ["security", "discovery", "codexConfiguration", "claudeConfiguration", "codexPlanner", "claudePlanner", "host"] as const) {
  test(`factory failure remains primary: ${key}`, async () => {
    const calls: string[] = [];
    const composition = await compileComposition({ declarations: runtimeSetupDeclarations, profile: runtimeSetupProfile });
    assert.ok(composition.ok);
    const moduleIds = { security: "agent-runtime/setup-security", discovery: "agent-runtime/installation-discovery", codexConfiguration: "agent-runtime/codex-configuration", claudeConfiguration: "agent-runtime/claude-configuration", codexPlanner: "agent-runtime/codex-planner", claudePlanner: "agent-runtime/claude-planner", host: "agent-runtime/runtime-host" } as const;
    const expected = composition.plan.dependencyOrder;
    const secret = { toJSON() { throw new Error("raw cause executed"); } };
    await assert.rejects(createRuntimeSetupAttempt(undefined, (platform) => {
      const factories = createRuntimeSetupFactories(platform);
      const record = (called: keyof typeof moduleIds) => {
        calls.push(moduleIds[called]);
        if (called === key) { throw secret; }
      };
      return {
        security: () => { record("security"); return factories.security(); },
        discovery: () => { record("discovery"); return factories.discovery(); },
        codexConfiguration: () => { record("codexConfiguration"); return factories.codexConfiguration(); },
        claudeConfiguration: () => { record("claudeConfiguration"); return factories.claudeConfiguration(); },
        codexPlanner: () => { record("codexPlanner"); return factories.codexPlanner(); },
        claudePlanner: () => { record("claudePlanner"); return factories.claudePlanner(); },
        host: (dependencies) => { record("host"); return factories.host(dependencies); },
      };
    }), (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeHostCreationError);
      assert.equal(error.code, "factory_failed");
      assert.equal(error.moduleId, ({ security: "agent-runtime/setup-security", discovery: "agent-runtime/installation-discovery", codexConfiguration: "agent-runtime/codex-configuration", claudeConfiguration: "agent-runtime/claude-configuration", codexPlanner: "agent-runtime/codex-planner", claudePlanner: "agent-runtime/claude-planner", host: "agent-runtime/runtime-host" } as const)[key]);
      assert.equal(error.cancellationObserved, false);
      assert.doesNotMatch(JSON.stringify(error), /raw cause/);
      return true;
    });
    // Sibling order belongs to the compiled plan; failure must stop its exact prefix.
    assert.ok(expected.includes(moduleIds[key]));
    assert.deepEqual(calls, expected.slice(0, expected.indexOf(moduleIds[key]) + 1));
  });
}

for (const settlement of ["fulfill", "reject", "opaque-undefined"] as const) {
  test(`pending factory ${settlement} after abort remains owned until settlement`, async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<Awaited<ReturnType<ReturnType<typeof createRuntimeSetupFactories>["claudeConfiguration"]>>>();
    let settled = false;
    let hostCalls = 0;
    let value: Awaited<ReturnType<ReturnType<typeof createRuntimeSetupFactories>["claudeConfiguration"]>>;
    const result = createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
      const factories = createRuntimeSetupFactories(platform);
      return { ...factories,
        claudeConfiguration: async () => { value = await factories.claudeConfiguration(); entered.resolve(); return release.promise; },
        host: (dependencies) => { hostCalls += 1; return factories.host(dependencies); },
      };
    });
    void result.then(() => { settled = true; return; }, () => { settled = true; return; });
    await entered.promise;
    controller.abort("secret reason");
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(settled, false);
    if (settlement === "reject") {release.reject("secret failure");}
    else {release.resolve(settlement === "opaque-undefined" ? undefined as never : value!);}
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeHostCreationError);
      assert.equal(error.code, settlement === "reject" ? "factory_failed" : "cancelled");
      assert.equal(error.cancellationObserved, true);
      assert.doesNotMatch(JSON.stringify(error), /secret/);
      return true;
    });
    assert.equal(hostCalls, 0);
  });
}

test("root created before cancellation is disposed exactly once", async () => {
  const controller = new AbortController();
  let disposed = 0;
  await assert.rejects(createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, host: (dependencies) => {
      const host = factories.host(dependencies);
      controller.abort();
      return { ...host, dispose: async () => { disposed += 1; await host.dispose(); } };
    } };
  }), (error: unknown) => error instanceof AgentRuntimeHostCreationError && error.code === "cancelled");
  assert.equal(disposed, 1);
});

test("cleanup failure does not erase cancellation and no fallback runs", async () => {
  const controller = new AbortController();
  let disposed = 0;
  let roots = 0;
  await assert.rejects(createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, host: (dependencies) => {
      roots += 1;
      const host = factories.host(dependencies);
      controller.abort();
      return { ...host, dispose: async () => { disposed += 1; throw "cleanup secret"; } };
    } };
  }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.cleanupFailed, true);
    assert.doesNotMatch(JSON.stringify(error), /cleanup secret/);
    return true;
  });
  assert.equal(disposed, 1);
  assert.equal(roots, 1);
});

test("successful attempts isolate hosts and startup cancellation ends at handoff", async () => {
  const controller = new AbortController();
  const first = await createDefaultAgentRuntimeHost({ signal: controller.signal });
  const [second, third] = await Promise.all([createDefaultAgentRuntimeHost(), createDefaultAgentRuntimeHost()]);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  controller.abort();
  assert.doesNotThrow(() => first.bindAccess({}));
  await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
});

for (const fault of ["missing-handle", "extra-handle", "duplicate-handle", "missing-root", "wrong-root"] as const) {
  test(`real consumer preparation rejects ${fault} before product work`, async () => {
    let productCalls = 0;
    const composition = await compileComposition({ declarations: runtimeSetupDeclarations, profile: runtimeSetupProfile });
    assert.equal(composition.ok, true);
    if (!composition.ok) {return;}
    const factories = createRuntimeSetupFactories(process.platform);
    const bindings = bindRuntimeSetup({ ...factories,
      security: async () => { productCalls += 1; return factories.security(); },
      discovery: async () => { productCalls += 1; return factories.discovery(); },
      codexConfiguration: async () => { productCalls += 1; return factories.codexConfiguration(); },
      claudeConfiguration: async () => { productCalls += 1; return factories.claudeConfiguration(); },
      codexPlanner: async () => { productCalls += 1; return factories.codexPlanner(); },
      claudePlanner: async () => { productCalls += 1; return factories.claudePlanner(); },
      host: (dependencies) => { productCalls += 1; return factories.host(dependencies); },
    }, () => { throw new Error("preparation created Host"); });
    const extra = bindings.assembly.bindFactory(defineModule({ ...runtimeSetupDeclarations[6],
      moduleId: "agent-runtime/extra", implementationId: "agent-runtime/extra", slots: [],
    }), async () => { productCalls += 1; return { instance: undefined, capabilities: {} }; });
    const result = await bindings.assembly.prepare({ composition,
      factories: fault === "extra-handle" ? [...bindings.factories, extra] : fault === "missing-handle" ? bindings.factories.slice(1)
        : fault === "duplicate-handle" ? [...bindings.factories, bindings.roots.host] : bindings.factories,
      roots: fault === "missing-root" ? {} : fault === "wrong-root" ? { host: bindings.factories[0]! } : bindings.roots,
    });
    assert.equal(result.status, "failed");
    assert.equal(productCalls, 0);
  });
}

test("shared providers and root are materialized exactly once", async () => {
  const counts = { security: 0, discovery: 0, host: 0 };
  const host = await createRuntimeSetupAttempt(undefined, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories,
      security: async () => { counts.security += 1; return factories.security(); },
      discovery: async () => { counts.discovery += 1; return factories.discovery(); },
      host: (dependencies) => { counts.host += 1; return factories.host(dependencies); },
    };
  });
  try { assert.deepEqual(counts, { security: 1, discovery: 1, host: 1 }); }
  finally { await host.dispose(); }
});

test("valid root fulfillment after abort awaits factory and cleanup without handoff", async () => {
  const controller = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const cleaning = deferred<void>();
  const cleanup = deferred<void>();
  type Outcome = Parameters<NonNullable<NonNullable<Parameters<typeof createRuntimeSetupAttempt>[2]>["observeOutcome"]>>[0];
  const outcomes: Outcome[] = [];
  let owned: Awaited<ReturnType<typeof createDefaultAgentRuntimeHost>> | undefined;
  let disposed = 0;
  let settled = false;
  let handoffs = 0;
  const result = createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, host: (dependencies) => {
      const host = factories.host(dependencies);
      owned = { ...host, dispose: async () => {
        disposed += 1;
        cleaning.resolve();
        await cleanup.promise;
        await host.dispose();
      } };
      return owned;
    } };
  }, {
    completeRoot: async (product) => {
      assert.equal(product.instance, owned);
      entered.resolve();
      await release.promise;
      return product;
    },
    observeOutcome: (outcome) => { outcomes.push(outcome); },
  });
  void result.then(() => { settled = true; handoffs += 1; }, () => { settled = true; });
  await entered.promise;
  controller.abort("secret late cancellation");
  // Yield a turn so a premature cancellation race could settle; no timed sleep.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false);
  assert.equal(disposed, 0);
  assert.equal(outcomes.length, 0);
  release.resolve();
  await cleaning.promise;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false, "bootstrap awaits cleanup settlement");
  assert.equal(disposed, 1);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.created.length, 7);
  assert.equal(outcome.created.filter((entry) => entry.instance === owned).length, 1);
  assert.equal(outcome.created[6]!.instance, owned);
  assert.equal(outcome.created[6]!.moduleId, "agent-runtime/runtime-host");
  assert.equal(outcome.created[6]!.implementationId, "agent-runtime/runtime-host");
  assert.equal(handoffs, 0);
  cleanup.resolve();
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.phase, "run");
    assert.equal(error.cancellationObserved, true);
    assert.equal(error.cleanupFailed, false);
    return true;
  });
  assert.equal(disposed, 1);
  assert.equal(handoffs, 0);
});

test("malformed root after abort preserves primary failure through rejecting cleanup", async () => {
  const controller = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const cleaning = deferred<void>();
  const cleanup = deferred<void>();
  type Outcome = Parameters<NonNullable<NonNullable<Parameters<typeof createRuntimeSetupAttempt>[2]>["observeOutcome"]>>[0];
  const outcomes: Outcome[] = [];
  let owned: Awaited<ReturnType<typeof createDefaultAgentRuntimeHost>> | undefined;
  let returned: unknown;
  let disposed = 0;
  let getters = 0;
  let settled = false;
  const result = createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, host: (dependencies) => {
      const host = factories.host(dependencies);
      owned = { ...host, dispose: async () => {
        disposed += 1;
        cleaning.resolve();
        try { await cleanup.promise; }
        finally { await host.dispose(); }
      } };
      return owned;
    } };
  }, {
    completeRoot: async (product) => {
      entered.resolve();
      await release.promise;
      returned = { instance: product.instance, get capabilities() {
        getters += 1;
        throw new Error("secret envelope getter");
      } };
      return returned as typeof product;
    },
    observeOutcome: (outcome) => { outcomes.push(outcome); },
  });
  void result.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  controller.abort("secret malformed cancellation");
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false);
  assert.equal(disposed, 0);
  assert.equal(outcomes.length, 0);
  release.resolve();
  await cleaning.promise;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false, "bootstrap awaits cleanup rejection");
  assert.equal(disposed, 1);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.ok(outcome.status === "failed");
  assert.equal(outcome.code, "assembly.run.invalid-product");
  assert.equal(outcome.phase, "completion");
  assert.equal(outcome.implementationId, "agent-runtime/runtime-host");
  assert.equal(outcome.returned?.product, returned);
  assert.equal(outcome.returned?.implementationId, "agent-runtime/runtime-host");
  assert.equal(outcome.created.length, 6);
  assert.deepEqual(outcome.created.map((entry) => entry.moduleId).toSorted(), [
    "agent-runtime/claude-configuration", "agent-runtime/claude-planner",
    "agent-runtime/codex-configuration", "agent-runtime/codex-planner",
    "agent-runtime/installation-discovery", "agent-runtime/setup-security",
  ]);
  assert.ok(outcome.created.every((entry) => entry.instance !== owned));
  assert.ok(outcome.cancellation !== undefined);
  cleanup.reject(new Error("secret cleanup rejection"));
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "invalid_factory_product");
    assert.equal(error.phase, "run");
    assert.equal(error.moduleId, "agent-runtime/runtime-host");
    assert.equal(error.cancellationObserved, true);
    assert.equal(error.cleanupFailed, true);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /secret/);
    return true;
  });
  assert.equal(disposed, 1);
  assert.equal(getters, 0);
});

for (const aborted of [false, true]) {
  test(`malformed root envelope before journal commit cleans captured Host (abort=${aborted})`, async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    const cleanup = deferred<void>();
    const cleaning = deferred<void>();
    let disposed = 0;
    let getters = 0;
    let owned: Awaited<ReturnType<typeof createDefaultAgentRuntimeHost>> | undefined;
    let returned: unknown;
    let observed = false;
    let settled = false;
    const result = createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
      const factories = createRuntimeSetupFactories(platform);
      return { ...factories, host: (dependencies) => {
        const host = factories.host(dependencies);
        owned = { ...host, dispose: async () => {
          disposed += 1;
          cleaning.resolve();
          await cleanup.promise;
          await host.dispose();
        } };
        return owned;
      } };
    }, {
      completeRoot: async (product) => {
        entered.resolve();
        await release.promise;
        // The actual Assembly envelope is malformed, not an opaque capability value.
        returned = { instance: product.instance, get capabilities() {
          getters += 1;
          throw new Error("secret envelope getter");
        } };
        return returned as typeof product;
      },
      observeOutcome: (outcome) => {
        observed = true;
        assert.equal(outcome.status, "failed");
        if (outcome.status !== "failed") {return;}
        assert.equal(outcome.code, "assembly.run.invalid-product");
        assert.equal(outcome.returned?.product, returned);
        assert.equal(outcome.returned?.implementationId, "agent-runtime/runtime-host");
        assert.equal(outcome.created.length, 6);
        assert.ok(outcome.created.every((entry) => entry.instance !== owned));
        assert.equal(outcome.cancellation !== undefined, aborted);
      },
    });
    void result.then(() => { settled = true; return; }, () => { settled = true; return; });
    await entered.promise;
    if (aborted) {controller.abort("secret cancellation");}
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(settled, false);
    assert.equal(disposed, 0);
    release.resolve();
    await cleaning.promise;
    assert.equal(settled, false, "bootstrap awaits cleanup settlement");
    cleanup.resolve();
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeHostCreationError);
      assert.equal(error.code, "invalid_factory_product");
      assert.equal(error.cancellationObserved, aborted);
      assert.equal(error.moduleId, "agent-runtime/runtime-host");
      assert.doesNotMatch(JSON.stringify(error), /secret/);
      return true;
    });
    assert.equal(observed, true);
    assert.equal(disposed, 1);
    assert.equal(getters, 0);
  });
}

test("unexpected envelope inspection failure before journal commit retains the captured root", async () => {
  let disposed = 0;
  type Outcome = Parameters<NonNullable<NonNullable<Parameters<typeof createRuntimeSetupAttempt>[2]>["observeOutcome"]>>[0];
  const outcomes: Outcome[] = [];
  let returned: unknown;
  await assert.rejects(createRuntimeSetupAttempt(undefined, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, host: (dependencies) => {
      const host = factories.host(dependencies);
      return { ...host, dispose: async () => { disposed += 1; await host.dispose(); } };
    } };
  }, {
    completeRoot: async (product) => {
      returned = { instance: product.instance, capabilities: new Proxy({}, {
        ownKeys() { throw new Error("synthetic envelope inspection failure"); },
      }) };
      return returned as typeof product;
    },
    observeOutcome: (outcome) => { outcomes.push(outcome); },
  }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "internal_failure");
    assert.doesNotMatch(JSON.stringify(error), /synthetic envelope/);
    return true;
  });
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "failed");
  assert.ok(outcome.status === "failed");
  assert.equal(outcome.code, "assembly.run.internal");
  assert.equal(outcome.returned?.product, returned);
  assert.equal(outcome.created.length, 6);
  assert.ok(outcome.created.every((entry) => entry.implementationId !== "agent-runtime/runtime-host"));
  assert.equal(disposed, 1);
});

test("abort after actual Assembly success but before caller handoff disposes the journalled root", async () => {
  const controller = new AbortController();
  let disposed = 0;
  let observed = false;
  await assert.rejects(createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, host: (dependencies) => {
      const host = factories.host(dependencies);
      return { ...host, dispose: async () => { disposed += 1; await host.dispose(); } };
    } };
  }, { observeOutcome: (outcome) => {
    observed = true;
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") {return;}
    assert.equal(outcome.created.length, 7);
    assert.equal(outcome.created.at(-1)?.instance, outcome.roots.host);
    controller.abort();
  } }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.phase, "handoff");
    return true;
  });
  assert.equal(observed, true);
  assert.equal(disposed, 1);
});

for (const failObservation of [false, true]) {
  test(`hostile signal at failed handoff cleans owned Host exactly once (primary failure=${failObservation})`, async () => {
    const controller = new AbortController();
    let disposed = 0;
    let reasonReads = 0;
    let observed = false;
    const getterCause = { secret: "test-fixture-literal" };
    const primaryCause = new Error("TEST-primary-secret");
    await assert.rejects(createRuntimeSetupAttempt({ signal: controller.signal }, (platform) => {
      const factories = createRuntimeSetupFactories(platform);
      return { ...factories, host: (dependencies) => {
        const host = factories.host(dependencies);
        return { ...host, dispose: async () => { disposed += 1; await host.dispose(); } };
      } };
    }, { observeOutcome: (outcome) => {
      assert.equal(outcome.status, "succeeded");
      assert.ok(outcome.status === "succeeded");
      assert.equal(outcome.created.at(-1)?.instance, outcome.roots.host);
      observed = true;
      Object.defineProperty(controller.signal, "aborted", { get() { throw getterCause; } });
      Object.defineProperty(controller.signal, "reason", { get() { reasonReads += 1; throw "TEST-reason-secret"; } });
      if (failObservation) { throw primaryCause; }
    } }), (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeHostCreationError);
      assert.equal(error.code, "internal_failure");
      assert.notEqual(error, getterCause);
      assert.notEqual(error, primaryCause);
      assert.equal(error.phase, failObservation ? "run" : "handoff");
      assert.equal(error.cancellationObserved, false);
      assert.equal(error.cleanupFailed, false);
      assert.deepEqual(error.diagnostics, []);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(JSON.stringify(error) + String(error), /test-fixture-literal|TEST-reason-secret|TEST-primary-secret/);
      assert.equal(disposed, 1);
      return true;
    });
    assert.equal(observed, true);
    assert.equal(reasonReads, 0);
    assert.equal(disposed, 1);
  });
}

test("factory owns and awaits release of a resource acquired before rejection", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const resource = { acquired: false, released: false };
  let hostCalls = 0;
  let observed = false;
  let settled = false;
  const result = createRuntimeSetupAttempt(undefined, (platform) => {
    const factories = createRuntimeSetupFactories(platform);
    return { ...factories, security: async () => {
      resource.acquired = true;
      try { throw new Error("synthetic factory failure"); }
      finally { entered.resolve(); await release.promise; resource.released = true; }
    }, host: (dependencies) => { hostCalls += 1; return factories.host(dependencies); } };
  }, { observeOutcome: (outcome) => {
    observed = true;
    assert.equal(resource.acquired, true);
    assert.equal(resource.released, true);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") {return;}
    assert.equal(outcome.returned, undefined);
    assert.ok(outcome.created.every((entry) => entry.implementationId !== "agent-runtime/setup-security"));
  } });
  void result.then(() => { settled = true; return; }, () => { settled = true; return; });
  await entered.promise;
  assert.equal(settled, false);
  assert.equal(resource.released, false);
  release.resolve();
  await assert.rejects(result, (error: unknown) => error instanceof AgentRuntimeHostCreationError && error.code === "factory_failed");
  assert.equal(observed, true);
  assert.equal(resource.released, true);
  assert.equal(hostCalls, 0);
});

for (const concurrent of [false, true]) {
  test(`failed attempt cleanup cannot dispose another Host (concurrent=${concurrent})`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controllers = [new AbortController(), new AbortController()];
    const hosts: Awaited<ReturnType<typeof createDefaultAgentRuntimeHost>>[] = [];
    const disposed = [0, 0];
    const create = (index: number) => createRuntimeSetupAttempt({ signal: controllers[index]!.signal }, (platform) => {
      const factories = createRuntimeSetupFactories(platform);
      return { ...factories, host: (dependencies) => {
        const host = factories.host(dependencies);
        const wrapped = { ...host, dispose: async () => { disposed[index]! += 1; await host.dispose(); } };
        hosts[index] = wrapped;
        return wrapped;
      } };
    }, index === 0 ? { completeRoot: async () => {
      entered.resolve();
      await release.promise;
      throw new Error("attempt-local failure");
    } } : {});
    const failing = create(0);
    const rejected = assert.rejects(failing, (error: unknown) => error instanceof AgentRuntimeHostCreationError && error.code === "factory_failed");
    await entered.promise;
    const succeeding = concurrent ? await create(1) : undefined;
    if (concurrent) {assert.deepEqual(disposed, [0, 0]);}
    release.resolve();
    await rejected;
    const host = await (succeeding ?? create(1));
    try {
      controllers[0]!.abort();
      assert.notEqual(hosts[0], hosts[1]);
      assert.deepEqual(disposed, [1, 0]);
      assert.doesNotThrow(() => host.bindAccess({}));
    } finally { await host.dispose(); }
    assert.deepEqual(disposed, [1, 1]);
  });
}

for (const fault of ["missing-binding", "wrong-implementation", "capability", "compatibility", "digest", "order"] as const) {
  test(`consumer preflight rejects changed ${fault} with no materialization`, async () => {
    const composition = await compileComposition({ declarations: runtimeSetupDeclarations, profile: runtimeSetupProfile });
    assert.equal(composition.ok, true);
    if (!composition.ok) {return;}
    let calls = 0;
    const fail = (): never => { calls += 1; throw new Error("preflight must not materialize"); };
    const bindings = bindRuntimeSetup({ security: fail, discovery: fail, codexConfiguration: fail,
      claudeConfiguration: fail, codexPlanner: fail, claudePlanner: fail, host: fail }, fail);
    const first = composition.plan.bindings[0]!;
    const changed = {
      ...composition,
      ...(fault === "digest" ? { digest: `gm-plan:v1:sha-256:${"0".repeat(64)}` as const } : {}),
      plan: { ...composition.plan,
        bindings: fault === "missing-binding" ? composition.plan.bindings.slice(1)
          : composition.plan.bindings.map((binding, index) => index !== 0 ? binding : {
            ...first,
            ...(fault === "capability" ? { capabilityId: "agent-runtime/unknown" } : {}),
            ...(fault === "compatibility" ? { compatibility: { ...first.compatibility, token: "agent-runtime/wrong-v1" } } : {}),
          }),
        selections: fault === "wrong-implementation" ? composition.plan.selections.map((selection, index) => index === 0
          ? { ...selection, implementationId: "agent-runtime/unknown" } : selection) : composition.plan.selections,
        dependencyOrder: fault === "order" ? composition.plan.dependencyOrder.toReversed() : composition.plan.dependencyOrder,
      },
    };
    const result = await bindings.assembly.prepare({ composition: changed, factories: bindings.factories, roots: bindings.roots });
    assert.equal(result.status, "failed");
    assert.equal(calls, 0);
  });
}


test("pinned compiler enforces the positive and negative Assembly consumer contract", () => {
  const result = spawnSync("pnpm", ["exec", "tsc", "--project", "tests/runtime-setup-assembly.types.tsconfig.json", "--pretty", "false"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("default import and bootstrap remain passive under effect traps", () => {
  // A fresh process keeps import-time effects observable and traps out of other tests.
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import dns from 'node:dns';
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import dgram from 'node:dgram';
    import { syncBuiltinESMExports } from 'node:module';
    const attempts = [];
    const install = (target, members) => {
      for (const member of members) {
        assert.equal(typeof target[member], 'function', member);
        target[member] = () => { attempts.push(member); throw new Error('TEST passive effect: ' + member); };
      }
    };
    install(globalThis, ['fetch']);
    install(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
    for (const target of [dns, dns.promises]) install(target, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']);
    for (const target of [http, https]) install(target, ['request', 'get']);
    install(net, ['connect', 'createConnection']);
    install(net.Socket.prototype, ['connect']);
    install(net.Server.prototype, ['listen']);
    install(tls, ['connect']);
    install(dgram, ['createSocket']);
    install(dgram.Socket.prototype, ['bind', 'connect', 'send']);
    // Keep loader reads available; product adapters use fs.promises for observations.
    install(fs.promises, ['access', 'open', 'readFile', 'readdir', 'readlink', 'realpath', 'stat', 'lstat', 'writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink']);
    install(fs, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'createWriteStream', 'watch']);
    syncBuiltinESMExports();
    const { createDefaultAgentRuntimeHost } = await import(${JSON.stringify(new URL("../dist/composition.js", import.meta.url).href)});
    assert.deepEqual(attempts, []);
    const host = await createDefaultAgentRuntimeHost();
    try { assert.deepEqual(attempts, []); }
    finally { await host.dispose(); }
    assert.deepEqual(attempts, []);
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

for (const concurrent of [false, true]) {
  test(`configuration identities are stable within and isolated between attempts (concurrent=${concurrent})`, async t => {
    type Dependencies = Parameters<ReturnType<typeof createRuntimeSetupFactories>["host"]>[0];
    const bundles: Dependencies[] = [];
    const create = () => createRuntimeSetupAttempt(undefined, platform => {
      const factories = createRuntimeSetupFactories(platform);
      return { ...factories, host: dependencies => {
        bundles.push(dependencies);
        const host = factories.host(dependencies);
        t.after(() => host.dispose());
        return host;
      } };
    });
    if (concurrent) { await Promise.all([create(), create()]); }
    else { await create(); await create(); }
    assert.equal(bundles.length, 2);
    // Stale/rejected TEST evidence yields keyed identities without filesystem reads.
    const codexInput = {
      dialect: "codex-0.134", identityScope: "TEST-attempt", observationEpoch: "current",
      sources: [{ absolutePath: "/TEST/config.toml", canonicalPath: "/TEST/config.toml",
        custodyRoot: { absolutePath: "/TEST", canonicalPath: "/TEST" },
        displayPath: "TEST/config.toml", kind: "user", observationEpoch: "previous" }],
    } as const;
    const claudeInput = {
      dialect: "claude-code-settings@2026-08-28", identityScope: "TEST-attempt",
      sourcePlan: { claim: "observed-files-only", contract: "claude-code-observed-source-plan/v1",
        collector: { bundleId: "TEST-bundle", id: "TEST-collector", observationEpoch: "current", platform: "darwin", version: "TEST-v1" },
        roots: [{ absolutePath: "/TEST", canonicalPath: "/TEST", rootId: "TEST-root" }],
        sources: [{ access: "rejected", custodyRootRef: "TEST-root", displayPath: "TEST/settings.json",
          observationEpoch: "current", role: "user", selectionBasis: "home-default", sourceId: "TEST-source", trust: "user" }],
      },
    } as const;
    const observe = async (bundle: Dependencies) => {
      const codex = await bundle.codexSetup.inspectCodexConfiguration.execute(codexInput);
      const claude = await bundle.claudeCodeSetup.inspectClaudeCodeConfiguration.execute(claudeInput);
      assert.deepEqual(codex.sources.map(source => source.status), ["stale"]);
      assert.deepEqual(claude.sources.map(source => source.status), ["rejected"]);
      assert.equal(typeof codex.sources[0]?.sourceRef, "string");
      assert.equal(typeof claude.sources[0]?.sourceRef, "string");
      return [codex.sources[0]!.sourceRef, claude.sources[0]!.sourceRef];
    };
    const first = await observe(bundles[0]!);
    const second = await observe(bundles[1]!);
    assert.deepEqual(await observe(bundles[0]!), first);
    assert.deepEqual(await observe(bundles[1]!), second);
    assert.notEqual(first[0], second[0], "Codex must not reuse another attempt's identity key");
    assert.notEqual(first[1], second[1], "Claude must not reuse another attempt's identity key");
  });
}

// A valid capability with the wrong platform binding: preparation and all seven
// factories succeed, but the planner changes observable behavior. No plan or
// digest corruption and no fabricated dependency outcome is involved.
test("independent oracle rejects a materialized wrong-platform planner binding", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createCodexSetupInspectionPlanner } = await import("../dist/composition/codex-setup-inspection-planner.js");
  const root = await mkdtemp(join(tmpdir(), "ar-assembly-mutant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let succeeded = false;
  const host = await createExactParityHost(() => createRuntimeSetupAttempt(undefined, platform => ({
    ...createRuntimeSetupFactories(platform),
    codexPlanner: async () => createCodexSetupInspectionPlanner(platform === "darwin" ? "linux" : "darwin"),
  }), { observeOutcome(outcome) {
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.created.length, 7);
    succeeded = true;
  } }));
  t.after(() => host.dispose());
  assert.equal(succeeded, true);
  await assert.rejects(host.bindAccess(fixtureScope(root)).codexSetup.inspect({}),
    { code: "ERR_ASSERTION", message: /complete direct\/Assembly observable parity/u });
});
