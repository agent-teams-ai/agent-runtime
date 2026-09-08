import { createHash } from "node:crypto";
import { types } from "node:util";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { createImmutableHostCustodyLaunchPlan, createFinalizableHostCustodyLaunchPlan, type HostCustodyLaunchPlan } from "../host-custody/custodied-provider-process.js";
import {
  CODEX_PERMISSION_PROFILE_ID,
  validateCodexDirectoryIdentity,
  type CodexAppServerPermissionBoundary,
  type CodexDirectoryIdentity,
} from "./codex-app-server-permission-boundary.js";
import {
  codexAppServerTupleForBinaryRevision,
  selectCodexAppServerPlatformTuple,
  type CodexAppServerPlatformTarget,
} from "./codex-app-server-platform-tuple.js";

import { DISABLED_CODEX_FEATURES } from "./codex-app-server-config-defaults.js";

import {
  assertCodexNativeBrokerBoundary, CODEX_LOCAL_BROKER_CAPABILITY_ENV,
  CODEX_NATIVE_BROKER_DISABLED_FEATURES, renderCodexNativeBrokerConfig, snapshotCodexNativeInput,
  type CodexNativeBrokerRecipe,
} from "./codex-native-broker-recipe.js";
import { validateCodexNativeBrokerFiles, type CodexNativeBrokerFiles } from "./codex-native-broker-files.js";

interface NativeBrokerLaunchInput {
  readonly recipe: CodexNativeBrokerRecipe;
  readonly files: CodexNativeBrokerFiles;
  readonly localCapability: string;
}
const nativeLaunches = new WeakMap<HostCustodyLaunchPlan, Readonly<NativeBrokerLaunchInput>>();
const issuedLaunchPlans = new WeakSet<object>();

/** Same-object native protocol selection; the provider rechecks retained material. */
export const isCodexNativeBrokerLaunchPlan = (plan: HostCustodyLaunchPlan): boolean => nativeLaunches.has(plan);

/** Private adapter recognition, not route authority. Only this factory can add
 * an immutable plan; callers cannot register or transfer recognition to copies.
 */
export const isIssuedCodexAppServerLaunchPlan = (plan: unknown): plan is CodexAppServerLaunchPlan =>
  typeof plan === "object" && plan !== null && issuedLaunchPlans.has(plan);

/** Same-object provenance; a cloned plan or Proxy can never recover this mode. */
export const codexNativeBrokerLaunchInput = (plan: HostCustodyLaunchPlan): Readonly<NativeBrokerLaunchInput> => {
  const native = nativeLaunches.get(plan);
  if (native === undefined) {throw new TypeError("Codex native broker launch rejected");}
  return native;
};

const nativeLaunchInput = (options: CodexAppServerLaunchPlanOptions): Readonly<NativeBrokerLaunchInput> | undefined => {
  if (options.nativeBroker === undefined) {return undefined;}
  const data = snapshotCodexNativeInput(options.nativeBroker, ["recipe", "files", "localCapability"]);
  const recipe = data.recipe as CodexNativeBrokerRecipe;
  const files = data.files as CodexNativeBrokerFiles;
  assertCodexNativeBrokerBoundary(recipe, options.boundary);
  if (typeof data.localCapability !== "string" || data.localCapability.length < 32 || data.localCapability.length > 128
    || /[^A-Za-z0-9_-]/u.test(data.localCapability)) {
    throw new TypeError("Codex native broker capability rejected");
  }
  validateCodexNativeBrokerFiles(files, recipe);
  return Object.freeze({ recipe, files, localCapability: data.localCapability });
};

export interface CodexAppServerLaunchPlanOptions {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly nativeBroker?: NativeBrokerLaunchInput;
  readonly executablePath: string;
  readonly intentMode: "analysis" | "workspace-write";
  readonly platformTarget: CodexAppServerPlatformTarget;
  readonly privateRootPath: string;
  readonly tmpDir: string;
}

export interface CodexAppServerLaunchPlan extends HostCustodyLaunchPlan {
  readonly codexHome: string;
  readonly codexHomeIdentity: CodexDirectoryIdentity;
  readonly effectivePolicyDigest: string;
  readonly permissionProfileId: typeof CODEX_PERMISSION_PROFILE_ID;
  readonly tmpDir: string;
  readonly tmpDirIdentity: CodexDirectoryIdentity;
  readonly workspaceRef: string;
  readonly workspaceIdentity: CodexDirectoryIdentity;
}

