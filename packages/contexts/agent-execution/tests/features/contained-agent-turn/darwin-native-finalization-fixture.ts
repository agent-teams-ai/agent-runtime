import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { after } from "node:test";
import { CODEX_APP_SERVER_DARWIN_ARM64_TUPLE, CODEX_APP_SERVER_LINUX_X64_TUPLE } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";

// Only Node observations are replaced. All product modules, including executable
// verification, stable file custody, issuance, finalization and HTTP binding, run.
export const tuple = CODEX_APP_SERVER_DARWIN_ARM64_TUPLE;
export const linuxTuple = CODEX_APP_SERVER_LINUX_X64_TUPLE;
const fixtureRoot = new URL("../../fixtures/", import.meta.url);
const retained = new Map<string, Buffer>();
for (const name of ["models.json", "input-config.analysis.toml", "capture.darwin-analysis.json",
  "capture.darwin-workspace-write.json", "provenance.json"]) {
  const url = new URL(`codex-native-broker-0.153.4/${name}`, fixtureRoot);
  retained.set(url.href, fs.readFileSync(url));
}
const configUrl = new URL("codex-native-config-0.153.4/config-read.darwin-analysis.json", fixtureRoot);
retained.set(configUrl.href, fs.readFileSync(configUrl));
export const retainedBytes = (name: string) => retained.get(new URL(`codex-native-broker-0.153.4/${name}`, fixtureRoot).href)!;
interface Entry { nlink?: number; uid?: number; ino: number; mode: number; directory: boolean; bytes: Buffer; revision: number }
const entries = new Map<string, Entry>();
const descriptors = new Map<number, Entry>();
export const descriptorIsOpen = (descriptor: number) => descriptors.has(descriptor);
let sequence = 0; let nextInode = 10; let nextDescriptor = 100;
export const observedPaths: string[] = [];
export const materialPreimages: string[] = [];
const forbidden = () => {throw new Error("unexpected real filesystem, socket or process operation");};
let preparationOS = false;
export const preparationEffects: string[] = [];
export const enablePreparationOS = () => {preparationOS = true;};
const entry = (path: string): Entry => {
  observedPaths.push(path);
  const descriptor = /^\/dev\/fd\/(\d+)$/u.exec(path);
  const value = descriptor === null ? entries.get(path) : descriptors.get(Number(descriptor[1]));
  if (value === undefined && preparationOS) {throw Object.assign(new Error(`missing synthetic path ${path}`), {code: "ENOENT"});}
  assert.ok(value, `unexpected in-memory path: ${path}`);
  return value;
};
const stats = (value: Entry, options?: {bigint?: boolean}) => {
  const number = (input: number) => options?.bigint === true ? BigInt(input) : input;
  return {dev: number(1), ino: number(value.ino), mode: number(value.mode), uid: number(value.uid ?? process.getuid!()),
    nlink: number(value.nlink ?? 1), size: number(value.bytes.length), ctimeNs: BigInt(value.revision), mtimeNs: BigInt(value.revision),
    isDirectory: () => value.directory, isFile: () => !value.directory, isSymbolicLink: () => false};
};
export const directory = (path: string): void => {
  if (entries.has(path)) {return;}
  if (path !== "/") {directory(dirname(path));}
  entries.set(path, {ino: nextInode++, mode: 0o40700, directory: true, bytes: Buffer.alloc(0), revision: 1});
};
export const file = (path: string, bytes: Buffer, mode = 0o100600): void => {
  entries.set(path, {ino: nextInode++, mode, directory: false, bytes, revision: 1});
};
export const mutate = (path: string, changes: Partial<Entry>) => {Object.assign(entry(path), changes);};
const openSync = (path: string, flags = 0, mode = 0o600) => {
  if (preparationOS && (flags & fs.constants.O_CREAT) !== 0) {
    assert.ok(path.startsWith("/private/tmp/ar69-r213-memory-") || path.startsWith("/durable/"));
    if (entries.has(path) && (flags & fs.constants.O_EXCL) !== 0) {throw Object.assign(new Error("exists"), {code: "EEXIST"});}
    preparationEffects.push(`create:${path}`); file(path, Buffer.alloc(0), 0o100000 | mode);
    entry(dirname(path)).revision++;
  }
  const fd = nextDescriptor++; descriptors.set(fd, entry(path)); return fd;
};
const closeSync = (fd: number) => {assert.equal(descriptors.delete(fd), true);};
const canonical = (path: string) => {entry(path); return path;};
let heldPath: string | undefined;
let readEntered: (() => void) | undefined;
let readGate: Promise<void> | undefined;
export const holdRead = (path: string) => {
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  heldPath = path; readEntered = entered.resolve; readGate = gate.promise;
  return {entered: entered.promise, release() {heldPath = undefined; readEntered = undefined; readGate = undefined; gate.resolve();}};
};
const blockedFunctions = (module: object) => Object.fromEntries(Object.entries(module)
  .filter(([key]) => key !== "default").map(([key, value]) => [key, typeof value === "function" ? forbidden : value]));
