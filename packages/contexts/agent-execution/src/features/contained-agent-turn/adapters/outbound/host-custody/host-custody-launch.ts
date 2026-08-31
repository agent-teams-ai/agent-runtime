import { createHash } from "node:crypto";
import {
  lstat,
  realpath,
} from "node:fs/promises";
import { readFileSync, statSync, type BigIntStats } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve as resolvePath,
} from "node:path";

import { openStablePath } from "@agent-teams/filesystem-custody";

import {
  HostCustodyFingerprintConflictError,
  HostCustodyUnsupportedError,
  type HostCustodyLaunchFingerprintEvidence,
  type HostCustodyLaunchPlan,
  type HostCustodyLaunchPlanResolver,
  type ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";

export interface ExecutableObservation {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly digest: string;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

export interface WorkspaceObservation {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
}

export interface PrivatePathObservation extends WorkspaceObservation {
  readonly path: string;
}

export interface PrivateLaunchPathObservations {
  readonly byEnvironmentKey: Readonly<Record<string, PrivatePathObservation>>;
  readonly environmentKeys: readonly string[];
  readonly root: PrivatePathObservation;
}

interface FilesystemObjectIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface LaunchCandidate {
  readonly canonicalWorkspace: string;
  readonly fingerprint: HostCustodyLaunchFingerprintEvidence;
  readonly plan: HostCustodyLaunchPlan;
  readonly privatePaths: PrivateLaunchPathObservations;
  readonly workspace: WorkspaceObservation;
}

export interface VerifiedLaunchDescriptors {
  readonly executable: ExecutableObservation;
  readonly executableDescriptor: {
    readonly childDescriptor: number;
    readonly parentDescriptor: number;
  };
  readonly privatePathDescriptors: Readonly<Record<string, {
    readonly childDescriptor: number;
    readonly parentDescriptor: number;
  }>>;
  readonly workspaceDescriptor: {
    readonly childDescriptor: number;
    readonly parentDescriptor: number;
  };
  readonly privateRootDescriptor: {
    readonly childDescriptor: number;
    readonly parentDescriptor: number;
  };
  close(): void;
}

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {return value.map(canonicalValue);}
  if (value === null || typeof value !== "object") {return value;}
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .filter(key => record[key] !== undefined)
      .toSorted()
      .map(key => [key, canonicalValue(record[key])]),
  );
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

export const positiveInteger = (name: string, value: number | undefined, fallback: number): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return selected;
};

export const inputIdentity = (input: Parameters<ProviderProcessCustodyPort["open"]>[0]): string =>
  sha256(canonicalJson([
    input.operationId,
    input.attemptId,
    input.providerBinding,
    input.intentMode,
    input.workspaceRef,
  ]));

export const privateRootForWorkspace = (workspaceRef: string): string =>
  join(dirname(workspaceRef), `${basename(workspaceRef)}-host-private`);

export const assertDescriptorBoundLinuxProfile = (): void => {
  if (process.platform !== "linux") {
    throw new HostCustodyUnsupportedError("platform-profile-unavailable");
  }
  try {
    if (!statSync("/proc/self/fd").isDirectory() || readFileSync("/proc/self/stat").byteLength === 0) {
      throw new Error("procfs launch authority is unavailable");
    }
  } catch {
    throw new HostCustodyUnsupportedError("procfs-profile-unavailable");
  }
};

const exactStringRecord = (
  actual: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<string, string>>,
): actual is Readonly<Record<string, string>> => {
  const actualKeys = Object.keys(actual).toSorted();
  const expectedKeys = Object.keys(expected).toSorted();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) =>
    key === expectedKeys[index] && actual[key] !== undefined && actual[key] === expected[key]);
};

