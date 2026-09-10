import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as synthetic from "./synthetic-native-custody-producer.fixture.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

// Explicit independent source-loaded SYNTHETIC producer, never a build shim.
const producer = new URL("./synthetic-native-custody-producer.fixture.ts", import.meta.url).href;
const dockerCustodyEffects = Symbol.for("agent-runtime.test.docker-custody-effects");
const dockerCustodyParent = "/composition/docker-kernel-host-custody.ts";
const dockerEffectModule = (body: string) => `data:text/javascript,${encodeURIComponent(body)}`;
registerHooks({resolve(specifier, context, next) {
  if (context.parentURL?.endsWith(dockerCustodyParent)) {
    if (specifier === "node:crypto") {
      return {url: dockerEffectModule(`const effects = globalThis[Symbol.for("agent-runtime.test.docker-custody-effects")];
        export function randomUUID() { effects.uuid++; throw new Error("unexpected Docker UUID allocation"); }
        export function createHash() { effects.hash++; throw new Error("unexpected Docker evidence hash"); }`), shortCircuit: true};
    }
    if (specifier.endsWith("/filesystem/retained-launch-workspace.js")) {
      return {url: dockerEffectModule(`export async function retainLaunchWorkspace() {
        globalThis[Symbol.for("agent-runtime.test.docker-custody-effects")].retain++;
        throw new Error("unexpected Docker descriptor retention");
      }`), shortCircuit: true};
    }
    if (specifier.endsWith("/docker-kernel-evidence.js")) {
      return {url: dockerEffectModule(`export class DockerKernelEvidence { constructor() {
        globalThis[Symbol.for("agent-runtime.test.docker-custody-effects")].evidence++;
        throw new Error("unexpected Docker evidence allocation");
      } }`), shortCircuit: true};
    }
  }
  if ((specifier.endsWith("/darwin-attempt-owner-selection.js") && context.parentURL?.endsWith("/native-host-custody-workspace-authority.ts")) || (specifier.endsWith("/contained-turn-kernel-custody-entrypoint.js") && [
    "codex-app-server-launch-plan.ts", "codex-app-server-permission-boundary.ts", "codex-native-broker-files.ts",
    "codex-native-broker-recipe.ts", "node-kernel-workspace-authority.ts",
  ].some(name => context.parentURL?.endsWith("/" + name))) || specifier.endsWith("/node-contained-turn-workspace-owner.js")) {
    if (specifier.endsWith("/contained-turn-kernel-custody-entrypoint.js") && context.parentURL?.endsWith("/node-kernel-workspace-authority.ts")) {
      return {url: new URL("./synthetic-native-kernel-entrypoint.fixture.ts", import.meta.url).href, shortCircuit: true};
    }
    return {url: producer, shortCircuit: true};
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const source = new URL(new URL(specifier.slice(0, -3) + ".ts", context.parentURL).href.replace("/agent-execution/dist/", "/agent-execution/src/"));
    if (existsSync(source)) {return {url: source.href, shortCircuit: true};}
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.includes("/agent-execution/src/") && url.endsWith(".ts")) {
    return {format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), {mode: "transform"}), shortCircuit: true};
  }
  return next(url, context);
}});
const permission = await import("../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.ts");
const authority = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native-host-custody-workspace-authority.ts");
const {nodeKernelWorkspaceAuthority} = await import("../../../src/features/contained-agent-turn/composition/node-kernel-workspace-authority.ts");
const {KernelOpenAttempts} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-open-attempts.ts");
const raw = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.ts");
const files = await import("../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.ts");
const recipes = await import("../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.ts");
const launch = await import("../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.ts");
const catalog = readFileSync(new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
const ids = {operationId: "synthetic-operation", attemptId: "synthetic-attempt", workspaceId: "synthetic-workspace"};
const setup = async (facts = synthetic.syntheticFacts(), mutate?: (facts: any) => void) => {
  const selection = synthetic.issueSyntheticSelection(facts, mutate);
  const observation = await synthetic.readDarwinNativeLaunchObservation(selection);
  const boundary = permission.createDarwinNativeCodexPermissionBoundary(observation, "analysis");
  const recipe = recipes.createDarwinCodexNativeBrokerRecipe({boundary, endpoint: "http://127.0.0.1:1234/backend-api/codex",
    profile: "codex-chatgpt", tmpDir: facts.tmpDir.path});
  return {selection, observation, boundary, recipe};
};
test("synthetic provenance rejects observation clones and proxies without reading traps", async () => {
  const {observation} = await setup(); let reads = 0;
  for (const fake of [{}, {...observation}, new Proxy(observation, {get() {reads++; throw new Error("synthetic forbidden property read");}})]) {
    assert.throws(() => permission.createDarwinNativeCodexPermissionBoundary(fake, "analysis"));
  }
  assert.equal(reads, 0);
});
test("synthetic roots enforce safe identities, normalized paths, leased UID and disjointness", async () => {
  for (const mutate of [
    (f: any) => f.workspace.ino = 2n ** 54n,
    (f: any) => f.codexHome.path = "/synthetic/private/../home",
    (f: any) => f.workspace.path = f.tmpDir.path,
    (f: any) => f.workspace.uid++, (f: any) => f.privateRoot.mode = 0o40777,
    (f: any) => f.tmpDir.dev = -1n,
  ]) {const f = synthetic.syntheticFacts(); mutate(f); await assert.rejects(setup(f));}
});
linuxTest("ordinary Linux boundary still validates actual disposable directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar69-custody-linux-"));
  try {mkdirSync(join(dir, "home"), {mode: 0o700}); mkdirSync(join(dir, "work"), {mode: 0o700});
    const boundary = permission.createCodexAppServerPermissionBoundary({codexHome: join(dir, "home"), workspaceRef: join(dir, "work"), intentMode: "analysis"});
    assert.equal(permission.codexDarwinNativeLaunchObservation(boundary), undefined);
    permission.validateCodexDirectoryIdentity("Linux", boundary.codexHomeIdentity);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test("native authority has no descriptor; raw Linux rejects before allocation; attempt and copy fences", async () => {
  const {selection} = await setup();
  await nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection)).withLaunchAuthority(ids, async value => {
    assert.equal(Object.hasOwn(value, "descriptorPath"), false);
    assert.equal(value.canonicalPath, "/synthetic/workspace");
    assert.throws(() => raw.descriptorWorkspaceAuthority(value));
    assert.equal(authority.inspectNativeHostCustodyWorkspaceAuthority(value, ids).selection, selection);
    assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(value, {...ids, attemptId: "other"}));
    for (const fake of [{...value}, new Proxy(value, {})]) {
      authority.retireNativeHostCustodyWorkspaceAuthority(fake);
      assert.equal(authority.isNativeHostCustodyWorkspaceAuthority(fake), false);
      assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(fake, ids));
    }
  });
  const descriptor = {canonicalPath: "/synthetic/linux", descriptorPath: "/proc/self/fd/99", identity: {dev: 1n, ino: 2n, mountId: "1"}};
  assert.equal(raw.descriptorWorkspaceAuthority(descriptor), descriptor);
});
test("Docker reserve rejects genuine native authority before retaining or allocating effects", async () => {
  const effects = {retain: 0, uuid: 0, evidence: 0, hash: 0};
  Object.defineProperty(globalThis, dockerCustodyEffects, {value: effects, configurable: true});
  try {
    const {DockerKernelHostCustody} = await import("../../../src/features/contained-agent-turn/composition/docker-kernel-host-custody.ts");
    const custody = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.ts");
    const {selection} = await setup();
    await nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection)).withLaunchAuthority(ids, async workspaceAuthority => {
      const host = new DockerKernelHostCustody(1000);
      const input = {...ids, intentMode: "analysis" as const, workspaceRef: workspaceAuthority.canonicalPath, workspaceAuthority,
        providerBinding: {provider: "codex", binaryRevision: "synthetic", adapterRevision: "synthetic",
          capabilityManifestRevision: "synthetic", credentialBindingDigest: "synthetic", providerRouteRef: "synthetic"},
        launchPlan: {arguments: [], binaryRevision: "synthetic", containmentProfile: "strict-linux-cgroup-v2" as const,
          environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64),
          privateRootPath: "/synthetic/private", intentMode: "analysis" as const, provider: "codex",
          spawnMode: "sdk-delegated" as const}};
      await assert.rejects(host.reserve(input), error => {
        assert.ok(error instanceof custody.HostCustodyUnsupportedError);
        assert.equal(error.code, "platform-profile-unavailable");
        return true;
      });
      assert.deepEqual(effects, {retain: 0, uuid: 0, evidence: 0, hash: 0});
      assert.throws(() => host.reservation("docker-host-reservation:unallocated"), /reservation unavailable/u);
    });
  } finally {
    delete (globalThis as Record<symbol, unknown>)[dockerCustodyEffects];
  }
});
test("kernel genuine native selection is once, duplicate fenced, sealed admission blocks acquisition", async () => {
  const {selection} = await setup(); const owner = nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection));
  const input = {...ids, custodyId: "synthetic-custody", adapterSnapshot: {}, providerAccessSnapshot: {}};
  const attempts = new KernelOpenAttempts(); let opens = 0; let retired = 0;
  const attemptOwner = {retire() {retired++;}};
  await attempts.open(input, owner, attemptOwner, async (_: any, value: any) => {opens++;
    assert.equal(authority.isNativeHostCustodyWorkspaceAuthority(value), true); return {};});
  await assert.rejects(attempts.open(input, owner, attemptOwner, async () => {opens++;}));
  assert.equal(opens, 1); assert.equal(retired, 0);
  const blocked = new KernelOpenAttempts(); const pending = blocked.open(input, owner, attemptOwner, async () => {opens++;});
  blocked.sealAdmission(); await assert.rejects(pending); assert.equal(opens, 1); assert.equal(retired, 1);
});
test("fixed native material is same-recipe, same-files, generation checked without Host protected path reads", async () => {
  const {selection, recipe, boundary} = await setup();
  const options = {boundary, executablePath: "/synthetic/codex", intentMode: "analysis", platformTarget: {platform: "darwin", architecture: "arm64"},
    privateRootPath: "/synthetic/private", tmpDir: "/synthetic/private/tmp"};
  const initial = launch.createCodexAppServerLaunchPlan(options);
  launch.validateCodexAppServerLaunchPlanRoots(initial);
  assert.throws(() => launch.createCodexAppServerLaunchPlan({...options, boundary: {...boundary}}));
  const installed = await files.installCodexDarwinNativeBrokerFiles(selection, recipe, catalog);
  files.validateCodexNativeBrokerFiles(installed, recipe);
  assert.equal(files.codexDarwinNativeMaterialIdentity(recipe)?.length, 48);
  for (const fake of [{...installed}, new Proxy(installed, {})]) {assert.throws(() => files.validateCodexNativeBrokerFiles(fake, recipe));}
  assert.throws(() => files.validateCodexNativeBrokerFiles(installed, {...recipe}));
  await assert.rejects(files.installCodexDarwinNativeBrokerFiles(selection, recipe, catalog));
  synthetic.expireSyntheticSelection(selection);
  assert.throws(() => files.validateCodexNativeBrokerFiles(installed, recipe));
  assert.throws(() => launch.validateCodexAppServerLaunchPlanRoots(initial));
});
test("fixed3 rejects config/catalog/UUID/readback identity mismatches", async () => {
  for (const mutate of [(f: any) => f.config.sha256 = "0".repeat(64), (f: any) => f.catalog.bytes--,
    (f: any) => f.installationId = "wrong", (f: any) => f.installation.mode = 0o100600,
    (f: any) => f.config.uid++, (f: any) => f.config.ino = f.catalog.ino,
    (f: any) => f.catalog.path = "/synthetic/wrong"]) {
    const {selection, recipe} = await setup(synthetic.syntheticFacts(), mutate);
    await assert.rejects(files.installCodexDarwinNativeBrokerFiles(selection, recipe, catalog));
  }
});

