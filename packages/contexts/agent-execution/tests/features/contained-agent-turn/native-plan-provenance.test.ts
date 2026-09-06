import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostCustodyLaunchPlan } from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import { boundarySources, capability, fixture, host, issuer, launch, observedPaths, recipes, reserve, resolver, snapshots } from "./native-plan-provenance-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const boundaries = {
  reservation: async (f: Fixture, plan: HostCustodyLaunchPlan) => {
    const retained = await reserve(f, plan as Fixture["plan"]);
    try {
      const resolved = await retained.launchPlans.resolve(f.input);
      assert.equal(resolved, retained.plan);
      await assert.rejects(retained.launchPlans.resolve(f.input), /private launch plan identity mismatch/u);
      return retained.plan;
    } finally {retained.retainedWorkspaceAuthority.close();}
  },
  static: async (f: Fixture, plan: HostCustodyLaunchPlan) => {
    const selected = resolver.createStaticHostCustodyLaunchPlanResolver([{ plan, providerBinding: f.input.providerBinding }]);
    return (await selected.resolve(f.input))!;
  },
  candidate: async (f: Fixture, plan: HostCustodyLaunchPlan) =>
    (await launch.resolveLaunchCandidate({ resolve: async () => plan }, f.input)).plan,
};

const assertNative = (f: Fixture, plan: HostCustodyLaunchPlan) => {
  const native = issuer.codexNativeBrokerLaunchInput(plan);
  assert.equal(native.recipe, f.recipe);
  assert.equal(native.files, f.files);
  assert.equal(native.localCapability, capability);
  assert.equal(recipes.codexNativeBrokerBoundary(native.recipe), f.boundary);
  issuer.validateCodexAppServerLaunchPlanRoots(plan);
  assert.equal(plan, f.plan);
  for (const key of ["codexHome", "codexHomeIdentity", "tmpDir", "tmpDirIdentity", "workspaceRef", "workspaceIdentity",
    "effectivePolicyDigest", "permissionProfileId"] as const) {
    assert.equal((plan as Fixture["plan"])[key], f.plan[key]);
  }
  assert.equal(Object.isFrozen(native), true);
};

