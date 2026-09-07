import { compileComposition } from "@get-modular/core";
import assert from "node:assert/strict";
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

for (const fault of ["missing-handle", "duplicate-handle", "missing-root", "wrong-root"] as const) {
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
    const result = await bindings.assembly.prepare({ composition,
      factories: fault === "missing-handle" ? bindings.factories.slice(1)
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