test("synchronous native finalizer cannot manufacture material, clone files, or skip expiry", async () => {
  const {selection, recipe, boundary} = await setup();
  const options = {boundary, executablePath: "/synthetic/codex", intentMode: "analysis", platformTarget: {platform: "darwin", architecture: "arm64"},
    privateRootPath: "/synthetic/private", tmpDir: "/synthetic/private/tmp"};
  const plan = launch.createCodexAppServerFinalizableLaunchPlan(options, {provider: "codex", providerRouteRef: "synthetic-route",
    credentialGeneration: 1, credentialBindingRef: "synthetic-binding", ownerAuthorityDigest: "synthetic-authority"});
  const {hostLaunchFinalizationRecipe} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-finalizable-plan.ts");
  const finalizer = hostLaunchFinalizationRecipe(plan)!;
  assert.throws(() => finalizer.build({recipe, files: {kind: "codex-native-broker-prepared-files/v1"}}, "s".repeat(32)));
  const installed = await files.installCodexDarwinNativeBrokerFiles(selection, recipe, catalog);
  const result = finalizer.build({recipe, files: installed}, "s".repeat(32));
  assert.match(result.materialSha256, /^[a-f0-9]{64}$/u); result.validate();
  assert.throws(() => finalizer.build({recipe, files: {...installed}}, "s".repeat(32)));
  synthetic.expireSyntheticSelection(selection);
  assert.throws(() => result.validate());
  assert.throws(() => finalizer.build({recipe, files: installed}, "s".repeat(32)));
});
test("selection and material clones/proxies and cross-operation selections are rejected", async () => {
  const {selection, recipe, boundary} = await setup();
  for (const fake of [{...selection}, new Proxy(selection, {})]) {
    await assert.rejects(files.installCodexDarwinNativeBrokerFiles(fake, recipe, catalog));
  }
  const wrongFacts = synthetic.syntheticFacts(); wrongFacts.operationId = "synthetic-other-operation";
  await assert.rejects(files.installCodexDarwinNativeBrokerFiles(synthetic.issueSyntheticSelection(wrongFacts), recipe, catalog));
  const material = await synthetic.installDarwinNativeCodexMaterial(selection, {config: Buffer.from("synthetic"), catalog,
    installationId: "00000000-0000-4000-8000-000000000000"});
  for (const fake of [{...material}, new Proxy(material, {})]) {
    assert.throws(() => permission.acceptCodexDarwinNativeMaterialObservation(boundary, fake));
  }
});