for (const [name, snapshot] of Object.entries(boundaries)) {
  test(`real native issuer -> ${name} -> same-object native lookup and root validation`, async () => {
    for (const mode of ["analysis", "workspace-write"] as const) {
      const f = await fixture(true, mode);
      assertNative(f, await snapshot(f, f.plan));
      assert.equal(f.descriptorCount(), 0);
    }
  });

  test(`permission-only issuer retains canonical roots across ${name}`, async () => {
    const f = await fixture(false);
    const plan = await snapshot(f, f.plan);
    issuer.validateCodexAppServerLaunchPlanRoots(plan);
    assert.equal(plan, f.plan);
    assert.throws(() => issuer.codexNativeBrokerLaunchInput(plan), /native broker launch rejected/u);
    assert.equal(Object.hasOwn(plan.environment, "AR_PRIVATE_BROKER_CAPABILITY"), false);
  });

  test(`${name} never transfers native authority to clones, frozen data or matching digests`, async () => {
    const f = await fixture();
    for (const fake of [{ ...f.plan }, Object.freeze({ ...f.plan }),
      { ...f.plan, environment: { ...f.plan.environment }, arguments: [...f.plan.arguments] }]) {
      assert.throws(() => issuer.codexNativeBrokerLaunchInput(fake), /native broker launch rejected/u);
      const copied = await snapshot(f, fake);
      assert.notEqual(copied, fake);
      assert.throws(() => issuer.codexNativeBrokerLaunchInput(copied), /native broker launch rejected/u);
      assert.throws(() => issuer.validateCodexAppServerLaunchPlanRoots(copied));
      assert.equal(launch.createFingerprint(f.input, fake, f.input.workspaceRef, fake.arguments).planSha256,
        launch.createFingerprint(f.input, f.plan, f.input.workspaceRef, f.plan.arguments).planSha256);
    }
  });

  test(`${name} rejects executable proxies/accessors before traps, coercion or iteration`, async () => {
    const f = await fixture();
    let touched = 0;
    const trap = () => {touched += 1; throw new Error("untrusted executable data read");};
    const proxy = <T extends object>(value: T) => new Proxy(value, {
      // Promise fulfillment probes `then` inside the synthetic resolver, before
      // Host receives the value. Every executable-data trap remains forbidden.
      get: (_target, key) => key === "then" ? undefined : trap(),
      getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
    });
    const accessor = <T extends object>(value: T, key: string) => Object.defineProperty(value, key, { get: trap });
    const revoked = Proxy.revocable({ ...f.plan }, {}); revoked.revoke();
    const badPlans = [proxy(f.plan), revoked.proxy, accessor({ ...f.plan }, "provider"),
      accessor({ ...f.plan }, "arguments"), accessor({ ...f.plan }, "environment"),
      { ...f.plan, arguments: proxy([...f.plan.arguments]) },
      { ...f.plan, arguments: accessor([...f.plan.arguments], "0") },
      { ...f.plan, arguments: Object.assign([...f.plan.arguments], { [Symbol.iterator]: trap }) },
      { ...f.plan, arguments: [proxy({ toString: trap })] },
      { ...f.plan, environment: proxy({ ...f.plan.environment }) },
      { ...f.plan, environment: accessor({ ...f.plan.environment }, "HOME") },
      { ...f.plan, environment: { ...f.plan.environment, HOME: proxy({ toString: trap }) } },
      { ...f.plan, privatePathEnvironmentKeys: proxy(["HOME"]) },
      { ...f.plan, privatePathEnvironmentKeys: accessor(["HOME"], "0") },
      { ...f.plan, executablePath: proxy({ toString: trap }) },
    ];
    for (const bad of badPlans) {
      await assert.rejects(snapshot(f, bad as HostCustodyLaunchPlan));
      assert.throws(() => issuer.codexNativeBrokerLaunchInput(bad as HostCustodyLaunchPlan));
      assert.equal(touched, 0);
      assert.equal(f.descriptorCount(), 0);
    }
  });

  test(`${name} defensively snapshots ordinary generic arrays and environment`, async () => {
    const f = await fixture(false);
    const source = {
      arguments: ["legacy"], binaryRevision: f.plan.binaryRevision, containmentProfile: f.plan.containmentProfile,
      environment: { ...f.plan.environment }, executablePath: f.plan.executablePath, executableSha256: f.plan.executableSha256,
      intentMode: f.plan.intentMode, provider: "codex", privateRootPath: f.plan.privateRootPath,
      privatePathEnvironmentKeys: ["HOME"],
    };
    const plan = await snapshot(f, source);
    assert.notEqual(plan, source);
    assert.notEqual(plan.arguments, source.arguments);
    assert.notEqual(plan.environment, source.environment);
    assert.notEqual(plan.privatePathEnvironmentKeys, source.privatePathEnvironmentKeys);
    source.arguments[0] = "changed"; source.environment.HOME = "/changed";
    source.privatePathEnvironmentKeys[0] = "TMPDIR";
    assert.deepEqual(plan.arguments, ["legacy"]);
    assert.equal(plan.environment.HOME, f.plan.codexHome);
    assert.deepEqual(plan.privatePathEnvironmentKeys, ["HOME"]);
    for (const value of [plan, plan.arguments, plan.environment, plan.privatePathEnvironmentKeys]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.throws(() => issuer.codexNativeBrokerLaunchInput(plan));
    if (name === "static") {assert.equal(plan.spawnMode, "eager");}
  });
}

test("real reservation -> static resolver -> candidate keeps one immutable native object", async () => {
  const f = await fixture();
  let plan: HostCustodyLaunchPlan = f.plan;
  for (const snapshot of Object.values(boundaries)) {plan = await snapshot(f, plan); assertNative(f, plan);}
  for (const value of [f.plan, f.plan.arguments, f.plan.environment, f.plan.codexHomeIdentity,
    f.plan.tmpDirIdentity, f.plan.workspaceIdentity]) {assert.equal(Object.isFrozen(value), true);}
  assert.throws(() => (f.plan.arguments as string[]).push("--extra"), TypeError);
  assert.throws(() => { (f.plan.environment as Record<string, string>).HOME = "/changed"; }, TypeError);
  const delegated = { command: plan.executablePath, arguments: plan.arguments, environment: plan.environment, cwd: "/proc/self/fd/4" };
  assert.equal(launch.assertDelegatedStartFingerprint(delegated, plan), plan.environment);
  for (const change of [{ command: "/changed" }, { arguments: [...plan.arguments, "--extra"] },
    { environment: { ...plan.environment, EXTRA: "value" } }, { cwd: f.input.workspaceRef }]) {
    assert.throws(() => launch.assertDelegatedStartFingerprint({ ...delegated, ...change }, plan), /fingerprint conflict/u);
  }
});

test("retention is not validation: native files and root replacement still reject", async () => {
  const f = await fixture();
  const plan = await boundaries.candidate(f, await boundaries.reservation(f, f.plan));
  assertNative(f, plan);
  f.mutate(f.recipe.catalogPath, { revision: 2 });
  assert.throws(() => issuer.validateCodexAppServerLaunchPlanRoots(plan), /native broker files rejected/u);
  f.mutate(f.recipe.catalogPath, { revision: 1 });
  for (const path of [f.plan.codexHome, f.plan.tmpDir, f.plan.workspaceRef]) {
    const identity = path === f.plan.codexHome ? f.plan.codexHomeIdentity :
      path === f.plan.tmpDir ? f.plan.tmpDirIdentity : f.plan.workspaceIdentity;
    f.mutate(path, { ino: identity.inode + 10000 });
    assert.throws(() => issuer.validateCodexAppServerLaunchPlanRoots(plan), /changed filesystem identity/u);
    f.mutate(path, { ino: identity.inode });
  }
  f.mutate(f.plan.privateRootPath, { mode: 0o40777 });
  await assert.rejects(boundaries.candidate(f, f.plan), /owner-private directory/u);
});

test("binding, tuple and sibling-root validation remain closed", async () => {
  const f = await fixture();
  for (const change of [{ binaryRevision: "different" }, { provider: "claude" }, { intentMode: "workspace-write" }]) {
    await assert.rejects(boundaries.candidate(f, { ...f.plan, ...change } as HostCustodyLaunchPlan), /provider binding/u);
  }
  for (const change of [{ executableSha256: "0".repeat(64) }, { containmentProfile: "cooperative-darwin-posix-process-group" }]) {
    assert.throws(() => issuer.validateCodexAppServerLaunchPlanRoots({ ...f.plan, ...change } as HostCustodyLaunchPlan), /tuple\/profile mismatch/u);
  }
  await assert.rejects(boundaries.candidate(f, { ...f.plan, privateRootPath: f.plan.codexHome }), /operation-scoped workspace sibling/u);
  assert.equal(f.plan.binaryRevision, "@openai/codex:0.153.4+linux-x64");
  assert.equal(observedPaths.some(path => /auth\.json|encryption-key/u.test(path)), false);
});

test("permission-only factory detaches mutable root identities before issuer recognition", async () => {
  const f = await fixture(false);
  const boundary = { ...f.boundary, codexHomeIdentity: { ...f.boundary.codexHomeIdentity },
    workspaceIdentity: { ...f.boundary.workspaceIdentity } };
  const plan = issuer.createCodexAppServerLaunchPlan({ ...f.options, boundary });
  boundary.codexHomeIdentity.inode += 1;
  boundary.workspaceIdentity.path = "/changed";
  boundary.effectivePolicyDigest = "changed";
  assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(plan), true);
  for (const snapshot of Object.values(boundaries)) {
    assert.equal(await snapshot(f, plan), plan);
    issuer.validateCodexAppServerLaunchPlanRoots(plan);
  }
  for (const value of [plan.codexHomeIdentity, plan.workspaceIdentity]) {assert.equal(Object.isFrozen(value), true);}
  assert.equal(plan.effectivePolicyDigest, f.boundary.effectivePolicyDigest);
  let touched = 0;
  const trap = () => {touched += 1; throw new Error("unexpected issuer read");};
  for (const bad of [Object.defineProperty({ ...f.boundary }, "codexHome", { get: trap }),
    { ...f.boundary, codexHomeIdentity: new Proxy(f.boundary.codexHomeIdentity, { get: trap, ownKeys: trap }) }]) {
    assert.throws(() => issuer.createCodexAppServerLaunchPlan({ ...f.options, boundary: bad }));
  }
  assert.equal(touched, 0);
});