export const assertDelegatedStartFingerprint = (
  input: {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string | undefined;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
  plan: HostCustodyLaunchPlan,
): Readonly<Record<string, string>> => {
  if (input.command !== plan.executablePath || input.cwd !== "/proc/self/fd/4") {
    throw new HostCustodyFingerprintConflictError("Host Custody delegated command or workspace fingerprint conflict");
  }
  if (canonicalJson(input.arguments) !== canonicalJson(plan.arguments)) {
    throw new HostCustodyFingerprintConflictError("Host Custody delegated arguments fingerprint conflict");
  }
  if (!exactStringRecord(input.environment, plan.environment)) {
    throw new HostCustodyFingerprintConflictError("Host Custody delegated environment fingerprint conflict");
  }
  return input.environment;
};

const observationFromStats = (digest: string, stats: BigIntStats): ExecutableObservation => ({
  ctimeNs: stats.ctimeNs,
  dev: stats.dev,
  digest,
  ino: stats.ino,
  mode: stats.mode,
  mtimeNs: stats.mtimeNs,
  nlink: stats.nlink,
  size: stats.size,
});

const assertExecutableMode = (observation: BigIntStats): void => {
  if (
    !observation.isFile() ||
    observation.nlink !== 1n ||
    (observation.mode & 0o111n) === 0n ||
    (observation.mode & 0o022n) !== 0n
  ) {
    throw new Error("Host Custody executable must be a single-link, non-group/world-writable regular executable");
  }
};

export const assertCanonicalAncestors = async (path: string): Promise<void> => {
  if (!isAbsolute(path) || resolvePath(path) !== path) {
    throw new Error("Host Custody path must be a normalized absolute path");
  }
  const root = parse(path).root;
  const ancestors: string[] = [];
  for (let cursor = dirname(path);; cursor = dirname(cursor)) {
    ancestors.push(cursor);
    if (cursor === root) {break;}
  }
  for (const ancestor of ancestors.toReversed()) {
    const [canonical, observation] = await Promise.all([realpath(ancestor), lstat(ancestor, { bigint: true })]);
    if (canonical !== ancestor || !observation.isDirectory() || observation.isSymbolicLink()) {
      throw new Error("Host Custody path has a non-canonical or symbolic-link ancestor");
    }
  }
};

export const verifyExecutable = async (plan: HostCustodyLaunchPlan): Promise<ExecutableObservation> => {
  if (!isAbsolute(plan.executablePath) || resolvePath(plan.executablePath) !== plan.executablePath) {
    throw new Error("Host Custody executable must be a normalized absolute path");
  }
  const canonicalPath = await realpath(plan.executablePath);
  if (canonicalPath !== plan.executablePath) {
    throw new Error("Host Custody executable path must be canonical");
  }
  await assertCanonicalAncestors(canonicalPath);
  const pathStats = await lstat(canonicalPath, { bigint: true });
  assertExecutableMode(pathStats);
  return openStablePath(
    canonicalPath,
    canonicalPath,
    async opened => {
      assertExecutableMode(opened.stats);
      const digest = sha256(await opened.handle.readFile());
      if (digest !== plan.executableSha256) {
        throw new Error("Host Custody executable digest mismatch");
      }
      return observationFromStats(digest, opened.stats);
    },
  );
};

const assertPrivateDirectoryObservation = (observation: BigIntStats): void => {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (
    !observation.isDirectory() ||
    observation.isSymbolicLink() ||
    (observation.mode & 0o077n) !== 0n ||
    (uid !== undefined && observation.uid !== uid)
  ) {
    throw new Error("Host Custody requires an owner-private directory");
  }
};

const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

const allowedEnvironmentKeys = Object.freeze({
  claude: new Set([
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CONFIG_DIR",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
  ]),
  codex: new Set(["CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR"]),
} as const);

const declaredPrivateEnvironmentKeys = (plan: HostCustodyLaunchPlan): readonly string[] => {
  const declared = plan.privatePathEnvironmentKeys ?? [];
  if (new Set(declared).size !== declared.length) {
    throw new Error("Host Custody private environment keys must be unique");
  }
  if (declared.some(key => !allowedEnvironmentKeys[plan.provider].has(key))) {
    throw new Error("Host Custody private environment key is not allowlisted");
  }
  return Object.freeze([...declared].toSorted());
};

const privateEnvironmentKeys = (plan: HostCustodyLaunchPlan): readonly string[] => {
  const declared = declaredPrivateEnvironmentKeys(plan);
  const providerConfigKey = plan.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const keys = [...new Set(["HOME", "TMPDIR", providerConfigKey, ...declared])].toSorted();
  return Object.freeze(keys);
};

const assertAllowlistedEnvironment = (plan: HostCustodyLaunchPlan): void => {
  const keys = Object.keys(plan.environment);
  if (keys.length === 0 || keys.some(key => !allowedEnvironmentKeys[plan.provider].has(key))) {
    throw new Error("Host Custody environment contains an unclassified key");
  }
  for (const [key, value] of Object.entries(plan.environment)) {
    if (value.length === 0 || value.includes("\0") || !value.isWellFormed()) {
      throw new Error("Host Custody environment contains malformed bytes");
    }
    if (key === "LANG" && value !== "C.UTF-8") {
      throw new Error("Host Custody environment locale is not qualified");
    }
    if (key === "PATH") {
      const entries = value.split(":");
      if (entries.length === 0 || entries.some(entry => !isAbsolute(entry) || resolvePath(entry) !== entry)) {
        throw new Error("Host Custody environment PATH is not a closed absolute search path");
      }
    }
  }
};

const privatePathObservation = (path: string, observation: BigIntStats): PrivatePathObservation => Object.freeze({
  ctimeNs: observation.ctimeNs,
  dev: observation.dev,
  ino: observation.ino,
  mode: observation.mode,
  path,
  uid: observation.uid,
});

const sameFilesystemObject = (left: FilesystemObjectIdentity, right: FilesystemObjectIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export const isIntentionalCodexHomeAlias = (
  plan: HostCustodyLaunchPlan,
  leftKey: string,
  leftPath: string,
  rightKey: string,
  rightPath: string,
): boolean => plan.provider === "codex" &&
  [leftKey, rightKey].every(key => key === "CODEX_HOME" || key === "HOME") &&
  leftPath === rightPath;

const assertDistinctPrivateFilesystemObjects = (
  workspace: FilesystemObjectIdentity,
  root: FilesystemObjectIdentity,
  environmentPaths: Readonly<Record<string, FilesystemObjectIdentity>>,
): void => {
  const identities = [workspace, root, ...Object.values(environmentPaths)];
  if (identities.some((identity, index) => identities.some((other, otherIndex) =>
    index !== otherIndex && sameFilesystemObject(identity, other)))) {
    throw new Error("Host Custody private launch paths must identify distinct filesystem objects");
  }
};

const assertQualifiedPrivateFilesystemObjects = (
  plan: HostCustodyLaunchPlan,
  workspace: FilesystemObjectIdentity,
  root: FilesystemObjectIdentity,
  environmentPaths: Readonly<Record<string, PrivatePathObservation>>,
): void => {
  assertDistinctPrivateFilesystemObjects(workspace, root, {});
  for (const [key, observation] of Object.entries(environmentPaths)) {
    if (sameFilesystemObject(workspace, observation) || sameFilesystemObject(root, observation)) {
      throw new Error("Host Custody private launch paths must identify distinct filesystem objects");
    }
    for (const [otherKey, other] of Object.entries(environmentPaths)) {
      if (
        key < otherKey &&
        sameFilesystemObject(observation, other) &&
        !isIntentionalCodexHomeAlias(plan, key, observation.path, otherKey, other.path)
      ) {
        throw new Error("Host Custody private launch paths must identify distinct filesystem objects");
      }
    }
  }
};

// oxlint-disable-next-line complexity -- exact path, ancestry, inode, and qualified-alias guards remain one verification.
export const verifyPrivateLaunchPaths = async (
  plan: HostCustodyLaunchPlan,
  workspaceRef: string,
  workspaceStats: BigIntStats,
): Promise<PrivateLaunchPathObservations> => {
  assertPrivateDirectoryObservation(workspaceStats);
  assertAllowlistedEnvironment(plan);
  const expectedPrivateRoot = privateRootForWorkspace(workspaceRef);
  if (
    plan.privateRootPath !== expectedPrivateRoot ||
    !isAbsolute(plan.privateRootPath) ||
    resolvePath(plan.privateRootPath) !== plan.privateRootPath ||
    isWithin(plan.privateRootPath, workspaceRef) ||
    isWithin(workspaceRef, plan.privateRootPath)
  ) {
    throw new Error("Host Custody private root is not the operation-scoped workspace sibling");
  }
  await assertCanonicalAncestors(plan.privateRootPath);
  const canonicalRoot = await realpath(plan.privateRootPath);
  const rootObservation = await lstat(canonicalRoot, { bigint: true });
  if (canonicalRoot !== plan.privateRootPath) {
    throw new Error("Host Custody private root is not canonical");
  }
  assertPrivateDirectoryObservation(rootObservation);
  if (rootObservation.dev !== workspaceStats.dev || rootObservation.uid !== workspaceStats.uid) {
    throw new Error("Host Custody private root is outside workspace filesystem custody");
  }
  const keys = privateEnvironmentKeys(plan);
  const observations: Record<string, PrivatePathObservation> = {};
  for (const key of keys) {
    const value = plan.environment[key];
    if (
      value === undefined ||
      !isAbsolute(value) ||
      resolvePath(value) !== value ||
      value === plan.privateRootPath ||
      !isWithin(value, plan.privateRootPath)
    ) {
      throw new Error("Host Custody private environment path is absent or escapes private custody");
    }
    await assertCanonicalAncestors(value);
    const canonical = await realpath(value);
    const observation = await lstat(canonical, { bigint: true });
    if (canonical !== value) {throw new Error("Host Custody private environment path is not canonical");}
    assertPrivateDirectoryObservation(observation);
    if (observation.dev !== rootObservation.dev || observation.uid !== rootObservation.uid) {
      throw new Error("Host Custody private environment path is outside private-root custody");
    }
    observations[key] = privatePathObservation(value, observation);
  }
  for (const [key, observation] of Object.entries(observations)) {
    for (const [otherKey, other] of Object.entries(observations)) {
      if (
        key < otherKey &&
        (isWithin(observation.path, other.path) || isWithin(other.path, observation.path)) &&
        !isIntentionalCodexHomeAlias(plan, key, observation.path, otherKey, other.path)
      ) {
        throw new Error("Host Custody private environment paths must be pairwise disjoint");
      }
    }
  }
  assertQualifiedPrivateFilesystemObjects(plan, workspaceStats, rootObservation, observations);
  return Object.freeze({
    byEnvironmentKey: Object.freeze(observations),
    environmentKeys: keys,
    root: privatePathObservation(plan.privateRootPath, rootObservation),
  });
};

export const hostCustodyLaunchTestSupport = Object.freeze({
  assertDistinctPrivateFilesystemObjects,
  assertQualifiedPrivateFilesystemObjects,
});

export const createFingerprint = (
  input: Parameters<ProviderProcessCustodyPort["open"]>[0],
  plan: HostCustodyLaunchPlan,
  canonicalWorkspace: string,
  arguments_: readonly string[],
): HostCustodyLaunchFingerprintEvidence => {
  const environmentKeys = Object.keys(plan.environment).toSorted();
  const effectivePrivateEnvironmentKeys = privateEnvironmentKeys(plan);
  const privatePathEnvironmentKeys = declaredPrivateEnvironmentKeys(plan);
  const privateKeySet = new Set(effectivePrivateEnvironmentKeys);
  const environmentAuthority = environmentKeys.map(key => [
    key,
    privateKeySet.has(key)
      ? `private-root-relative:${relative(plan.privateRootPath, plan.environment[key] ?? "")}`
      : plan.environment[key],
  ]);
  const argumentsSha256 = sha256(canonicalJson(arguments_));
  const planIdentity = [
    input.providerBinding,
    input.intentMode,
    plan.provider,
    plan.binaryRevision,
    plan.executablePath,
    plan.executableSha256,
    sha256(canonicalWorkspace),
    argumentsSha256,
    environmentAuthority,
    privatePathEnvironmentKeys,
    sha256(plan.privateRootPath),
    plan.intentMode,
    plan.spawnMode ?? "eager",
    plan.containmentProfile,
  ] as const;
  const planSha256 = sha256(canonicalJson(planIdentity));
  return Object.freeze({
    argumentsSha256,
    binaryRevision: plan.binaryRevision,
    containmentProfile: plan.containmentProfile,
    environmentKeys: Object.freeze(environmentKeys),
    executablePathSha256: sha256(plan.executablePath),
    executableSha256: plan.executableSha256,
    fingerprintSha256: planSha256,
    intentMode: input.intentMode,
    planSha256,
    privatePathEnvironmentKeys,
    privateRootPathSha256: sha256(plan.privateRootPath),
    providerBindingSha256: sha256(canonicalJson(input.providerBinding)),
    spawnMode: plan.spawnMode ?? "eager",
    workspaceSha256: sha256(canonicalWorkspace),
  });
};

export const resolveLaunchCandidate = async (
  launchPlans: HostCustodyLaunchPlanResolver,
  input: Parameters<ProviderProcessCustodyPort["open"]>[0],
): Promise<LaunchCandidate> => {
  const intentMode = input.intentMode;
  if (!isAbsolute(input.workspaceRef) || resolvePath(input.workspaceRef) !== input.workspaceRef) {
    throw new Error("Host Custody workspace must be a normalized absolute path");
  }
  const plan = await launchPlans.resolve({
    intentMode,
    providerBinding: input.providerBinding,
    workspaceRef: input.workspaceRef,
  });
  if (plan === undefined) {throw new HostCustodyUnsupportedError("launch-plan-unavailable");}
  if (
    plan.provider !== input.providerBinding.provider ||
    plan.binaryRevision !== input.providerBinding.binaryRevision ||
    plan.intentMode !== intentMode
  ) {
    throw new Error("Host Custody launch plan does not match the provider binding");
  }
  const [canonicalWorkspace, workspaceStats] = await Promise.all([
    realpath(input.workspaceRef),
    lstat(input.workspaceRef, { bigint: true }),
    assertCanonicalAncestors(input.workspaceRef),
  ]);
  if (canonicalWorkspace !== input.workspaceRef || !workspaceStats.isDirectory()) {
    throw new Error("Host Custody workspace must be a canonical directory");
  }
  const privatePaths = await verifyPrivateLaunchPaths(plan, input.workspaceRef, workspaceStats);
  return Object.freeze({
    canonicalWorkspace,
    fingerprint: createFingerprint({ ...input, intentMode }, plan, canonicalWorkspace, plan.arguments),
    plan: Object.freeze({
      ...plan,
      arguments: Object.freeze([...plan.arguments]),
      environment: Object.freeze({ ...plan.environment }),
      privateRootPath: plan.privateRootPath,
      ...(plan.privatePathEnvironmentKeys === undefined ? {} : {
        privatePathEnvironmentKeys: Object.freeze([...plan.privatePathEnvironmentKeys]),
      }),
    }),
    privatePaths,
    workspace: Object.freeze({
      ctimeNs: workspaceStats.ctimeNs,
      dev: workspaceStats.dev,
      ino: workspaceStats.ino,
      mode: workspaceStats.mode,
      uid: workspaceStats.uid,
    }),
  });
};
