import { compileComposition, defineModule } from "@get-modular/core";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDefaultAgentRuntimeHost, AgentRuntimeHostCreationError } from "../dist/composition.js";
import { createRuntimeSetupAttempt } from "../dist/composition/default-agent-runtime-host.js";
import { bindRuntimeSetup, runtimeSetupDeclarations, runtimeSetupProfile, createRuntimeSetupFactories } from "../dist/composition/runtime-setup-assembly.js";
import { registerPassiveSetupScenarios } from "./helpers/assembly-direct-reference.ts";

registerPassiveSetupScenarios("Assembly", () => createDefaultAgentRuntimeHost());

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
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
    let hostCalls = 0;
    const secret = { toJSON() { throw new Error("raw cause executed"); } };
    await assert.rejects(createRuntimeSetupAttempt(undefined, (platform) => {
      const factories = createRuntimeSetupFactories(platform);
      return { ...factories, host: (dependencies) => { hostCalls += 1; return factories.host(dependencies); },
        [key]: () => { throw secret; } };
    }), (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeHostCreationError);
      assert.equal(error.code, "factory_failed");
      assert.equal(error.moduleId, ({ security: "agent-runtime/setup-security", discovery: "agent-runtime/installation-discovery", codexConfiguration: "agent-runtime/codex-configuration", claudeConfiguration: "agent-runtime/claude-configuration", codexPlanner: "agent-runtime/codex-planner", claudePlanner: "agent-runtime/claude-planner", host: "agent-runtime/runtime-host" } as const)[key]);
      assert.equal(error.cancellationObserved, false);
      assert.doesNotMatch(JSON.stringify(error), /raw cause/);
      return true;
    });
    assert.equal(hostCalls, 0);
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
    void result.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    controller.abort("secret reason");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    if (settlement === "reject") release.reject("secret failure");
    else release.resolve(settlement === "opaque-undefined" ? undefined as never : value!);
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
    if (!composition.ok) return;
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
        if (outcome.status !== "failed") return;
        assert.equal(outcome.code, "assembly.run.invalid-product");
        assert.equal(outcome.returned?.product, returned);
        assert.equal(outcome.returned?.implementationId, "agent-runtime/runtime-host");
        assert.equal(outcome.created.length, 6);
        assert.ok(outcome.created.every((entry) => entry.instance !== owned));
        assert.equal(outcome.cancellation !== undefined, aborted);
      },
    });
    void result.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    if (aborted) controller.abort("secret cancellation");
    await new Promise<void>((resolve) => setImmediate(resolve));
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
  let observed = false;
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
    observeOutcome: (outcome) => {
      observed = true;
      assert.equal(outcome.status, "failed");
      if (outcome.status !== "failed") return;
      assert.equal(outcome.code, "assembly.run.internal");
      assert.equal(outcome.returned?.product, returned);
      assert.equal(outcome.created.length, 6);
      assert.ok(outcome.created.every((entry) => entry.implementationId !== "agent-runtime/runtime-host"));
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AgentRuntimeHostCreationError);
    assert.equal(error.code, "internal_failure");
    assert.doesNotMatch(JSON.stringify(error), /synthetic envelope/);
    return true;
  });
  assert.equal(observed, true);
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
    if (outcome.status !== "succeeded") return;
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
    if (outcome.status !== "failed") return;
    assert.equal(outcome.returned, undefined);
    assert.ok(outcome.created.every((entry) => entry.implementationId !== "agent-runtime/setup-security"));
  } });
  void result.then(() => { settled = true; }, () => { settled = true; });
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
    if (concurrent) assert.deepEqual(disposed, [0, 0]);
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
    if (!composition.ok) return;
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
        dependencyOrder: fault === "order" ? [...composition.plan.dependencyOrder].reverse() : composition.plan.dependencyOrder,
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