test("issuer recognition rejects every non-issued object without property reads", async () => {
  const f = await fixture();
  let touched = 0;
  const trap = () => {touched += 1; throw new Error("unexpected recognition read");};
  const revoked = Proxy.revocable(f.plan, {}); revoked.revoke();
  for (const value of [null, undefined, "plan", Object.freeze({ ...f.plan }), { ...f.plan },
    new Proxy(f.plan, { get: trap, getPrototypeOf: trap, ownKeys: trap }), revoked.proxy,
    Object.defineProperty({}, "plan", { get: trap })]) {
    assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(value), false);
  }
  assert.equal(touched, 0);
});

test("snapshot envelopes reject accessors before reading the launch plan", async () => {
  const f = await fixture();
  let touched = 0;
  const trap = () => {touched += 1; throw new Error("unexpected envelope read");};
  const record = { plan: f.plan, providerBinding: f.input.providerBinding };
  for (const records of [new Proxy([record], { get: trap }),
    Object.defineProperty([record], "0", { get: trap }),
    [Object.defineProperty({ ...record }, "plan", { get: trap })]]) {
    assert.throws(() => resolver.createStaticHostCustodyLaunchPlanResolver(records));
  }
  const reservationModule = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.js");
  await assert.rejects(reservationModule.bindPrivateHostCustodyReservation(
    Object.defineProperty({ ...f.input, launchPlan: f.plan, workspaceAuthority: f.workspaceAuthority }, "launchPlan", { get: trap }),
    {}, { containmentProfile: "strict-linux-cgroup-v2" } as Parameters<typeof reservationModule.bindPrivateHostCustodyReservation>[2],
  ));
  assert.equal(touched, 0);
  assert.equal(f.descriptorCount(), 0);
});