test("authenticated material advances boundary generation; synchronous final build retains that observation", async () => {
  const {selection, observation, recipe, boundary} = await setup();
  const options = {boundary, executablePath: "/synthetic/codex", intentMode: "analysis", platformTarget: {platform: "darwin", architecture: "arm64"},
    privateRootPath: "/synthetic/private", tmpDir: "/synthetic/private/tmp"};
  const plan = launch.createCodexAppServerFinalizableLaunchPlan(options, {provider: "codex", providerRouteRef: "synthetic-route",
    credentialGeneration: 1, credentialBindingRef: "synthetic-binding", ownerAuthorityDigest: "synthetic-authority"});
  synthetic.advanceSyntheticGenerationOnInstall(selection);
  const installed = await files.installCodexDarwinNativeBrokerFiles(selection, recipe, catalog);
  assert.notEqual(permission.codexDarwinNativeLaunchObservation(boundary), observation);
  assert.throws(() => synthetic.assertDarwinNativeLaunchObservationCurrent(observation));
  const {hostLaunchFinalizationRecipe} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-finalizable-plan.ts");
  hostLaunchFinalizationRecipe(plan)!.build({recipe, files: installed}, "s".repeat(32)).validate();
});

test("Linux callback failure cannot reopen the same attempt or invoke scoped acquisition twice", async () => {
  const attempts = new KernelOpenAttempts(); let calls = 0; let retires = 0;
  const target = {canonicalPath: "/synthetic/linux", descriptorPath: "/proc/self/fd/99", identity: {dev: 1n, ino: 2n, mountId: "1"}};
  const owner = {withLaunchAuthority: async (_: unknown, consume: any) => {
    try {consume(target);} catch {}
    return consume(target);
  }};
  const input = {...ids, custodyId: "synthetic-failed", adapterSnapshot: {}, providerAccessSnapshot: {}};
  const prepare = () => {calls++; throw new Error("synthetic synchronous failure");};
  const attemptOwner = {retire() {retires++;}};
  await assert.rejects(attempts.open(input, owner, attemptOwner, prepare));
  assert.equal(calls, 1); assert.equal(retires, 1);
  await assert.rejects(attempts.open(input, owner, attemptOwner, prepare));
  assert.equal(calls, 1); assert.equal(retires, 1);
});