const modules = new Map<string, Record<string, unknown>>();
modules.set("node:fs", {...blockedFunctions(fs), constants: fs.constants,
  lstatSync: (path: string, options: {bigint?: boolean}) => stats(entry(path), options),
  statSync: (path: string, options: {bigint?: boolean}) => stats(entry(path), options),
  realpathSync: canonical, openSync, closeSync,
  fchmodSync: (fd: number, mode: number) => {assert.ok(preparationOS); const value = descriptors.get(fd)!;
    value.mode = 0o100000 | mode; value.revision++;},
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    descriptors.get(fd)!.bytes.copy(buffer, offset, position, position + length),
  fsyncSync: (fd: number) => {assert.ok(preparationOS && descriptors.has(fd)); preparationEffects.push("fsync");},
  writeSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
    assert.ok(preparationOS); const value = descriptors.get(fd)!; assert.ok(value && !value.directory);
    const next = Buffer.alloc(Math.max(value.bytes.length, position + length)); value.bytes.copy(next);
    bytes.copy(next, position, offset, offset + length); value.bytes = next; value.revision++; return length;
  },
  unlinkSync: (path: string) => {assert.ok(preparationOS); const value = entry(path); value.nlink = 0;
    assert.equal(entries.delete(path), true); entry(dirname(path)).revision++; preparationEffects.push(`unlink:${path}`);},
  fstatSync: (fd: number, options: {bigint?: boolean}) => stats(descriptors.get(fd)!, options),
  readFileSync: (path: string | number | URL, encoding?: string) => {
    const bytes = path instanceof URL ? retained.get(path.href)
      : typeof path === "number" ? descriptors.get(path)?.bytes : entry(path).bytes;
    assert.ok(bytes, "only enumerated repository fixtures can be read");
    return encoding === "utf8" ? bytes.toString("utf8") : Buffer.from(bytes);
  },
  readdirSync: (path: string) => {entry(path); return [...entries.keys()]
    .filter(candidate => candidate !== path && dirname(candidate) === path).map(candidate => candidate.slice(path.length + 1));},
});
modules.set("node:fs/promises", {...blockedFunctions(fsPromises),
  lstat: async (path: string, options: {bigint?: boolean}) => stats(entry(path), options),
  stat: async (path: string, options: {bigint?: boolean}) => stats(entry(path), options), realpath: async (path: string) => canonical(path),
  open: async (path: string) => {
    const fd = openSync(path); const value = descriptors.get(fd)!;
    return {fd, close: async () => closeSync(fd), stat: async (options: {bigint?: boolean}) => stats(value, options),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: value.bytes.copy(buffer, offset, position, position + length),
      }),
      readFile: async () => {
        if (path === heldPath) {readEntered?.(); await readGate;}
        return Buffer.from(value.bytes);
      },
    };
  },
});
class MemoryServer extends EventEmitter {
  listening = false;
  listen() {assert.ok(preparationOS); preparationEffects.push("listen"); this.listening = true; queueMicrotask(() => this.emit("listening")); return this;}
  address() {return this.listening ? {address: "127.0.0.1", family: "IPv4", port: 32123} : null;}
  close() {this.listening = false; preparationEffects.push("listener-close"); queueMicrotask(() => this.emit("close")); return this;}
}
modules.set("node:net", {...blockedFunctions(net), isIPv4: net.isIPv4, Server: MemoryServer});
const darwinBinary = Buffer.from("synthetic Darwin executable bytes; never executable");
const linuxBinary = Buffer.from("synthetic Linux executable bytes; never executable");
modules.set("node:crypto", {...crypto,
  createHash(algorithm: string) {
    const hash = crypto.createHash(algorithm); const parts: Buffer[] = [];
    const wrapper = {update(value: string | Uint8Array) {
      parts.push(Buffer.from(value)); hash.update(value); return wrapper;
    }, digest(encoding: "hex") {
      const bytes = Buffer.concat(parts);
      // A narrowly mocked binary hash observation, never an executable verifier
      // override: wrong bytes still hash normally and fail the real verifier.
      if (algorithm === "sha256" && bytes.equals(darwinBinary)) {return tuple.binarySha256;}
      if (algorithm === "sha256" && bytes.equals(linuxBinary)) {return linuxTuple.binarySha256;}
      if (bytes.length < 16_384 && bytes.toString().includes('"execution":"canonical-paths"')) {
        materialPreimages.push(bytes.toString());
      }
      return hash.digest(encoding);
    }};
    return wrapper;
  },
});
let controlledSpawn: ((...args: unknown[]) => unknown) | undefined;
let controlledNative: ((...args: unknown[]) => unknown) | undefined;
export const controlDarwinChildObservations = (spawn?: (...args: unknown[]) => unknown, native?: (...args: unknown[]) => unknown) => {
  controlledSpawn = spawn; controlledNative = native;
};
let spawnRequest: Readonly<{command: string; options: {env: object; stdio: unknown[]}}> | undefined;
export const lastSpawnRequest = () => spawnRequest;
modules.set("node:child_process", {...blockedFunctions(childProcess),
  execFileSync: (...args: unknown[]) => controlledNative === undefined ? forbidden() : controlledNative(...args), spawn(command: string, _args: string[], options: {env: object; stdio: unknown[]}) {
  spawnRequest = {command, options};
  if (controlledSpawn !== undefined) {return controlledSpawn(command, _args, options);}
  throw new Error("synthetic Node spawn refusal; no process created");
}});
const slot = Symbol.for("ar69-r213-darwin-native-node-fixture");
Reflect.set(globalThis, slot, modules);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return modules.has(specifier) ? {url: `darwin-native-node:${specifier}`, shortCircuit: true} : next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("darwin-native-node:")) {return next(url, context);}
    const name = url.slice("darwin-native-node:".length);
    const source = `const data = globalThis[Symbol.for(${JSON.stringify(slot.description)})].get(${JSON.stringify(name)});\n`
      + Object.keys(modules.get(name)!).filter(key => key !== "default")
        .map(key => `export const ${key} = data.${key};`).join("\n") + "\nexport default data;";
    return {format: "module", source, shortCircuit: true};
  },
});
after(() => {hooks.deregister(); Reflect.deleteProperty(globalThis, slot); assert.equal(descriptors.size, 0);});