test("legacy Claude plans keep defensive snapshots at every Host boundary", async () => {
  const f = await fixture(false);
  const source = { ...f.plan, provider: "claude", environment: {
    HOME: f.plan.codexHome, TMPDIR: f.plan.tmpDir, CLAUDE_CONFIG_DIR: `${f.plan.privateRootPath}/claude-config`,
    LANG: "C.UTF-8", PATH: "/usr/bin",
  } };
  // Reuse the synthetic home as the only permitted alias would be invalid for
  // Claude; give its separate configuration directory its own fixture object.
  f.addDirectory(source.environment.CLAUDE_CONFIG_DIR);
  const claude = { ...f, input: { ...f.input, providerBinding: { ...f.input.providerBinding, provider: "claude" } } };
  for (const snapshot of Object.values(boundaries)) {
    const plan = await snapshot(claude, source);
    assert.notEqual(plan, source);
    assert.notEqual(plan.environment, source.environment);
    assert.deepEqual(plan.environment, source.environment);
    assert.equal(Object.isFrozen(plan.environment), true);
    assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(plan), false);
  }
});

test("Host factory always creates new data and cannot launder native authority", async () => {
  const f = await fixture();
  const nativeClone = { ...f.plan };
  for (const source of [f.plan, nativeClone, Object.freeze({ ...f.plan }), structuredClone(f.plan)]) {
    const plan = host.createImmutableHostCustodyLaunchPlan(source);
    const another = host.createImmutableHostCustodyLaunchPlan(plan);
    assert.notEqual(plan, source);
    assert.notEqual(another, plan);
    assert.deepEqual(plan, source);
    for (const copy of [plan, another]) {
      assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(copy), false);
      assert.throws(() => issuer.codexNativeBrokerLaunchInput(copy), /native broker launch rejected/u);
      // The extra native environment key is rejected without native authority.
      assert.throws(() => issuer.validateCodexAppServerLaunchPlanRoots(copy), /native broker recipe rejected/u);
      for (const snapshot of Object.values(boundaries)) {
        assert.equal(await snapshot(f, copy), copy);
        assert.throws(() => issuer.codexNativeBrokerLaunchInput(copy), /native broker launch rejected/u);
      }
    }
    // Host issuance does not mark or freeze the caller's clone either.
    if (source !== f.plan) {assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(source), false);}
    assertNative(f, f.plan);
  }
  assert.equal(Object.isFrozen(nativeClone), false);
  assert.notEqual(snapshots.snapshotHostCustodyLaunchPlan(nativeClone), nativeClone);
  assert.equal(f.descriptorCount(), 0);
});