linuxTest("Linux reservation retains and rechecks the actual disposable descriptor and mount identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar69-custody-descriptor-"));
  let descriptor: number | undefined;
  try {
    const workspace = join(dir, "workspace"); mkdirSync(workspace, {mode: 0o700});
    descriptor = openSync(workspace, constants.O_RDONLY | constants.O_DIRECTORY);
    const stats = fstatSync(descriptor, {bigint: true});
    const mountId = /^mnt_id:\s*(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8"))![1];
    const input = {...ids, intentMode: "analysis", workspaceRef: workspace,
      providerBinding: {provider: "codex", adapterRevision: "synthetic", binaryRevision: "synthetic", capabilityManifestRevision: "synthetic",
        credentialBindingDigest: "synthetic", providerRouteRef: "synthetic"},
      workspaceAuthority: {canonicalPath: workspace, descriptorPath: `/proc/self/fd/${descriptor}`, identity: {dev: stats.dev, ino: stats.ino, mountId}},
      launchPlan: {provider: "codex", arguments: [], binaryRevision: "synthetic", containmentProfile: "strict-linux-cgroup-v2", environment: {},
        executablePath: "/synthetic/provider", executableSha256: "1".repeat(64), intentMode: "analysis", privateRootPath: "/synthetic/private", spawnMode: "sdk-delegated"}};
    const events: string[] = []; const owner = {};
    raw.privateHostCustodyReservationTestSupport.install(owner, {descriptorLifecycle: (event: string) => {events.push(event);}});
    const retained = await raw.bindPrivateHostCustodyReservation(input, owner, {containmentProfile: "strict-linux-cgroup-v2"});
    try {retained.retainedWorkspaceAuthority.assertLaunchDescriptor(descriptor);
      assert.equal(retained.retainedWorkspaceAuthority.identity.ino, stats.ino);
    } finally {retained.retainedWorkspaceAuthority.close();}
    assert.deepEqual(events, ["opened", "closed"]);
    const {selection} = await setup();
    await nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection)).withLaunchAuthority(ids, async native => {
      await assert.rejects(raw.bindPrivateHostCustodyReservation({...input, workspaceAuthority: native}, owner, {containmentProfile: "strict-linux-cgroup-v2"}));
      assert.deepEqual(events, ["opened", "closed"]);
    });
  } finally {if (descriptor !== undefined) {closeSync(descriptor);} rmSync(dir, {recursive: true, force: true});}
});

