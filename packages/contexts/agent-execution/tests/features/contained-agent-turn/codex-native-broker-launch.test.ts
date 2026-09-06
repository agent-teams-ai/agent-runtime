import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyPrivateLaunchPaths } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
import { requireContainedTurnLiveCanaryAuthorities } from "./support/contained-turn-live-canary-lifecycle.mjs";
import { createCodexAppServerLaunchPlan, validateCodexAppServerLaunchPlanRoots, codexNativeBrokerLaunchInput } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import { CodexAppServerContainedTurnProvider } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import { detachCodexProviderOptions } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-provider-options.js";
import { createCodexNativeBrokerRecipe, CODEX_NATIVE_BROKER_DISABLED_FEATURES } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js";
import { codexTurnSandboxPolicy } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_ADAPTER_REVISION } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";
import { FakeCodexProcess, manifest, executeInput } from "../../codex-app-server-contained-turn-provider-fixture.ts";
import { emitAgentStarted, emitTurnStarted, generatedTurn } from "../../codex-app-server-test-messages.mjs";
import { brokerFixture, nativeBrokerConfig, capture, fixtureCapability, fixtureEndpoint } from "../../fixtures/codex-native-broker-0.153.4/fixture.ts";
import { rehashNativeLayers } from "../../fixtures/codex-native-config-0.153.4/fixture.ts";

const nativePlan = async (f: ReturnType<typeof brokerFixture>) => createCodexAppServerLaunchPlan({
  ...f.launchOptions,
  nativeBroker: { recipe: f.recipe, files: await f.prepare(), localCapability: fixtureCapability },
});
const providerOptions = (f: ReturnType<typeof brokerFixture>, plan: Awaited<ReturnType<typeof nativePlan>>, process: FakeCodexProcess) => ({
  boundary: f.boundary, manifest, nativeBrokerLaunchPlan: plan,
  privateRootPath: f.launchOptions.privateRootPath, tmpDir: f.launchOptions.tmpDir,
  processes: { get: () => process }, requestTimeoutMs: 100, turnTimeoutMs: 100,
});
const handshake = (f: ReturnType<typeof brokerFixture>, message: Record<string, unknown>, target: FakeCodexProcess): boolean => {
  if (message.method === "initialize") {
    target.emit({ id: message.id, result: {
      codexHome: f.home, platformFamily: "unix", platformOs: "linux",
      userAgent: `agent-runtime/0.153.4 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; ${CODEX_APP_SERVER_ADAPTER_REVISION})`,
    } }); return true;
  }
  if (message.method === "initialized") {return true;}
  if (message.method === "config/read") {
    target.emit({ id: message.id, result: nativeBrokerConfig(f.home, f.boundary.intentMode) }); return true;
  }
  if (message.method === "permissionProfile/list") {
    target.emit({ id: message.id, result: capture(f.boundary.intentMode).messages.find((m: { id?: string }) => m.id === "permission-list").result }); return true;
  }
  if (message.method === "thread/start") {
    target.emit({ id: message.id, result: {
      thread: { id: "thread:test" }, activePermissionProfile: { id: f.boundary.permissionProfileId, extends: f.boundary.permissionProfile.extends },
      cwd: f.workspace, approvalPolicy: "never", sandbox: codexTurnSandboxPolicy(f.boundary.intentMode, f.workspace),
    } }); return true;
  }
  return false;
};
const input = (f: ReturnType<typeof brokerFixture>, process: FakeCodexProcess) => ({
  ...executeInput(process, async () => false, f.boundary.intentMode), workspaceRef: f.workspace,
});

