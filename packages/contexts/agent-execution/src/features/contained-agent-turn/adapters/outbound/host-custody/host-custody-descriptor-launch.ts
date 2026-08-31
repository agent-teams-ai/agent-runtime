import {
  closeSync,
  constants,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join, parse } from "node:path";

import type { HostCustodyLaunchPlan } from "./custodied-provider-process.js";
import {
  assertDescriptorBoundLinuxProfile,
  sha256,
  type ExecutableObservation,
  type PrivateLaunchPathObservations,
  type VerifiedLaunchDescriptors,
  type WorkspaceObservation,
} from "./host-custody-launch.js";

const assertExecutableMode = (observation: BigIntStats): void => {
  if (!observation.isFile() || observation.nlink !== 1n ||
      (observation.mode & 0o111n) === 0n || (observation.mode & 0o022n) !== 0n) {
    throw new Error("Host Custody executable mode changed before spawn");
  }
};

const assertCanonicalAncestors = (path: string): void => {
  const root = parse(path).root;
  for (let cursor = dirname(path);; cursor = dirname(cursor)) {
    const observation = lstatSync(cursor, { bigint: true });
    if (realpathSync(cursor) !== cursor || !observation.isDirectory() || observation.isSymbolicLink()) {
      throw new Error("Host Custody path ancestor changed before spawn");
    }
    if (cursor === root) {break;}
  }
};

const executableObservation = (digest: string, observation: BigIntStats): ExecutableObservation => ({
  ctimeNs: observation.ctimeNs, dev: observation.dev, digest, ino: observation.ino,
  mode: observation.mode, mtimeNs: observation.mtimeNs, nlink: observation.nlink, size: observation.size,
});

const executableIdentityMatches = (actual: BigIntStats | ExecutableObservation, expected: ExecutableObservation): boolean =>
  actual.ctimeNs === expected.ctimeNs && actual.dev === expected.dev && actual.ino === expected.ino &&
  actual.mode === expected.mode && actual.mtimeNs === expected.mtimeNs && actual.nlink === expected.nlink &&
  actual.size === expected.size && (!("digest" in actual) || actual.digest === expected.digest);

const verifyExecutableImmediatelyBeforeSpawn = (
  plan: HostCustodyLaunchPlan,
  expected: ExecutableObservation,
): void => {
  if (realpathSync(plan.executablePath) !== plan.executablePath) {throw new Error("Host Custody executable path changed before spawn");}
  assertCanonicalAncestors(plan.executablePath);
  const before = lstatSync(plan.executablePath, { bigint: true });
  assertExecutableMode(before);
  const descriptor = openSync(plan.executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedBefore = fstatSync(descriptor, { bigint: true });
    assertExecutableMode(openedBefore);
    const digest = sha256(readFileSync(descriptor));
    const observations = [before, openedBefore, fstatSync(descriptor, { bigint: true }), lstatSync(plan.executablePath, { bigint: true })];
    if (observations.some(observation => !executableIdentityMatches(executableObservation(digest, observation), expected))) {
      throw new Error("Host Custody executable identity changed before spawn");
    }
  } finally {closeSync(descriptor);}
};

const verifyDirectoryImmediatelyBeforeSpawn = (path: string, expected: WorkspaceObservation, label: string): void => {
  if (realpathSync(path) !== path) {throw new Error(`Host Custody ${label} path changed before spawn`);}
  assertCanonicalAncestors(path);
  const observation = lstatSync(path, { bigint: true });
  const matches = label === "private root"
    ? directoryObjectMatches(observation, expected)
    : directoryIdentityMatches(observation, expected);
  if (!matches || observation.isSymbolicLink()) {
    throw new Error(`Host Custody ${label} identity changed before spawn`);
  }
};