test("native material preparation never falls back to the legacy Host-UID installer", async () => {
  const {selection, recipe, boundary} = await setup();
  // These protected synthetic paths do not exist on the Host. Failure must be
  // a consumer refusal, never an attempted lstat reported as ENOENT/EACCES.
  await assert.rejects(files.prepareCodexNativeBrokerFiles(recipe), /Codex native broker files rejected/u);
  const {DarwinCodexNativeFiles} = await import("../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/darwin-codex-native-files.ts");
  assert.throws(() => new DarwinCodexNativeFiles(boundary, catalog, {}, () => {}), /requires the native material installer/u);
  const installed = await files.installCodexDarwinNativeBrokerFiles(selection, recipe, catalog);
  assert.equal(await files.prepareCodexNativeBrokerFiles(recipe), installed);
  await assert.rejects(files.prepareCodexNativeBrokerFiles({...recipe}), /recipe rejected/u);
  synthetic.expireSyntheticSelection(selection);
  await assert.rejects(files.prepareCodexNativeBrokerFiles(recipe), /expired/u);
});

test("native authority retires on callback failure or owner failure after callback", async () => {
  for (const ownerFails of [false, true]) {
    const {selection} = await setup();
    const owner = synthetic.issueSyntheticOwner(selection, ownerFails);
    let captured: object | undefined;
    await assert.rejects(nodeKernelWorkspaceAuthority(owner).withLaunchAuthority(ids, async value => {
      captured = value;
      assert.equal(authority.isNativeHostCustodyWorkspaceAuthority(value), true);
      if (!ownerFails) {throw new Error("synthetic preparation failure");}
    }));
    assert.notEqual(captured, undefined);
    assert.equal(authority.isNativeHostCustodyWorkspaceAuthority(captured), true);
    assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(captured, ids), /provenance/u);
  }
});


