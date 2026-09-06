import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { after } from "node:test";

// Read only the pinned fixture catalog. Product filesystem/process operations
// use in-memory observations before importing any reservation or provider code.
const catalog = readFileSync(new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
export const modules = new Map<string, Record<string, unknown>>();
const slot = Symbol.for("ar69-r205-native-launch-finalization-fixture");
Reflect.set(globalThis, slot, modules);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./host-custody-launch.js" && context.parentURL?.includes("/host-custody/") &&
        !context.parentURL.includes("host-custody-launch.ts")) {
      return {url: new URL("./native-launch-finalization-observations.ts", import.meta.url).href, shortCircuit: true};
    }
    return modules.has(specifier) ? { url: `native-finalization-fixture:${specifier}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("native-finalization-fixture:")) {return next(url, context);}
    const name = url.slice("native-finalization-fixture:".length);
    const source = `const data = globalThis[Symbol.for(${JSON.stringify(slot.description)})].get(${JSON.stringify(name)});\n`
      + Object.keys(modules.get(name)!).map(key => `export const ${key} = data.${key};`).join("\n");
    return { format: "module", source, shortCircuit: true };
  },
});
after(() => {hooks.deregister(); Reflect.deleteProperty(globalThis, slot);});
const entries = new Map<string, { ino: number; mode: number; directory: boolean; bytes: Buffer; revision: number }>();
const descriptors = new Map<number, string>();
let nextInode = 10;
let nextDescriptor = 100;
let sequence = 0;
export const observedPaths: string[] = [];
const entry = (path: string) => {
  observedPaths.push(path);
  const value = entries.get(path);
  assert.ok(value, `unexpected synthetic filesystem path: ${path}`);
  return value;
};
export const stats = (path: string, options?: { bigint?: boolean }) => {
  const value = entry(path);
  const number = (input: number) => options?.bigint === true ? BigInt(input) : input;
  return {
    dev: number(1), ino: number(value.ino), mode: number(value.mode), nlink: number(1),
    uid: number(process.getuid!()), size: number(value.bytes.length),
    mtimeNs: BigInt(value.revision), ctimeNs: BigInt(value.revision),
    isDirectory: () => value.directory, isFile: () => !value.directory, isSymbolicLink: () => false,
  };
};
const canonical = (path: string) => { entry(path); return path; };
const close = (descriptor: number) => { assert.equal(descriptors.delete(descriptor), true); };
modules.set("node:fs", {
  renameSync: () => {throw new Error("real rename forbidden");},
  rmSync: () => {throw new Error("real removal forbidden");},
  readlinkSync: () => {throw new Error("real readlink forbidden");},
  constants, lstatSync: stats, statSync: stats, realpathSync: canonical,
  readdirSync: (path: string) => {
    entry(path);
    return [...entries.keys()].filter(candidate => candidate !== path && dirname(candidate) === path)
      .map(candidate => candidate.slice(path.length + 1));
  },
  openSync: (path: string) => {
    if (!path.startsWith("/proc/self/fdinfo/")) {entry(path);}
    const descriptor = nextDescriptor++;
    descriptors.set(descriptor, path);
    return descriptor;
  },
  closeSync: close,
  fstatSync: (descriptor: number, options: { bigint?: boolean }) => stats(descriptors.get(descriptor)!, options),
  readSync: (descriptor: number, buffer: Buffer) => {
    assert.match(descriptors.get(descriptor)!, /^\/proc\/self\/fdinfo\/\d+$/u);
    return buffer.write("mnt_id:\t7\n");
  },
  readFileSync: () => {throw new Error("unexpected product sync read");},
});
modules.set("node:fs/promises", {
  readFile: async () => {throw new Error("real process/config reads forbidden");},
  stat: async (path: string, options: {bigint?: boolean}) => stats(path, options),
  lstat: async (path: string, options: { bigint?: boolean }) => stats(path, options),
  realpath: async (path: string) => canonical(path),
});
modules.set("@agent-teams/filesystem-custody", {
  capturePathLineage: async (path: string) => {entry(path); return path;},
  pathLineagesEqual: (left: string, right: string) => left === right,
  openStablePath: async (path: string, expected: string, use: (opened: object) => Promise<unknown>) => {
    assert.equal(path, expected);
    const value = entry(path);
    return use({ stats: stats(path, { bigint: true }), handle: {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: value.bytes.copy(buffer, offset, position, position + length),
      }),
      readFile: async () => Buffer.from(value.bytes),
      stat: async () => stats(path, { bigint: true }),
    } });
  },
});

modules.set("executable-observations", {stats});
let lastLaunch: any;
let launchCount = 0;
let onSpawn: (() => void) | undefined;
export const spawnObservation = () => lastLaunch;
export const spawnCount = () => launchCount;
export const duringSpawn = (action?: () => void) => {onSpawn = action;};
modules.set("./node-provider-process-custody-launch.js", {
  launchGuardedProvider(input: any) {
    lastLaunch = input; launchCount += 1; onSpawn?.();
    const process = Object.freeze({custodyRef: input.live.custodyRef, workspaceAuthorityPath: "/proc/self/fd/4",
      closeInput: async () => {}, write: async () => {}, stdout: empty(), stderr: empty(),
      waitForExit: async () => ({code: 0, signal: null})});
    return {authority: {executable: input.live.executable, close() {}}, guardian: {}, child: {},
      exit: new Promise(() => {}), process, sdkProcess: Object.freeze({stdin: {}, stdout: {}})};
  },
});
async function* empty() {}
modules.set("./node-provider-process-custody-spawn-acknowledgement.js", {
  acknowledgeProviderSpawn(live: any) {
    live.spawnStatus = "acknowledged";
    live.identity = Object.freeze({...live.identity, status: "proved", binarySha256: live.executable.digest,
      childProcessInstanceSha256: live.childProcessInstanceSha256, planSha256: live.fingerprint.planSha256,
      pid: 1001, pgid: 1001, proofRef: "synthetic:process-proof"});
    return Promise.resolve("acknowledged");
  },
});
modules.set("./host-custody-private-root.js", {
  quarantinePrivateRoot: () => true, quarantinePrivateRootForReconciliation: () => true,
});
export const host = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js");
export const snapshots = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch-plan-snapshot.js");
export const issuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js");
export const boundaryIssuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js");
export const recipes = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js");
export const fileIssuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js");
export const reservation = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.js");
export const resolver = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js");
export const launch = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js");

export const directory = (path: string) => {
  if (entries.has(path)) {return;}
  if (path !== "/") {directory(dirname(path));}
  entries.set(path, { ino: nextInode++, mode: 0o40700, directory: true, bytes: Buffer.alloc(0), revision: 1 });
};
export const file = (path: string, bytes: Buffer) => {
  entries.set(path, { ino: nextInode++, mode: 0o100600, directory: false, bytes, revision: 1 });
};

export const fixture = async (native = true, intentMode: "analysis" | "workspace-write" = "analysis") => {
  const root = `/tmp/ar69-r205-native-launch-finalization-memory-${sequence++}`;
  const workspaceRef = `${root}/workspace`;
  const privateRootPath = `${workspaceRef}-host-private`;
  const codexHome = `${privateRootPath}/home`;
  const tmpDir = `${privateRootPath}/tmp`;
  for (const path of [workspaceRef, codexHome, tmpDir]) {directory(path);}
  const boundary = boundaryIssuer.createCodexAppServerPermissionBoundary({ codexHome, workspaceRef, intentMode });
  const recipe = recipes.createCodexNativeBrokerRecipe({
    boundary, endpoint: "http://10.203.0.1:43129/backend-api/codex", profile: "codex-chatgpt",
  });
  const options = {
    boundary, executablePath: `${root}/codex`, intentMode, privateRootPath, tmpDir,
    platformTarget: { architecture: "x64", platform: "linux" } as const,
  };
  file(options.executablePath, Buffer.from("synthetic executable observation only"));
  entry(options.executablePath).mode = 0o100700;
  const plan = native ? issuer.createCodexAppServerFinalizableLaunchPlan(options, access("codex")) : issuer.createCodexAppServerLaunchPlan(options);
  const providerBinding = {
    provider: "codex", adapterRevision: "synthetic-adapter", binaryRevision: plan.binaryRevision,
    capabilityManifestRevision: "synthetic-manifest", credentialBindingDigest: "synthetic-binding",
    providerRouteRef: "synthetic-route",
  };
  const input = { attemptId: "attempt:synthetic", operationId: "operation:synthetic", intentMode, workspaceRef, providerBinding };
  const workspaceAuthority = {
    canonicalPath: workspaceRef, descriptorPath: workspaceRef,
    identity: { dev: 1n, ino: BigInt(entry(workspaceRef).ino), mountId: "7" },
  };
  return { boundary, recipe, options, plan, input, workspaceAuthority,
    async install() {
      file(`${codexHome}/config.toml`, Buffer.from(recipes.renderCodexNativeBrokerConfig(recipe)));
      file(recipe.catalogPath, catalog);
      entry(codexHome).revision += 1;
      return fileIssuer.prepareCodexNativeBrokerFiles(recipe);
    },
    addDirectory: directory,
    mutate(path: string, changes: Partial<ReturnType<typeof entry>>) {Object.assign(entry(path), changes);},
    descriptorCount: () => descriptors.size,
  };
};

const actualState = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-state.js");
const liveRecords = new Map<string, ReturnType<typeof actualState.createLiveCustody>>();
modules.set("./node-provider-process-custody-state.js", {...actualState,
  createLiveCustody(...input: Parameters<typeof actualState.createLiveCustody>) {
    const live = actualState.createLiveCustody(...input); liveRecords.set(live.custodyRef, live); return live;
  },
});
export const liveFor = (ref: string) => liveRecords.get(ref)!;
const actualOptions = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-provider-options.js");
let providerOptions: ReturnType<typeof actualOptions.detachCodexProviderOptions> | undefined;
modules.set("./codex-app-server-provider-options.js", {...actualOptions,
  detachCodexProviderOptions(input: Parameters<typeof actualOptions.detachCodexProviderOptions>[0]) {
    providerOptions = actualOptions.detachCodexProviderOptions(input); return providerOptions;
  },
});
export const constructorOptions = () => providerOptions;
export const {NodeProviderProcessCustodyCore: Core} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-core.js");
export const {ContainedTurnKernelCustodyAdapter: Kernel} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js");
export const {createCodexCurrentKernelOwner} = await import("../../../dist/features/contained-agent-turn/composition/codex-current-kernel-owner.js");
export const {CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT: snapshot} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js");
export const {holdExecutableVerification} = await import("./native-launch-finalization-observations.ts");
export const {createEgressFixture, chunks} = await import("./http-egress-test-fixture.ts");
export const {ids, openInput, executeInput, access, codexCredentialOutputInventory, syntheticCodexEffectCustody} = await import("./support/current-provider-owner-fixture.ts");
export const {committedDispatchProofFixture} = await import("./support/committed-dispatch-proof-fixture.ts");

export const nodeFixture = async (native = true) => {
  const f = await fixture(native);
  const identity = ids("codex", `finalization-${sequence}`);
  const kernelInput = openInput(identity, "codex", snapshot);
  const providerBinding = {...f.input.providerBinding, ...snapshot,
    credentialBindingDigest: kernelInput.providerAccessSnapshot.credentialBindingDigest,
    providerRouteRef: kernelInput.providerAccessSnapshot.providerRouteRef};
  const input = {...f.input, attemptId: identity.attemptId, operationId: identity.operationId, providerBinding,
    launchPlan: f.plan, workspaceAuthority: f.workspaceAuthority};
  let residueCloses = 0;
  const residueAuthorityFactory = {create: async () => ({close: async () => {residueCloses += 1; return true;},
    proveEmpty: async () => "empty", killAll: async () => true})};
  const core = new Core({launchPlans: {resolve: async () => {throw new Error("unrelated resolver invoked");}},
    residueAuthorityFactory} as never, {containmentProfile: "strict-linux-cgroup-v2", platform: "linux", residueAuthorityFactory} as never);
  const preparation = Core.httpPreparation(core)!;
  const controller = new AbortController();
  const handoff = (ref: string) => ({underlyingCustodyRef: ref, signal: controller.signal,
    committedDispatchProof: committedDispatchProofFixture(kernelInput, {hostBootId: "host-boot:synthetic",
      hostInstanceId: "host-instance:synthetic", hostCustodyProof: {proofId: "proof:synthetic"}} as never)});
  const bindSession = (finalizer: any, lifetime: any) => {
    const egress = createEgressFixture();
    const proof = lifetime.committedDispatchProof;
    const sessionIdentity = {operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
      hostBootId: proof.hostBootId, liveProcessSessionIdentity: lifetime.executionSessionIdentity};
    const session = finalizer.bindSession({...egress.ports, identity: sessionIdentity, providerAccessSnapshot: {...egress.ports.providerAccessSnapshot,
      ...access("codex")}});
    return {egress, identity: sessionIdentity, session};
  };
  return {...f, identity, kernelInput, input, core, preparation, controller, handoff, bindSession,
    residueCloses: () => residueCloses,
    reserve: () => core.reserve(input as never),
    async stage() {
      const {custodyRef} = await core.reserve(input as never);
      const lifetime = preparation.acquire(handoff(custodyRef));
      const finalizer = preparation.finalize(lifetime);
      const files = await f.install();
      const stage = await finalizer.stage({recipe: f.recipe, files});
      return {custodyRef, lifetime, finalizer, files, stage};
    },
  };
};