test("native launch accepts only prepared matching recipe and adds capability solely to exact child environment", async t => {
  for (const mode of ["analysis", "workspace-write"] as const) {
    const f = brokerFixture(t, mode); const plan = await nativePlan(f);
    validateCodexAppServerLaunchPlanRoots(plan);
    assert.equal(codexNativeBrokerLaunchInput(plan).recipe, f.recipe);
    assert.deepEqual(plan.environment, {
      CODEX_HOME: f.home, HOME: f.home, LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: f.launchOptions.tmpDir, AR_PRIVATE_BROKER_CAPABILITY: fixtureCapability,
    });
    assert.deepEqual(plan.arguments, ["app-server", "--stdio", "--strict-config", "-c",
      'default_permissions="agent-runtime-contained-v1"', ...CODEX_NATIVE_BROKER_DISABLED_FEATURES.flatMap(feature => ["--disable", feature])]);
    assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.environment), true);
    for (const [key, value] of Object.entries(plan)) {
      if (key !== "environment") {assert.equal(JSON.stringify(value).includes(fixtureCapability), false);}
    }
    assert.equal(readFileSync(join(f.home, "config.toml"), "utf8").includes(fixtureCapability), false);
    assert.equal(readFileSync(join(f.home, "models.json"), "utf8").includes(fixtureCapability), false);
    const legacy = createCodexAppServerLaunchPlan(f.launchOptions);
    assert.equal(Object.hasOwn(legacy.environment, "AR_PRIVATE_BROKER_CAPABILITY"), false);
    assert.equal(legacy.arguments.includes("unbounded_connection_retries"), false);
    validateCodexAppServerLaunchPlanRoots(legacy);
  }
});

test("launch rejects forged recipes/files, mismatched boundary/intent, unsupported target and mutable native inputs", async t => {
  const f = brokerFixture(t); const files = await f.prepare();
  const native = { recipe: f.recipe, files, localCapability: fixtureCapability };
  const create = (override: object) => createCodexAppServerLaunchPlan({ ...f.launchOptions, nativeBroker: native, ...override });
  const other = brokerFixture(t);
  const differentEndpoint = createCodexNativeBrokerRecipe({ boundary: f.boundary, endpoint: fixtureEndpoint.replace("43129", "43130"), profile: "codex-chatgpt" });
  for (const bad of [
    { boundary: other.boundary }, { intentMode: "workspace-write" }, { platformTarget: { architecture: "x64", platform: "darwin" } },
    { nativeBroker: { ...native, recipe: { ...f.recipe } } }, { nativeBroker: { ...native, files: { ...files } } },
    { nativeBroker: { ...native, recipe: differentEndpoint } }, { nativeBroker: { ...native, extra: true } },
  ]) {assert.throws(() => create(bad));}
  for (const value of ["", "short", `${fixtureCapability}\r\n`, `${fixtureCapability}\n`, `${fixtureCapability}\r`, { toJSON: () => {throw Error("not invoked");} }]) {
    assert.throws(() => create({ nativeBroker: { ...native, localCapability: value } }), error => {
      assert.equal(String(error).includes(fixtureCapability), false); return true;
    });
  }
  const plan = create({}); native.localCapability = "substituted_0000000000000000000000000000"; native.recipe = differentEndpoint;
  assert.equal(plan.environment.AR_PRIVATE_BROKER_CAPABILITY, fixtureCapability);
  assert.equal(codexNativeBrokerLaunchInput(plan).recipe, f.recipe);
  writeFileSync(join(f.home, "models.json"), "{}");
  assert.throws(() => validateCodexAppServerLaunchPlanRoots(plan));
});