const directoryIdentityMatches = (actual: BigIntStats, expected: WorkspaceObservation): boolean =>
  actual.isDirectory() &&
  actual.ctimeNs === expected.ctimeNs &&
  actual.dev === expected.dev &&
  actual.ino === expected.ino &&
  actual.mode === expected.mode &&
  actual.uid === expected.uid;

const directoryObjectMatches = (actual: BigIntStats, expected: WorkspaceObservation): boolean =>
  actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino &&
  actual.mode === expected.mode && actual.uid === expected.uid;

const closeOptionalDescriptor = (descriptor: number | undefined): void => {
  if (descriptor !== undefined) {closeSync(descriptor);}
};

interface FilesystemObjectIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const sameFilesystemObject = (left: FilesystemObjectIdentity, right: FilesystemObjectIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

interface SealDescriptorOperations {
  chmod(descriptor: number, mode: number): void;
  close(descriptor: number): void;
  fstat(descriptor: number): BigIntStats;
  lstat(path: string): BigIntStats;
  open(path: string, flags: number, mode?: number): number;
  read(descriptor: number): Uint8Array;
  sync(descriptor: number): void;
  unlink(path: string): void;
  write(descriptor: number, data: Uint8Array): void;
}

const sealDescriptorOperations: SealDescriptorOperations = Object.freeze({
  chmod: fchmodSync,
  close: closeSync,
  fstat: (descriptor: number) => fstatSync(descriptor, { bigint: true }),
  lstat: (path: string) => lstatSync(path, { bigint: true }),
  open: openSync,
  read: (descriptor: number) => readFileSync(descriptor),
  sync: fsyncSync,
  unlink: unlinkSync,
  write: writeFileSync,
});

const unlinkSealedPathIfOwned = (
  sealedPath: string,
  createdIdentity: FilesystemObjectIdentity | undefined,
  operations: SealDescriptorOperations,
): boolean => {
  if (createdIdentity === undefined) {return false;}
  try {
    const namedIdentity = operations.lstat(sealedPath);
    if (!sameFilesystemObject(namedIdentity, createdIdentity)) {return false;}
    operations.unlink(sealedPath);
    return true;
  } catch {return false;}
};

interface PrivateLaunchDescriptor {
  readonly childDescriptor: number;
  readonly key: string;
  readonly parentDescriptor: number;
}

const sealExecutableDescriptor = (
  executable: ExecutableObservation,
  sourceDescriptor: number,
  sealedPath: string,
  operations: SealDescriptorOperations = sealDescriptorOperations,
): { readonly descriptor: number; readonly observation: ExecutableObservation } => {
  let writableDescriptor: number | undefined;
  let descriptor: number | undefined;
  let createdIdentity: FilesystemObjectIdentity | undefined;
  try {
    writableDescriptor = operations.open(
      sealedPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o500,
    );
    const createdDescriptorIdentity = operations.fstat(writableDescriptor);
    const createdPathIdentity = operations.lstat(sealedPath);
    if (!sameFilesystemObject(createdDescriptorIdentity, createdPathIdentity)) {
      throw new Error("Host Custody sealed executable path identity changed during creation");
    }
    createdIdentity = Object.freeze({ dev: createdDescriptorIdentity.dev, ino: createdDescriptorIdentity.ino });
    operations.write(writableDescriptor, operations.read(sourceDescriptor));
    operations.chmod(writableDescriptor, 0o500);
    operations.sync(writableDescriptor);
    descriptor = operations.open(`/proc/self/fd/${writableDescriptor}`, constants.O_RDONLY);
    if (!unlinkSealedPathIfOwned(sealedPath, createdIdentity, operations)) {
      throw new Error("Host Custody sealed executable path identity changed before cleanup");
    }
    operations.close(writableDescriptor);
    writableDescriptor = undefined;
    const stats = operations.fstat(descriptor);
    const digest = sha256(operations.read(descriptor));
    if (digest !== executable.digest || stats.nlink !== 0n || (stats.mode & 0o222n) !== 0n) {
      throw new Error("Host Custody sealed executable identity is invalid");
    }
    return { descriptor, observation: executableObservation(digest, stats) };
  } catch (error) {
    if (descriptor !== undefined) {operations.close(descriptor);}
    if (writableDescriptor !== undefined) {operations.close(writableDescriptor);}
    unlinkSealedPathIfOwned(sealedPath, createdIdentity, operations);
    throw error;
  }
};

interface PrivateDescriptorOperations {
  close(descriptor: number): void;
  open(path: string, flags: number): number;
}

const privateDescriptorOperations: PrivateDescriptorOperations = Object.freeze({
  close: closeSync,
  open: openSync,
});

const openPrivateDescriptors = (
  privatePaths: PrivateLaunchPathObservations,
  operations: PrivateDescriptorOperations = privateDescriptorOperations,
): readonly PrivateLaunchDescriptor[] => {
  const descriptors: PrivateLaunchDescriptor[] = [];
  try {
    for (const [index, key] of privatePaths.environmentKeys.entries()) {
      const observation = privatePaths.byEnvironmentKey[key];
      if (observation === undefined) {throw new Error("Host Custody private descriptor observation is missing");}
      descriptors.push({
        childDescriptor: 6 + index,
        key,
        parentDescriptor: operations.open(
          observation.path,
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
        ),
      });
    }
    return descriptors;
  } catch (error) {
    for (const descriptor of descriptors) {
      try {operations.close(descriptor.parentDescriptor);} catch {}
    }
    throw error;
  }
};

const assertPrivateDescriptorIdentities = (
  descriptors: readonly PrivateLaunchDescriptor[],
  privatePaths: PrivateLaunchPathObservations,
): readonly BigIntStats[] => {
  const observations: BigIntStats[] = [];
  for (const descriptor of descriptors) {
    const expected = privatePaths.byEnvironmentKey[descriptor.key];
    const observed = fstatSync(descriptor.parentDescriptor, { bigint: true });
    const matches = expected?.path === privatePaths.root.path
      ? expected !== undefined && directoryObjectMatches(observed, expected)
      : expected !== undefined && directoryIdentityMatches(observed, expected);
    if (!matches) {throw new Error("Host Custody private path changed while acquiring launch authority");}
    observations.push(observed);
  }
  return observations;
};

const assertDistinctDescriptorObjects = (observations: readonly FilesystemObjectIdentity[]): void => {
  if (observations.some((identity, index) => observations.some((other, otherIndex) =>
    index !== otherIndex && sameFilesystemObject(identity, other)))) {
    throw new Error("Host Custody acquired launch descriptors must identify distinct filesystem objects");
  }
};

export const acquireVerifiedLaunchDescriptors = (
  plan: HostCustodyLaunchPlan,
  executable: ExecutableObservation,
  workspaceRef: string,
  workspace: WorkspaceObservation,
  privatePaths: PrivateLaunchPathObservations,
): VerifiedLaunchDescriptors => {
  assertDescriptorBoundLinuxProfile();
  verifyExecutableImmediatelyBeforeSpawn(plan, executable);
  verifyDirectoryImmediatelyBeforeSpawn(workspaceRef, workspace, "workspace");
  verifyDirectoryImmediatelyBeforeSpawn(privatePaths.root.path, privatePaths.root, "private root");
  for (const [key, observation] of Object.entries(privatePaths.byEnvironmentKey)) {
    verifyDirectoryImmediatelyBeforeSpawn(observation.path, observation, `private ${key}`);
  }
  const sourceDescriptor = openSync(plan.executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const sealedPath = join(privatePaths.root.path, `.host-executable-${sha256(`${process.pid}:${Date.now()}`)}`);
  let executableDescriptor: number | undefined;
  let sealedExecutable: ExecutableObservation | undefined;
  let workspaceDescriptor: number | undefined;
  let privateRootDescriptor: number | undefined;
  let privateDescriptors: readonly PrivateLaunchDescriptor[] = [];
  try {
    const sealed = sealExecutableDescriptor(executable, sourceDescriptor, sealedPath);
    executableDescriptor = sealed.descriptor;
    sealedExecutable = sealed.observation;
    workspaceDescriptor = openSync(workspaceRef, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    privateRootDescriptor = openSync(
      privatePaths.root.path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    privateDescriptors = openPrivateDescriptors(privatePaths);
    if (!executableIdentityMatches(fstatSync(sourceDescriptor, { bigint: true }), executable)) {
      throw new Error("Host Custody executable identity changed while acquiring launch authority");
    }
    const acquiredWorkspace = fstatSync(workspaceDescriptor, { bigint: true });
    if (!directoryIdentityMatches(acquiredWorkspace, workspace)) {
      throw new Error("Host Custody workspace identity changed while acquiring launch authority");
    }
    const acquiredPrivateRoot = fstatSync(privateRootDescriptor, { bigint: true });
    if (!directoryObjectMatches(acquiredPrivateRoot, privatePaths.root)) {
      throw new Error("Host Custody private root changed while acquiring launch authority");
    }
    const acquiredPrivatePaths = assertPrivateDescriptorIdentities(privateDescriptors, privatePaths);
    assertDistinctDescriptorObjects([acquiredWorkspace, acquiredPrivateRoot, ...acquiredPrivatePaths]);
    if (sealedExecutable === undefined) {throw new Error("Host Custody sealed executable observation is missing");}
    let closed = false;
    return Object.freeze({
      close() {
        if (closed) {return;}
        closed = true;
        closeSync(executableDescriptor as number);
        closeSync(sourceDescriptor);
        closeSync(workspaceDescriptor as number);
        closeSync(privateRootDescriptor as number);
        for (const descriptor of privateDescriptors) {closeSync(descriptor.parentDescriptor);}
      },
      executable: sealedExecutable,
      executableDescriptor: Object.freeze({ childDescriptor: 5, parentDescriptor: executableDescriptor }),
      privatePathDescriptors: Object.freeze(Object.fromEntries(privateDescriptors.map(descriptor => [
        descriptor.key,
        Object.freeze({
          childDescriptor: descriptor.childDescriptor,
          parentDescriptor: descriptor.parentDescriptor,
        }),
      ]))),
      workspaceDescriptor: Object.freeze({ childDescriptor: 4, parentDescriptor: workspaceDescriptor }),
      privateRootDescriptor: Object.freeze({ childDescriptor: 6 + privateDescriptors.length, parentDescriptor: privateRootDescriptor }),
    });
  } catch (error) {
    closeSync(sourceDescriptor);
    closeOptionalDescriptor(executableDescriptor);
    closeOptionalDescriptor(workspaceDescriptor);
    closeOptionalDescriptor(privateRootDescriptor);
    for (const descriptor of privateDescriptors) {closeSync(descriptor.parentDescriptor);}
    throw error;
  }
};

export const hostCustodyDescriptorLaunchTestSupport = Object.freeze({
  assertDistinctDescriptorObjects,
  openPrivateDescriptors,
  sealExecutableDescriptor,
});

export const descriptorBoundEnvironment = (
  environment: Readonly<Record<string, string>>,
  descriptors: VerifiedLaunchDescriptors["privatePathDescriptors"],
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(environment).map(([key, value]) => {
    const descriptor = descriptors[key];
    return descriptor === undefined ? [key, value] : [key, `/proc/self/fd/${descriptor.childDescriptor}`];
  }),
));

export const descriptorBoundArguments = (
  arguments_: readonly string[],
  workspaceRef: string,
  childWorkspaceDescriptor: number,
): readonly string[] => Object.freeze(arguments_.map(argument =>
  argument.split(workspaceRef).join(`/proc/self/fd/${childWorkspaceDescriptor}`)));