const contains = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const acceptedIntentMode = (value: unknown): "analysis" | "workspace-write" => {
  if (value !== "analysis" && value !== "workspace-write") {
    throw new TypeError("intentMode must be analysis or workspace-write");
  }
  return value;
};

const privateRoot = (value: unknown, workspaceRef: string): string => {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/") {
    throw new TypeError("privateRootPath must be a normalized absolute non-root path");
  }
  if (contains(value, workspaceRef) || contains(workspaceRef, value)) {
    throw new TypeError("privateRootPath and workspaceRef must be disjoint");
  }
  return value;
};

const privateTmpIdentity = (value: string): CodexDirectoryIdentity => {
  if (!isAbsolute(value) || resolve(value) !== value || value === "/") {
    throw new TypeError("tmpDir must be a normalized absolute non-root path");
  }
  const link = lstatSync(value);
  if (!link.isDirectory() || link.isSymbolicLink() || realpathSync(value) !== value) {
    throw new TypeError("tmpDir must be a canonical non-symlink directory");
  }
  const directory = statSync(value);
  if (typeof process.getuid !== "function" || directory.uid !== process.getuid()
    || (directory.mode & 0o077) !== 0) {
    throw new TypeError("tmpDir must be current-user-owned with mode 0700 or more restrictive");
  }
  return Object.freeze({ device: directory.dev, inode: directory.ino, path: value });
};

const isDirectoryIdentity = (value: unknown): value is CodexDirectoryIdentity => {
  try {
    const data = snapshotCodexNativeInput(value, ["device", "inode", "path"]);
    return typeof data.device === "number" && typeof data.inode === "number" && typeof data.path === "string";
  } catch {return false;}
};

const snapshotDirectoryIdentity = (value: CodexDirectoryIdentity): CodexDirectoryIdentity => {
  const data = snapshotCodexNativeInput(value, ["device", "inode", "path"]);
  if (typeof data.device !== "number" || typeof data.inode !== "number" || typeof data.path !== "string") {
    throw new TypeError("Codex launch directory identity must contain inert data");
  }
  return Object.freeze({ device: data.device, inode: data.inode, path: data.path });
};

const validateLaunchEnvironment = (plan: HostCustodyLaunchPlan): void => {
  const native = nativeLaunches.get(plan);
  if (native !== undefined) {validateCodexNativeBrokerFiles(native.files, native.recipe);}
  const roots = plan as CodexAppServerLaunchPlan;
  const exactEnvironment = {
    ...(native === undefined ? {} : { [CODEX_LOCAL_BROKER_CAPABILITY_ENV]: native.localCapability }),
    CODEX_HOME: roots.codexHome, HOME: roots.codexHome,
    LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: roots.tmpDir,
  };
  const environment = snapshotCodexNativeInput(plan.environment, Object.keys(exactEnvironment));
  if (Object.entries(exactEnvironment).some(([key, value]) => environment[key] !== value)) {
    throw new TypeError("exact Codex App Server launch environment does not match the validated roots");
  }
};

const assertInertLaunchPlan = (plan: HostCustodyLaunchPlan): void => {
  if (typeof plan !== "object" || plan === null || types.isProxy(plan)
    || Object.getPrototypeOf(plan) !== Object.prototype
    || Object.values(Object.getOwnPropertyDescriptors(plan)).some(d => !("value" in d))) {
    throw new TypeError("Codex launch plan must contain inert data");
  }
};