test("Host factory detaches and freezes every nested launch field", async () => {
  const f = await fixture(false);
  const source = {
    ...f.plan, arguments: [...f.plan.arguments], environment: { ...f.plan.environment },
    privatePathEnvironmentKeys: ["HOME"], codexHomeIdentity: { ...f.plan.codexHomeIdentity },
    tmpDirIdentity: { ...f.plan.tmpDirIdentity }, workspaceIdentity: { ...f.plan.workspaceIdentity },
  };
  const before = structuredClone(source);
  const plan = host.createImmutableHostCustodyLaunchPlan(source);
  for (const key of ["arguments", "environment", "privatePathEnvironmentKeys", "codexHomeIdentity",
    "tmpDirIdentity", "workspaceIdentity"] as const) {
    assert.notEqual(plan[key], source[key]);
    assert.equal(Object.isFrozen(source[key]), false);
    assert.equal(Object.isFrozen(plan[key]), true);
  }
  assert.equal(Object.isFrozen(plan), true);
  source.arguments.push("--changed"); source.environment.HOME = "/changed";
  source.privatePathEnvironmentKeys[0] = "TMPDIR"; source.codexHomeIdentity.inode += 1;
  source.tmpDirIdentity.path = "/changed"; source.workspaceIdentity.device += 1;
  source.effectivePolicyDigest = "changed";
  assert.deepEqual(plan, before);
  assert.throws(() => {plan.arguments.push("--changed");}, TypeError);
  assert.throws(() => {plan.environment.HOME = "/changed";}, TypeError);
  assert.throws(() => {plan.privatePathEnvironmentKeys[0] = "TMPDIR";}, TypeError);
  for (const identity of [plan.codexHomeIdentity, plan.tmpDirIdentity, plan.workspaceIdentity]) {
    assert.throws(() => {identity.inode += 1;}, TypeError);
  }
  assert.throws(() => {Object.defineProperty(plan, "provider", { value: "changed" });}, TypeError);
  issuer.validateCodexAppServerLaunchPlanRoots(plan);
  assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(plan), false);
  assert.throws(() => issuer.codexNativeBrokerLaunchInput(plan), /native broker launch rejected/u);
});