test("native plan and provider options reject accessor/Proxy/forgery before executing traps or leaking capability", async t => {
  const f = brokerFixture(t); const plan = await nativePlan(f); let touched = 0;
  const trap = () => {touched += 1; throw new Error(fixtureCapability);};
  const proxy = <T extends object>(value: T) => new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  const native = codexNativeBrokerLaunchInput(plan);
  for (const bad of [proxy({ ...f.launchOptions, nativeBroker: native }),
    { ...f.launchOptions, nativeBroker: proxy(native) },
    { ...f.launchOptions, platformTarget: proxy(f.launchOptions.platformTarget) },
    { ...f.launchOptions, nativeBroker: Object.defineProperty({ ...native }, "localCapability", { get: trap }) },
  ]) {assert.throws(() => createCodexAppServerLaunchPlan(bad));}
  for (const bad of [{ ...plan }, Object.freeze({ ...plan }), proxy(plan)]) {
    assert.throws(() => codexNativeBrokerLaunchInput(bad));
    assert.throws(() => validateCodexAppServerLaunchPlanRoots(bad));
    assert.throws(() => new CodexAppServerContainedTurnProvider(providerOptions(f, bad, new FakeCodexProcess(() => {}))));
  }
  for (const environment of [{ ...plan.environment, AR_PRIVATE_BROKER_CAPABILITY: "substitute" },
    { ...plan.environment, OPENAI_API_KEY: fixtureCapability }, proxy(plan.environment),
    Object.defineProperty({ ...plan.environment }, "HOME", { get: trap }),
  ]) {assert.throws(() => validateCodexAppServerLaunchPlanRoots({ ...plan, environment }), error => {
    assert.equal(String(error).includes(fixtureCapability), false); return true;
  });}
  const options = providerOptions(f, plan, new FakeCodexProcess(() => {}));
  for (const bad of [proxy(options), { ...options, nativeBrokerLaunchPlan: proxy(plan) },
    Object.defineProperty({ ...options }, "nativeBrokerLaunchPlan", { get: trap }),
    { ...options, boundary: { ...f.boundary } }, { ...options, tmpDir: "/different" },
    { ...options, privateRootPath: "/different" },
    { ...options, manifest: { ...manifest, providerBinding: { ...manifest.providerBinding, binaryRevision: "@openai/codex:0.153.4+darwin-arm64" } } },
  ]) {assert.throws(() => new CodexAppServerContainedTurnProvider(bad), error => {
    assert.equal(String(error).includes(fixtureCapability), false); return true;
  });}
  assert.equal(touched, 0);
});

test("constructor remains inert and snapshots automatic local-capability output suppression", async t => {
  const f = brokerFixture(t); const plan = await nativePlan(f); let lookups = 0;
  const options = { ...providerOptions(f, plan, new FakeCodexProcess(() => {})),
    sensitiveOutputTokens: ["extra-sensitive-value"], processes: { get: () => {lookups += 1; return;} },
  };
  const filesBefore = readdirSync(f.home);
  const detached = detachCodexProviderOptions(options);
  const provider = new CodexAppServerContainedTurnProvider(options);
  assert.equal(provider.manifest.providerBinding.provider, "codex");
  options.sensitiveOutputTokens.splice(0); options.nativeBrokerLaunchPlan = { ...plan };
  assert.deepEqual(detached.sensitiveOutputTokens, ["extra-sensitive-value", fixtureCapability]);
  assert.equal(detached.nativeBrokerLaunchPlan, plan);
  assert.equal(Object.isFrozen(detached.sensitiveOutputTokens), true);
  assert.throws(() => detachCodexProviderOptions({ ...options, nativeBrokerLaunchPlan: plan,
    sensitiveOutputTokens: Array.from({ length: 256 }, (_, i) => `value-${i}`),
  }), /bounded length/u);
  assert.equal(lookups, 0); assert.deepEqual(readdirSync(f.home), filesBefore);
});

test("both native capture handshakes reach only the synthetic thread boundary, with no production activation", async t => {
  for (const mode of ["analysis", "workspace-write"] as const) {
    const f = brokerFixture(t, mode); const plan = await nativePlan(f);
    const process = new FakeCodexProcess((message, target) => {
      if (message.method === "thread/start") {
        assert.deepEqual((message.params as Record<string, unknown>).config, {
          features: Object.fromEntries(CODEX_NATIVE_BROKER_DISABLED_FEATURES.map(key => [key, false])),
        });
        target.emit({ id: message.id, error: { code: -32000, message: "synthetic stop before turn" } });
      } else {handshake(f, message, target);}
    });
    const outcome = await new CodexAppServerContainedTurnProvider(providerOptions(f, plan, process)).execute(input(f, process));
    assert.equal(outcome.kind, "not_accepted");
    assert.deepEqual(process.requests.map(message => message.method), ["initialize", "initialized", "config/read", "permissionProfile/list", "thread/start"]);
    assert.equal(JSON.stringify(process.requests).includes(fixtureCapability), false);
  }
});