export const validateCodexAppServerLaunchPlanRoots = (
  plan: HostCustodyLaunchPlan,
): void => {
  assertInertLaunchPlan(plan);
  const platformTuple = codexAppServerTupleForBinaryRevision(plan.binaryRevision);
  if (plan.containmentProfile !== platformTuple.containmentProfile
    || plan.executableSha256 !== platformTuple.binarySha256) {
    throw new TypeError("exact Codex App Server launch plan has a tuple/profile mismatch");
  }
  if (!("codexHome" in plan) || typeof plan.codexHome !== "string"
    || !("tmpDir" in plan) || typeof plan.tmpDir !== "string"
    || !("workspaceRef" in plan) || typeof plan.workspaceRef !== "string"
    || !("codexHomeIdentity" in plan) || !isDirectoryIdentity(plan.codexHomeIdentity)
    || !("tmpDirIdentity" in plan) || !isDirectoryIdentity(plan.tmpDirIdentity)
    || !("workspaceIdentity" in plan) || !isDirectoryIdentity(plan.workspaceIdentity)
    || plan.codexHomeIdentity.path !== plan.codexHome
    || plan.tmpDirIdentity.path !== plan.tmpDir
    || plan.workspaceIdentity.path !== plan.workspaceRef) {
    throw new TypeError("exact Codex App Server launch plan is missing canonical root identities");
  }
  validateCodexDirectoryIdentity("codexHome", plan.codexHomeIdentity);
  validateCodexDirectoryIdentity("tmpDir", plan.tmpDirIdentity);
  validateCodexDirectoryIdentity("workspaceRef", plan.workspaceIdentity, false);
  validateLaunchEnvironment(plan);
};

export const createCodexAppServerLaunchPlan = (
  options: CodexAppServerLaunchPlanOptions,
): CodexAppServerLaunchPlan => {
  options = snapshotCodexNativeInput(options, [
    "boundary", "executablePath", "intentMode", "platformTarget", "privateRootPath", "tmpDir",
  ], ["nativeBroker"]) as unknown as CodexAppServerLaunchPlanOptions;
  const platformTarget = snapshotCodexNativeInput(options.platformTarget, ["architecture", "platform"]);
  const platformTuple = selectCodexAppServerPlatformTuple(platformTarget as unknown as CodexAppServerPlatformTarget);
  const native = nativeLaunchInput(options);
  // Both selected 0.153.4 tuples use the captured native config. Darwin keeps
  // canonical paths and cooperative custody; Host selects its execution material.
  const intentMode = acceptedIntentMode(options.intentMode);
  const boundary = snapshotCodexNativeInput(options.boundary, [
    "codexHome", "codexHomeIdentity", "effectivePolicyDigest", "permissionProfile",
    "permissionProfileId", "intentMode", "workspaceRef", "workspaceIdentity",
  ]) as unknown as CodexAppServerPermissionBoundary;
  if (typeof options.executablePath !== "string" || typeof boundary.codexHome !== "string"
    || typeof boundary.workspaceRef !== "string" || typeof boundary.effectivePolicyDigest !== "string") {
    throw new TypeError("Codex launch roots and executable must contain inert data");
  }
  const codexHomeIdentity = snapshotDirectoryIdentity(boundary.codexHomeIdentity);
  const workspaceIdentity = snapshotDirectoryIdentity(boundary.workspaceIdentity);
  if (boundary.intentMode !== intentMode) {
    throw new TypeError("Codex launch intent mode does not match the permission boundary");
  }
  validateCodexDirectoryIdentity("codexHome", codexHomeIdentity);
  validateCodexDirectoryIdentity("workspaceRef", workspaceIdentity, false);
  const tmpDirIdentity = privateTmpIdentity(options.tmpDir);
  const privateRootPath = privateRoot(options.privateRootPath, boundary.workspaceRef);
  if (
    !contains(privateRootPath, boundary.codexHome)
    || privateRootPath === boundary.codexHome
    || !contains(privateRootPath, options.tmpDir)
    || privateRootPath === options.tmpDir
  ) {
    throw new TypeError("Codex private home and TMPDIR must be strictly within privateRootPath");
  }
  const roots = [boundary.workspaceRef, boundary.codexHome, options.tmpDir] as const;
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (contains(roots[left]!, roots[right]!) || contains(roots[right]!, roots[left]!)) {
        throw new TypeError("Codex workspace, private home, and TMPDIR must be pairwise disjoint");
      }
    }
  }
  const launchArguments = [
    "app-server",
    "--stdio",
    "--strict-config",
    "-c",
    `default_permissions=${JSON.stringify(CODEX_PERMISSION_PROFILE_ID)}`,
  ];
  for (const feature of native === undefined ? DISABLED_CODEX_FEATURES : CODEX_NATIVE_BROKER_DISABLED_FEATURES) {launchArguments.push("--disable", feature);}
  const plan = createImmutableHostCustodyLaunchPlan<CodexAppServerLaunchPlan>({
    arguments: launchArguments,
    binaryRevision: platformTuple.binaryRevision,
    codexHome: boundary.codexHome,
    codexHomeIdentity,
    containmentProfile: platformTuple.containmentProfile,
    effectivePolicyDigest: boundary.effectivePolicyDigest,
    environment: {
      ...(native === undefined ? {} : { [CODEX_LOCAL_BROKER_CAPABILITY_ENV]: native.localCapability }),
      CODEX_HOME: boundary.codexHome,
      HOME: boundary.codexHome,
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: options.tmpDir,
    },
    executablePath: options.executablePath,
    executableSha256: platformTuple.binarySha256,
    intentMode,
    permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
    privateRootPath,
    provider: "codex" as const,
    spawnMode: "sdk-delegated" as const,
    tmpDir: options.tmpDir,
    tmpDirIdentity,
    workspaceRef: boundary.workspaceRef,
    workspaceIdentity,
  });
  if (native !== undefined) {nativeLaunches.set(plan, native);}
  issuedLaunchPlans.add(plan);
  return plan;
};