test("Host factory rejects proxies and accessors without executing caller code", async () => {
  const f = await fixture();
  let touched = 0;
  const trap = () => {touched += 1; throw new Error("unexpected Host factory read");};
  const proxy = <T extends object>(value: T) => new Proxy(value, {
    get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const accessor = <T extends object>(value: T, key: string) => Object.defineProperty(value, key, { get: trap });
  const revoked = Proxy.revocable(f.plan, {}); revoked.revoke();
  const issued = host.createImmutableHostCustodyLaunchPlan(f.plan);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const badPlans: unknown[] = [
    null, undefined, [], proxy(f.plan), revoked.proxy, proxy(issued), Object.create(f.plan),
    accessor({ ...f.plan }, "provider"), accessor({ ...f.plan }, "arguments"),
    accessor({ ...f.plan }, "environment"), accessor({ ...f.plan }, "spawnMode"),
    accessor({ ...f.plan }, "privatePathEnvironmentKeys"), accessor({ ...f.plan }, "extra"),
    { ...f.plan, arguments: proxy([...f.plan.arguments]) },
    { ...f.plan, arguments: accessor([...f.plan.arguments], "0") },
    { ...f.plan, arguments: Object.assign([...f.plan.arguments], { [Symbol.iterator]: trap }) },
    { ...f.plan, arguments: [proxy({ toString: trap })] },
    { ...f.plan, environment: proxy({ ...f.plan.environment }) },
    { ...f.plan, environment: accessor({ ...f.plan.environment }, "HOME") },
    { ...f.plan, environment: { ...f.plan.environment, HOME: proxy({ toString: trap }) } },
    { ...f.plan, privatePathEnvironmentKeys: proxy(["HOME"]) },
    { ...f.plan, privatePathEnvironmentKeys: accessor(["HOME"], "0") },
    { ...f.plan, executablePath: proxy({ toString: trap }) },
    { ...f.plan, extra: trap }, { ...f.plan, extra: cyclic },
    { ...f.plan, extra: { nested: proxy({}) } }, { ...f.plan, [Symbol("brand")]: true },
  ];
  for (const key of ["codexHomeIdentity", "tmpDirIdentity", "workspaceIdentity"] as const) {
    badPlans.push({ ...f.plan, [key]: proxy(f.plan[key]) },
      { ...f.plan, [key]: accessor({ ...f.plan[key] }, "inode") });
  }
  const readsBefore = observedPaths.length;
  for (const bad of badPlans) {
    assert.throws(() => host.createImmutableHostCustodyLaunchPlan(bad as HostCustodyLaunchPlan), /inert data/u);
    assert.equal(touched, 0);
  }
  assert.equal(observedPaths.length, readsBefore);
  assert.equal(f.descriptorCount(), 0);
});

test("Host snapshots retain only factory output, never frozen lookalikes or proxy wrappers", async () => {
  const f = await fixture(false);
  const issued = host.createImmutableHostCustodyLaunchPlan({ ...f.plan });
  assert.equal(snapshots.snapshotHostCustodyLaunchPlan(issued), issued);
  for (const source of [Object.freeze({ ...issued }), structuredClone(issued)]) {
    const first = snapshots.snapshotHostCustodyLaunchPlan(source);
    const second = snapshots.snapshotHostCustodyLaunchPlan(first);
    assert.notEqual(first, source); assert.notEqual(second, first);
    assert.deepEqual(first, source); assert.deepEqual(second, first);
    assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(first), false);
    assert.throws(() => issuer.codexNativeBrokerLaunchInput(first), /native broker launch rejected/u);
  }
  let touched = 0;
  const trap = () => {touched += 1; throw new Error("unexpected wrapper read");};
  const revoked = Proxy.revocable(issued, {}); revoked.revoke();
  for (const wrapped of [new Proxy(issued, {}), new Proxy(issued, { get: trap, ownKeys: trap }), revoked.proxy]) {
    assert.throws(() => snapshots.snapshotHostCustodyLaunchPlan(wrapped), /inert data/u);
    assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(wrapped), false);
    assert.throws(() => issuer.codexNativeBrokerLaunchInput(wrapped), /native broker launch rejected/u);
  }
  assert.equal(touched, 0);
});

test("generic root records are copied defensively without Host retention identity", async () => {
  const f = await fixture(false);
  const source = { ...f.plan, workspaceIdentity: { ...f.plan.workspaceIdentity } };
  const first = snapshots.snapshotHostCustodyLaunchPlan(source) as Fixture["plan"];
  const second = snapshots.snapshotHostCustodyLaunchPlan(first) as Fixture["plan"];
  assert.notEqual(first.workspaceIdentity, source.workspaceIdentity);
  assert.notEqual(second.workspaceIdentity, first.workspaceIdentity);
  source.workspaceIdentity.path = "/changed";
  assert.equal(first.workspaceIdentity.path, f.input.workspaceRef);
  assert.equal(second.workspaceIdentity.path, f.input.workspaceRef);
  assert.equal(Object.isFrozen(first.workspaceIdentity), true);
  assert.equal(Object.isFrozen(second.workspaceIdentity), true);
});

test("source dependency runs Codex -> existing Host entrypoint with no Host -> Codex import", () => {
  assert.match(boundarySources.codex,
    /import \{ createImmutableHostCustodyLaunchPlan, type HostCustodyLaunchPlan \} from "\.\.\/host-custody\/custodied-provider-process\.js"/u);
  assert.match(boundarySources.hostEntrypoint,
    /export \{ createImmutableHostCustodyLaunchPlan \} from "\.\/host-custody-launch-plan-snapshot\.js"/u);
  assert.doesNotMatch(boundarySources.hostSnapshot + boundarySources.hostEntrypoint, /codex-app-server|codexNative|isIssuedCodex/u);
  assert.doesNotMatch(boundarySources.hostEntrypoint, /export\s+\*/u);
});