test("private owner wiring rejects foreign owners and operation/attempt/workspace mismatches", async () => {
  const {selection} = await setup();
  const owner = synthetic.issueSyntheticOwner(selection);
  let calls = 0;
  for (const key of ["operationId", "attemptId", "workspaceId"]) {
    await assert.rejects(nodeKernelWorkspaceAuthority(owner).withLaunchAuthority({...ids, [key]: "foreign"}, async () => {calls++;}));
  }
  for (const fake of [{...owner}, new Proxy(owner, {})]) {
    assert.equal(synthetic.isNodeContainedTurnNativeWorkspaceOwner(fake), false);
    await assert.rejects(async () => nodeKernelWorkspaceAuthority(fake).withLaunchAuthority(ids, async () => {calls++;}));
  }
  assert.equal(calls, 0);
});

test("Host issuance requires an authenticated current selection and matching operation", async () => {
  const {selection} = await setup(); let calls = 0; let reads = 0;
  for (const fake of [{}, {...selection}, new Proxy(selection, {get() {reads++; throw new Error("synthetic forbidden property read");}})]) {
    await assert.rejects(authority.withNativeHostCustodyWorkspaceAuthority(fake, ids, async () => {calls++;}));
  }
  await assert.rejects(authority.withNativeHostCustodyWorkspaceAuthority(selection, {...ids, operationId: "foreign"}, async () => {calls++;}));
  synthetic.expireSyntheticSelection(selection);
  await assert.rejects(authority.withNativeHostCustodyWorkspaceAuthority(selection, ids, async () => {calls++;}));
  assert.equal(calls, 0); assert.equal(reads, 0);
});

test("Host grant inspection binds workspace as well as operation and attempt", async () => {
  const {selection} = await setup();
  await nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection)).withLaunchAuthority(ids, async value => {
    for (const key of ["operationId", "attemptId", "workspaceId"]) {
      assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(value, {...ids, [key]: "foreign"}));
    }
    assert.deepEqual(value.identity, {dev: 1n, ino: 5n});
    synthetic.expireSyntheticSelection(selection);
    assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(value, ids));
  });
});

test("private native wiring fences callbacks after owner settlement and repeated callbacks", async () => {
  for (const repeat of [false, true]) {
    const {selection} = await setup(); const owner = synthetic.issueSyntheticOwner(selection);
    let late: (() => Promise<unknown>) | undefined; let calls = 0;
    synthetic.setSyntheticOwnerBehavior(owner, async consume => {
      late = consume;
      if (repeat) {await consume();}
    });
    await nodeKernelWorkspaceAuthority(owner).withLaunchAuthority(ids, async () => {calls++;});
    await assert.rejects(async () => late!(), /already consumed/u);
    assert.equal(calls, repeat ? 1 : 0);
  }
});