test("handshake rejects coherent endpoint drift, permission-only downgrade and a different valid recipe", async t => {
  for (const mutation of ["endpoint", "downgrade", "mode"] as const) {
    const f = brokerFixture(t); const plan = await nativePlan(f);
    const process = new FakeCodexProcess((message, target) => {
      if (message.method === "config/read") {
        const result = nativeBrokerConfig(f.home, mutation === "mode" ? "workspace-write" : "analysis");
        if (mutation === "endpoint") {
          for (const config of [result.config, result.layers[1]!.config]) {
            (config.model_providers as { ar_broker: Record<string, unknown> }).ar_broker.base_url = fixtureEndpoint.replace("43129", "43130");
          }
        }
        if (mutation === "downgrade") {result.config.model_provider = null;}
        rehashNativeLayers(result); target.emit({ id: message.id, result });
      } else {handshake(f, message, target);}
    });
    const outcome = await new CodexAppServerContainedTurnProvider(providerOptions(f, plan, process)).execute(input(f, process));
    assert.equal(outcome.kind, "not_accepted");
    assert.equal(process.requests.some(m => m.method === "thread/start" || m.method === "turn/start"), false);
  }
});

test("local capability is suppressed in every split of hostile synthetic output, receipts and protocol diagnostics", async t => {
  const f = brokerFixture(t); const plan = await nativePlan(f);
  for (let split = 0; split <= fixtureCapability.length; split += 1) {
    const emitted: unknown[] = [];
    const process = new FakeCodexProcess((message, target) => {
      if (handshake(f, message, target)) {return;}
      if (message.method !== "turn/start") {return;}
      const turnId = "turn:secret";
      target.emit({ id: message.id, result: { turn: generatedTurn(turnId, "inProgress") } }); emitTurnStarted(target, turnId);
      emitAgentStarted(target, turnId, "item:secret");
      for (const delta of [fixtureCapability.slice(0, split), fixtureCapability.slice(split)]) {
        if (delta.length > 0) {target.emit({ method: "item/agentMessage/delta", params: {
          delta, itemId: "item:secret", threadId: "thread:test", turnId,
        } });}
      }
      target.stdout.end();
    }, {}, plan.environment);
    const outcome = await new CodexAppServerContainedTurnProvider(providerOptions(f, plan, process)).execute({
      ...input(f, process), emit: async chunk => {emitted.push(chunk);},
    });
    assert.equal(outcome.kind, "ambiguous"); assert.deepEqual(emitted, []);
    assert.equal(JSON.stringify(outcome).includes(fixtureCapability), false);
    assert.equal(JSON.stringify(process.requests).includes(fixtureCapability), false);
  }
  const process = new FakeCodexProcess((message, target) => {
    target.emit({ id: message.id, error: { code: -32000, message: fixtureCapability, data: fixtureCapability } });
  });
  const outcome = await new CodexAppServerContainedTurnProvider(providerOptions(f, plan, process)).execute(input(f, process));
  assert.equal(JSON.stringify(outcome).includes(fixtureCapability), false);
  assert.equal(outcome.kind, "not_accepted");
});

test("Host rejects a malformed native capability and keeps canary route authority closed", async t => {
  const f = brokerFixture(t); const plan = await nativePlan(f);
  // The native capability key is classified, but this redaction fixture is not
  // a valid capability. Route qualification remains a separate closed gate.
  await assert.rejects(verifyPrivateLaunchPaths(plan, f.workspace, statSync(f.workspace, { bigint: true })),
    /local broker capability is malformed/u);
  assert.throws(() => requireContainedTurnLiveCanaryAuthorities(), { message: "route-enforcement-unqualified" });
  assert.equal(Object.hasOwn(f.recipe, "routeAuthority"), false);
  assert.equal(Object.hasOwn(f.recipe, "operationId"), false);
});