export const issuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js");
export const boundaries = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js");
export const recipes = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js");
export const filesIssuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js");
export const launch = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js");
export const validation = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-launch-finalization-validation.js");
export const material = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-launch-platform-material.js");
export const darwin = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-darwin-launch.js");
export const guarded = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-launch.js");
export const host = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js");
const {bindPrivateHostCustodyReservation} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.js");
const {createLiveCustody} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-state.js");
const {openHostCustodyReservation} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-open.js");
const {readNodeCustodyHttpHandoff} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-http-reservation.js");
const {ids, access, openInput} = await import("./support/current-provider-owner-fixture.ts");
const {committedDispatchProofFixture} = await import("./support/committed-dispatch-proof-fixture.ts");
export const {createEgressFixture} = await import("./http-egress-test-fixture.ts");
export const captures = await import("../../fixtures/codex-native-broker-0.153.4/fixture.ts");
export const legacyCapture = await import("../../fixtures/codex-native-config-0.153.4/fixture.ts");
export const providerOptions = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-provider-options.js");

export const fixture = (mode: "analysis" | "workspace-write" = "analysis", darwinLoopback = false) => {
  const root = `/private/tmp/ar69-r213-memory-${sequence++}`;
  const workspaceRef = `${root}/workspace`; const privateRootPath = `${workspaceRef}-host-private`;
  const codexHome = `${privateRootPath}/home`; const tmpDir = `${privateRootPath}/tmp`;
  for (const path of [workspaceRef, codexHome, tmpDir]) {directory(path);}
  const boundary = boundaries.createCodexAppServerPermissionBoundary({codexHome, workspaceRef, intentMode: mode});
  const recipe = darwinLoopback ? recipes.createDarwinCodexNativeBrokerRecipe({boundary, tmpDir, endpoint: "http://127.0.0.1:32123/backend-api/codex", profile: "codex-chatgpt"})
    : recipes.createCodexNativeBrokerRecipe({boundary, endpoint: captures.fixtureEndpoint, profile: "codex-chatgpt"});
  const options = {boundary, executablePath: `${root}/codex`, intentMode: mode, privateRootPath, tmpDir,
    platformTarget: {platform: "darwin", architecture: "arm64"} as const};
  file(options.executablePath, darwinBinary, 0o100700);
  const plan = issuer.createCodexAppServerFinalizableLaunchPlan(options, access("codex"));
  const identity = ids("codex", `darwin-native-${sequence}`);
  const snapshot = {provider: "codex", adapterRevision: tuple.adapterRevision,
    binaryRevision: tuple.binaryRevision, capabilityManifestRevision: tuple.protocolRevision};
  const kernelInput = openInput(identity, "codex", snapshot);
  const input = {attemptId: identity.attemptId, operationId: identity.operationId, intentMode: mode, workspaceRef,
    providerBinding: {...snapshot, credentialBindingDigest: access("codex").credentialBindingDigest,
      providerRouteRef: access("codex").providerRouteRef}};
  let nativeFiles: import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-codex-native-files.js").DarwinCodexNativeFiles | undefined;
  return {options, boundary, recipe, plan, input, identity, kernelInput,
    workspaceAuthority: () => ({canonicalPath: workspaceRef, descriptorPath: workspaceRef,
      identity: {dev: 1n, ino: BigInt(entry(workspaceRef).ino), mountId: "darwin-statfs:synthetic"}}),
    async install() {
      if (darwinLoopback) {
        enablePreparationOS();
        const {DarwinCodexNativeFiles} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-codex-native-files.js");
        nativeFiles = new DarwinCodexNativeFiles(boundary, retainedBytes("models.json"), {record() {}} as never, () => {});
        nativeFiles.install(recipe);
        return filesIssuer.prepareCodexNativeBrokerFiles(recipe);
      }
      file(`${codexHome}/config.toml`, Buffer.from(recipes.renderCodexNativeBrokerConfig(recipe)));
      file(recipe.catalogPath, retainedBytes("models.json")); entry(codexHome).revision += 1;
      return filesIssuer.prepareCodexNativeBrokerFiles(recipe);
    },
    async reserve(selected = plan) {
      const workspaceAuthority = {canonicalPath: workspaceRef, descriptorPath: workspaceRef,
        identity: {dev: 1n, ino: BigInt(entry(workspaceRef).ino), mountId: "darwin-statfs:synthetic"}};
      const residueAuthorityFactory = {create: async () => {throw new Error("not used for delegated open");}};
      const bound = await bindPrivateHostCustodyReservation({...input, launchPlan: selected, workspaceAuthority}, {}, {
        platform: "darwin", containmentProfile: tuple.containmentProfile, residueAuthorityFactory,
      });
      const live = createLiveCustody(input, `underlying:${identity.custodyId}`, "a".repeat(64), launch.inputIdentity(input), {
        containmentProfile: tuple.containmentProfile, opening: Promise.resolve(), privateReservationPlan: bound.plan,
        retainedWorkspaceAuthority: bound.retainedWorkspaceAuthority, workspaceAuthority,
      });
      // A cooperative group observer is an explicit runtime dependency. It grants
      // no physical closure and is never invoked by these pre-execution tests.
      await openHostCustodyReservation({input, live, launchPlans: bound.launchPlans, containmentAfterMs: 100,
        expectedContainmentProfile: tuple.containmentProfile, requiredSpawnMode: "sdk-delegated", opening: live.opening,
        resolveOpening: undefined, rejectOpening: undefined, removeUnfingerprintedReservation: forbidden,
        residueAuthorityFactory: {create: async () => ({attachGuardian: async () => false, close: async () => false,
          killAll: async () => false, proveEmpty: async () => "unproven" as const})},
        contain: async () => {throw new Error("unexpected containment experiment");}, spawn: forbidden,
      });
      const controller = new AbortController();
      const handoff = readNodeCustodyHttpHandoff({underlyingCustodyRef: live.custodyRef, signal: controller.signal,
        committedDispatchProof: committedDispatchProofFixture(kernelInput, {hostBootId: "host-boot:synthetic",
          hostInstanceId: "host-instance:synthetic", hostCustodyProof: {proofId: "proof:synthetic"}} as never)});
      const lifetime = live.httpReservation.acquire(live, handoff);
      return {live, lifetime, controller, close() {
        live.httpReservation.cutoff(); live.launchAuthority?.close(); bound.retainedWorkspaceAuthority.close();
        // This in-memory fixture owns teardown, including the independently
        // retained root handle. Closing it is not a product release or deletion.
        live.privateRootCleanupAuthority?.close();
        return nativeFiles?.cleanup();
      }, bind() {return live.launchBinding.bind(live, lifetime);}};
    },
  };
};

export const sessionDependencies = (f: Awaited<ReturnType<ReturnType<typeof fixture>["reserve"]>>) => {
  const egress = createEgressFixture(); const proof = f.lifetime.committedDispatchProof;
  return {...egress.ports, identity: {operationId: proof.operationId, attemptId: proof.attemptId,
    custodyId: proof.custodyId, hostBootId: proof.hostBootId, liveProcessSessionIdentity: f.lifetime.executionSessionIdentity},
    providerAccessSnapshot: {...egress.ports.providerAccessSnapshot, ...access("codex")}};
};

/** In-memory OS observations for the actual embedded guardian VM. */
export const syntheticNodeModule = (name: string) => {
  const value = modules.get(name); assert.ok(value, name); return value;
};