/** Selected by the current owner before reservation when post-claim native
 * preparation is required. Captures original inputs; no later replacement
 * options or caller-provided capability/digest can complete this plan.
 */
export const createCodexAppServerFinalizableLaunchPlan = (
  input: Omit<CodexAppServerLaunchPlanOptions, "nativeBroker">,
  providerAccess: Readonly<{provider: string; providerRouteRef: string; credentialGeneration: number;
    credentialBindingRef: string; ownerAuthorityDigest: string}>,
): CodexAppServerLaunchPlan => {
  const options = snapshotCodexNativeInput(input, [
    "boundary", "executablePath", "intentMode", "platformTarget", "privateRootPath", "tmpDir",
  ]) as unknown as Omit<CodexAppServerLaunchPlanOptions, "nativeBroker">;
  const target = snapshotCodexNativeInput(options.platformTarget, ["architecture", "platform"]);
  const captured = Object.freeze({...options, platformTarget: Object.freeze(target) as unknown as CodexAppServerPlatformTarget});
  const base = createCodexAppServerLaunchPlan(captured);
  const plan = createFinalizableHostCustodyLaunchPlan<CodexAppServerLaunchPlan>(base, {
    providerAccess,
    build(material, localCapability) {
      const data = snapshotCodexNativeInput(material, ["recipe", "files"]);
      const recipe = data.recipe as CodexNativeBrokerRecipe;
      const files = data.files as CodexNativeBrokerFiles;
      // WeakMap lookups precede all material property reads (including proxies).
      assertCodexNativeBrokerBoundary(recipe, captured.boundary);
      validateCodexNativeBrokerFiles(files, recipe);
      validateCodexAppServerLaunchPlanRoots(base);
      const final = createCodexAppServerLaunchPlan({...captured, nativeBroker: {recipe, files, localCapability}});
      const materialSha256 = createHash("sha256").update(JSON.stringify([
        recipe.kind, recipe.profile, recipe.endpoint, renderCodexNativeBrokerConfig(recipe), recipe.catalogSha256,
        recipe.catalogPath, final.workspaceRef, final.codexHome, final.tmpDir, final.executablePath,
        final.containmentProfile,
      ])).digest("hex");
      return Object.freeze({plan: final, materialSha256,
        validate: () => validateCodexAppServerLaunchPlanRoots(final)});
    },
  });
  issuedLaunchPlans.add(plan);
  return plan;
};
export {codexNativeBrokerDockerPaths, snapshotCodexDataRecord} from "./codex-native-broker-recipe.js";

export {renderCodexNativeBrokerConfig} from "./codex-native-broker-recipe.js";

export {createCodexNativeBrokerRecipe, type CodexNativeBrokerRecipe} from "./codex-native-broker-recipe.js";
export {prepareCodexNativeBrokerFiles} from "./codex-native-broker-files.js";

export {codexNativeBrokerBoundary,
  CODEX_NATIVE_CATALOG_BYTES, CODEX_NATIVE_CATALOG_SHA256} from "./codex-native-broker-recipe.js";