test("native owner rejection during pending preparation revokes grant and retires kernel attempt", async () => {
  const {selection} = await setup(); const owner = synthetic.issueSyntheticOwner(selection);
  let captured: object | undefined; let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => {started = resolve;});
  const pending = new Promise<void>(resolve => {finish = resolve;});
  synthetic.setSyntheticOwnerBehavior(owner, async consume => {
    void consume().catch(() => {});
    await entered;
    throw new Error("synthetic owner asynchronous failure");
  });
  const attempts = new KernelOpenAttempts(); let retires = 0;
  const input = {...ids, custodyId: "synthetic-pending", adapterSnapshot: {}, providerAccessSnapshot: {}};
  const result = attempts.open(input, nodeKernelWorkspaceAuthority(owner), {retire() {retires++;}}, async (_: any, value: any) => {
    captured = value; started(); await pending;
    assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(value, ids));
    throw new Error("synthetic preparation cut off");
  });
  await entered;
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(authority.isNativeHostCustodyWorkspaceAuthority(captured), true);
  assert.equal(retires, 0);
  finish(); await assert.rejects(result, /owner asynchronous failure/u);
  assert.equal(retires, 1);
  await assert.rejects(attempts.open(input, nodeKernelWorkspaceAuthority(owner), {retire() {retires++;}}, async () => {}), /already consumed/u);
  assert.equal(retires, 1);
});

test("private wiring preserves the existing descriptor owner by identity", () => {
  const owner = {withLaunchAuthority: async (_: unknown, consume: any) => consume({descriptorPath: "/proc/self/fd/99"})};
  assert.equal(nodeKernelWorkspaceAuthority(owner), owner);
});


test("native owner failure cuts off issuance while authenticated observation read is pending", async () => {
  const {selection} = await setup(); const owner = synthetic.issueSyntheticOwner(selection);
  const release = synthetic.pauseSyntheticObservation(selection); let calls = 0;
  synthetic.setSyntheticOwnerBehavior(owner, async consume => {
    void consume().catch(() => {});
    throw new Error("synthetic early owner failure");
  });
  const result = assert.rejects(nodeKernelWorkspaceAuthority(owner).withLaunchAuthority(ids, async () => {calls++;}), /early owner failure/u);
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(calls, 0);
  await result; release();
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(calls, 0);
});

test("actual kernel checks Host registry before preparation for forged, cloned, proxy and mismatched grants", async () => {
  const {ContainedTurnKernelCustodyAdapter} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.ts");
  const {selection} = await setup(); let prepares = 0; let reserves = 0; let reads = 0;
  await nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection)).withLaunchAuthority(ids, async grant => {
    const input = {...ids, custodyId: "synthetic-registry", intentMode: "analysis", adapterSnapshot: {}, providerAccessSnapshot: {}};
    const run = (value: any, override = {}) => {
      const kernel = new ContainedTurnKernelCustodyAdapter({reserve: async () => {reserves++;}}, {
        postClaimPreparation: "current-owner", hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
        workspaceOwner: {withLaunchAuthority: async (_: unknown, consume: any) => consume(value)},
        attemptOwner: {retire() {}, prepare: async () => {prepares++; throw new Error("synthetic preparation reached");}},
      });
      return kernel.open({...input, ...override});
    };
    for (const fake of [{}, {...grant}, new Proxy(grant, {get() {reads++; throw new Error("synthetic forbidden property read");}})]) {
      await assert.rejects(run(fake), /scoped workspace authority/u);
    }
    for (const key of ["operationId", "attemptId", "workspaceId"]) {
      await assert.rejects(run(grant, {[key]: "foreign"}), /provenance or attempt mismatch/u);
    }
    assert.equal(prepares, 0); assert.equal(reserves, 0); assert.equal(reads, 0);
    await assert.rejects(run(grant), /synthetic preparation reached/u);
    assert.equal(prepares, 1); assert.equal(reserves, 0);
  });
});

const kernelRegressionInput = async (custodyId: string) => {
  const fixture = await import("../../contained-turn-kernel-fixtures.ts");
  return {...ids, custodyId, intentMode: "analysis", adapterSnapshot: fixture.adapterSnapshot,
    providerAccessSnapshot: fixture.providerAccessSnapshot, authorityVectorDigest: fixture.authorityDigest,
    commandId: fixture.commandId, effectId: fixture.effectId, operationCutoffRevision: 0,
    operationRevision: 1, preparationToken: fixture.preparationToken};
};

