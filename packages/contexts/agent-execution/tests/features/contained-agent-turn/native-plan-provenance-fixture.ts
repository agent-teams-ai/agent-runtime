import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { after } from "node:test";

// Read only the pinned catalog and these exact source files for import-direction
// assertions. Product filesystem imports are replaced before any product import.
const catalog = readFileSync(new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
const protocolHeaderUrl = new URL("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h", import.meta.url);
const protocolHeader = readFileSync(protocolHeaderUrl);
const sourceRoot = new URL("../../../src/features/contained-agent-turn/adapters/outbound/", import.meta.url);
export const boundarySources = Object.freeze({
  codex: readFileSync(new URL("codex-app-server/codex-app-server-launch-plan.ts", sourceRoot), "utf8"),
  hostEntrypoint: readFileSync(new URL("host-custody/custodied-provider-process.ts", sourceRoot), "utf8"),
  hostSnapshot: readFileSync(new URL("host-custody/host-custody-launch-plan-snapshot.ts", sourceRoot), "utf8"),
});
const modules = new Map<string, Record<string, unknown>>();
const slot = Symbol.for("ar69-r197-native-plan-provenance-fixture");
Reflect.set(globalThis, slot, modules);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return modules.has(specifier) ? { url: `native-plan-fixture:${specifier}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("native-plan-fixture:")) {return next(url, context);}
    const name = url.slice("native-plan-fixture:".length);
    const source = `const data = globalThis[Symbol.for(${JSON.stringify(slot.description)})].get(${JSON.stringify(name)});\n`
      + Object.keys(modules.get(name)!).map(key => key === "default" ? "export default data.default;" : `export const ${key} = data.${key};`).join("\n");
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
const stats = (path: string, options?: { bigint?: boolean }) => {
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
  // Import closure includes durable storage; these fixtures never perform writes.
  writeFileSync: () => {throw new Error("synthetic filesystem write forbidden");},
  renameSync: () => {throw new Error("real rename forbidden");},
  rmdirSync: () => {throw new Error("real removal forbidden");},
  rmSync: () => {throw new Error("real removal forbidden");},
  readlinkSync: () => {throw new Error("real readlink forbidden");},
  fchmodSync: () => {throw new Error("synthetic filesystem chmod forbidden");},
  unlinkSync: () => {throw new Error("synthetic filesystem unlink forbidden");},
  fsyncSync: () => {throw new Error("synthetic filesystem sync forbidden");},
  writeSync: () => {throw new Error("synthetic filesystem write forbidden");},
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
  readFileSync: (path: string | number | URL, encoding?: string) => {
    if (!(path instanceof URL) || path.href !== protocolHeaderUrl.href) {throw new Error("unexpected product sync read");}
    return encoding === "utf8" ? protocolHeader.toString("utf8") : Buffer.from(protocolHeader);
  },
});
modules.get("node:fs")!.default = modules.get("node:fs")!;
modules.set("node:fs/promises", {
  readFile: async () => {throw new Error("real process/config reads forbidden");},
  readdir: async () => {throw new Error("filesystem access forbidden");},
  readlink: async () => {throw new Error("filesystem access forbidden");},
  stat: async (path: string, options: {bigint?: boolean}) => stats(path, options),
  open: async () => {throw new Error("filesystem access forbidden");},
  lstat: async (path: string, options: { bigint?: boolean }) => stats(path, options),
  realpath: async (path: string) => canonical(path),
});
modules.set("@agent-teams/filesystem-custody", {
  withStableDirectoryProcessLock: async () => {throw new Error("filesystem lock forbidden");},
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

export const host = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js");
export const snapshots = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch-plan-snapshot.js");
export const issuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js");
const boundaryIssuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js");
export const recipes = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js");
const fileIssuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js");
export const reservation = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.js");
export const resolver = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js");
export const launch = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js");

const directory = (path: string) => {
  if (entries.has(path)) {return;}
  if (path !== "/") {directory(dirname(path));}
  entries.set(path, { ino: nextInode++, mode: 0o40700, directory: true, bytes: Buffer.alloc(0), revision: 1 });
};
const file = (path: string, bytes: Buffer) => {
  entries.set(path, { ino: nextInode++, mode: 0o100600, directory: false, bytes, revision: 1 });
};
export const capability = "a1".repeat(32);
export const fixture = async (native = true, intentMode: "analysis" | "workspace-write" = "analysis") => {
  const root = `/tmp/ar69-r197-native-plan-provenance-memory-${sequence++}`;
  const workspaceRef = `${root}/workspace`;
  const privateRootPath = `${workspaceRef}-host-private`;
  const codexHome = `${privateRootPath}/home`;
  const tmpDir = `${privateRootPath}/tmp`;
  for (const path of [workspaceRef, codexHome, tmpDir]) {directory(path);}
  const boundary = boundaryIssuer.createCodexAppServerPermissionBoundary({ codexHome, workspaceRef, intentMode });
  const recipe = recipes.createCodexNativeBrokerRecipe({
    boundary, endpoint: "http://10.203.0.1:43129/backend-api/codex", profile: "codex-chatgpt",
  });
  file(`${codexHome}/config.toml`, Buffer.from(recipes.renderCodexNativeBrokerConfig(recipe)));
  file(recipe.catalogPath, catalog);
  const files = await fileIssuer.prepareCodexNativeBrokerFiles(recipe);
  const options = {
    boundary, executablePath: `${root}/codex`, intentMode, privateRootPath, tmpDir,
    platformTarget: { architecture: "x64", platform: "linux" } as const,
  };
  const plan = issuer.createCodexAppServerLaunchPlan({ ...options,
    ...(native ? { nativeBroker: { recipe, files, localCapability: capability } } : {}),
  });
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
  return { boundary, recipe, files, options, plan, input, workspaceAuthority,
    addDirectory: directory,
    mutate(path: string, changes: Partial<ReturnType<typeof entry>>) {Object.assign(entry(path), changes);},
    descriptorCount: () => descriptors.size,
  };
};

export const reserve = (f: Awaited<ReturnType<typeof fixture>>, plan = f.plan) =>
  reservation.bindPrivateHostCustodyReservation({ ...f.input, launchPlan: plan, workspaceAuthority: f.workspaceAuthority }, {}, {
    containmentProfile: "strict-linux-cgroup-v2",
  } as Parameters<typeof reservation.bindPrivateHostCustodyReservation>[2]);