test("actual kernel drains successful preparation after owner rejection without acquisition or replay", async () => {
  const {ContainedTurnKernelCustodyAdapter} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.ts");
  const {selection} = await setup(); const owner = synthetic.issueSyntheticOwner(selection);
  const entered = Promise.withResolvers<void>(); const preparation = Promise.withResolvers<object>();
  const failure = new Error("synthetic original owner rejection");
  synthetic.setSyntheticOwnerBehavior(owner, async consume => {
    void consume().catch(() => {}); await entered.promise; throw failure;
  });
  const counts = {prepare: 0, reserve: 0, retain: 0, retire: 0};
  const kernel = new ContainedTurnKernelCustodyAdapter({reserve: async () => {
    counts.reserve++; return {custodyRef: "synthetic:unexpected-reservation"};
  }}, {
    postClaimPreparation: "current-owner", hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
    workspaceOwner: nodeKernelWorkspaceAuthority(owner),
    attemptOwner: {
      prepare: async () => {counts.prepare++; entered.resolve(); return preparation.promise;},
      retain() {counts.retain++;}, retire() {counts.retire++;},
    },
  });
  const input = await kernelRegressionInput("synthetic-successful-pending");
  const rejected = assert.rejects(kernel.open(input), error => error === failure);
  await entered.promise;
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.deepEqual(counts, {prepare: 1, reserve: 0, retain: 0, retire: 0});
  preparation.resolve(Object.freeze({provider: "codex", arguments: [], environment: {},
    binaryRevision: "synthetic", containmentProfile: "strict-linux-cgroup-v2", executablePath: "/synthetic/provider",
    executableSha256: "3".repeat(64), intentMode: "analysis", privateRootPath: "/synthetic/private", spawnMode: "sdk-delegated"}));
  await rejected;
  assert.deepEqual(counts, {prepare: 1, reserve: 0, retain: 0, retire: 1});
  await assert.rejects(kernel.open(input), /already consumed/u);
  assert.deepEqual(counts, {prepare: 1, reserve: 0, retain: 0, retire: 1});
});

test("actual kernel rechecks revoked native kind after successful preparation with owner still active", async () => {
  const {ContainedTurnKernelCustodyAdapter} = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.ts");
  const {selection} = await setup(); const counts = {reserve: 0, retain: 0, retire: 0};
  await nodeKernelWorkspaceAuthority(synthetic.issueSyntheticOwner(selection)).withLaunchAuthority(ids, async grant => {
    const kernel = new ContainedTurnKernelCustodyAdapter({reserve: async () => {
      counts.reserve++; return {custodyRef: "synthetic:unexpected-reservation"};
    }}, {
      postClaimPreparation: "current-owner", hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
      workspaceOwner: {withLaunchAuthority: async (_: unknown, consume: any) => consume(grant)},
      attemptOwner: {
        prepare: async () => {authority.retireNativeHostCustodyWorkspaceAuthority(grant); return {};},
        retain() {counts.retain++;}, retire() {counts.retire++;},
      },
    });
    const input = await kernelRegressionInput("synthetic-revoked-during-prepare");
    await assert.rejects(kernel.open(input), /provenance or attempt mismatch/u);
    assert.equal(authority.isNativeHostCustodyWorkspaceAuthority(grant), true);
    assert.throws(() => authority.inspectNativeHostCustodyWorkspaceAuthority(grant, ids), /provenance/u);
    await assert.rejects(kernel.open(input), /already consumed/u);
    assert.deepEqual(counts, {reserve: 0, retain: 0, retire: 1});
  });
});

test("private wiring propagates original owner rejection before scoped preparation settles", async () => {
  const {selection} = await setup(); const owner = synthetic.issueSyntheticOwner(selection);
  const entered = Promise.withResolvers<void>(); const preparation = Promise.withResolvers<void>();
  const failure = new Error("synthetic immediate owner rejection");
  synthetic.setSyntheticOwnerBehavior(owner, async consume => {
    void consume().catch(() => {}); await entered.promise; throw failure;
  });
  let rejected = false;
  const result = assert.rejects(nodeKernelWorkspaceAuthority(owner).withLaunchAuthority(ids, async () => {
    entered.resolve(); await preparation.promise;
  }), error => {rejected = true; return error === failure;});
  await entered.promise;
  await new Promise<void>(resolve => {setImmediate(resolve);});
  try {assert.equal(rejected, true);} finally {preparation.resolve(); await result;}
});
