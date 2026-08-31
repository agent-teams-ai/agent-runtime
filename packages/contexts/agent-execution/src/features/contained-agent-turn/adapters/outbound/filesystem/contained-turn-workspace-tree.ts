import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  bindContainedTurnRoot,
  assertSameMountIdentity,
  descriptorChildPath,
  inspectFileHandle,
  openBoundDirectory,
  sameFilesystemIdentity,
  sameFilesystemObservation,
  type ContainedTurnFilesystemIdentity,
  type ContainedTurnFilesystemObservation,
} from "./contained-turn-filesystem-custody.js";
import {
  boundedReadFileHandle,
  readDirectoryNamesBounded,
} from "./contained-turn-filesystem-reads.js";

const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*]/u;
const LINUX_O_PATH = 0x20_0000;

export interface ContainedTurnWorkspaceTreeLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface ContainedTurnWorkspaceDirectoryEntry {
  readonly kind: "directory";
  readonly mode: number;
  readonly relativePath: string;
}

export interface ContainedTurnWorkspaceFileEntry {
  readonly digest: string;
  readonly kind: "file";
  readonly mode: number;
  readonly relativePath: string;
  readonly size: number;
}

export type ContainedTurnWorkspaceEntry =
  | ContainedTurnWorkspaceDirectoryEntry
  | ContainedTurnWorkspaceFileEntry;

export interface ContainedTurnWorkspaceFile {
  readonly bytes: Buffer;
  readonly digest: string;
  readonly mode: number;
  readonly relativePath: string;
  readonly size: number;
}

export interface ContainedTurnWorkspaceTree {
  readonly entries: readonly ContainedTurnWorkspaceEntry[];
  readonly files: readonly ContainedTurnWorkspaceFile[];
  readonly rootIdentity: ContainedTurnFilesystemIdentity;
  readonly treeDigest: string;
}

export type ContainedTurnWorkspaceScanCheckpointPhase =
  | "root-opened"
  | "before-directory-enumeration"
  | "after-directory-enumeration"
  | "before-entry-open"
  | "after-entry-open"
  | "before-file-read"
  | "after-file-read"
  | "before-directory-close"
  | "before-root-revalidation";

export interface ContainedTurnWorkspaceScanCheckpoint {
  readonly absolutePath: string;
  readonly kind?: "directory" | "file";
  readonly phase: ContainedTurnWorkspaceScanCheckpointPhase;
  readonly relativePath: string;
}

export interface ContainedTurnWorkspaceScanDependencies {
  readonly checkpoint?: (
    checkpoint: ContainedTurnWorkspaceScanCheckpoint,
  ) => Promise<void> | void;
  readonly contentDigest?: (bytes: Uint8Array) => Promise<string> | string;
  readonly requirePrivateRoot?: boolean;
}

export const DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS: ContainedTurnWorkspaceTreeLimits =
  Object.freeze({
    maxDepth: 32,
    maxEntries: 4_096,
    maxFileBytes: 8 * 1_024 * 1_024,
    maxTotalBytes: 32 * 1_024 * 1_024,
  });

interface TraversalState {
  readonly dependencies: ContainedTurnWorkspaceScanDependencies;
  readonly entries: ContainedTurnWorkspaceEntry[];
  readonly files: ContainedTurnWorkspaceFile[];
  readonly limits: ContainedTurnWorkspaceTreeLimits;
  readonly rootDevice: bigint;
  readonly trackedHandles: Set<FileHandle>;
  totalBytes: number;
  readonly workspaceRoot: string;
}

const assertLimits = (limits: ContainedTurnWorkspaceTreeLimits): void => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`contained turn workspace ${name} must be a non-negative safe integer`);
    }
  }
  if (
    limits.maxDepth > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxDepth ||
    limits.maxEntries > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxEntries ||
    limits.maxFileBytes > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxFileBytes ||
    limits.maxTotalBytes > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxTotalBytes ||
    limits.maxFileBytes > limits.maxTotalBytes
  ) {
    throw new TypeError("contained turn workspace limits exceed the qualified hard ceilings");
  }
};

const portableCollisionKey = (name: string): string =>
  name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");

const containsControlCharacter = (value: string): boolean =>
  [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

const validateEntryNames = (names: readonly string[]): void => {
  const portableKeys = new Set<string>();
  for (const name of names) {
    if (
      name.length === 0 || name !== name.normalize("NFC") || /[ .]$/u.test(name) ||
      WINDOWS_RESERVED_NAME.test(name) || WINDOWS_FORBIDDEN_CHARACTERS.test(name) ||
      containsControlCharacter(name) || Buffer.byteLength(name, "utf8") > 255
    ) {
      throw new Error("contained turn workspace contains a non-portable entry name");
    }
    const portableKey = portableCollisionKey(name);
    if (portableKeys.has(portableKey)) {
      throw new Error("contained turn workspace contains a case or Unicode collision");
    }
    portableKeys.add(portableKey);
  }
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const checkpoint = async (
  state: TraversalState,
  phase: ContainedTurnWorkspaceScanCheckpointPhase,
  relativePath: string,
  kind?: "directory" | "file",
): Promise<void> => {
  await state.dependencies.checkpoint?.(Object.freeze({
    absolutePath: relativePath === ""
      ? state.workspaceRoot
      : join(state.workspaceRoot, ...relativePath.split("/")),
    ...(kind === undefined ? {} : { kind }),
    phase,
    relativePath,
  }));
};

const digestFile = async (bytes: Uint8Array, state: TraversalState): Promise<string> => {
  const digest = await (state.dependencies.contentDigest === undefined
    ? createHash("sha256").update(bytes).digest("hex")
    : state.dependencies.contentDigest(bytes));
  if (!/^[a-f\d]{64}$/u.test(digest)) {
    throw new Error("contained turn content digest dependency returned an invalid digest");
  }
  return digest;
};

const openInspectedEntry = async (parent: FileHandle, name: string): Promise<FileHandle> => {
  const child = await open(
    descriptorChildPath(parent, name),
    LINUX_O_PATH | constants.O_NOFOLLOW,
  );
  try {
    await assertSameMountIdentity(parent, child);
    return child;
  } catch (error) {
    await child.close();
    throw error;
  }
};

const openReadableFileEntry = async (
  parent: FileHandle,
  retained: FileHandle,
  expected: ContainedTurnFilesystemObservation,
): Promise<FileHandle> => {
  const readable = await open(
    descriptorChildPath(retained),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    await assertSameMountIdentity(parent, readable);
    if (!sameFilesystemObservation(expected, await inspectFileHandle(readable))) {
      throw new Error("contained turn workspace file identity changed before read");
    }
    return readable;
  } catch (error) {
    await readable.close();
    throw error;
  }
};

const closeTracked = async (state: TraversalState, handle: FileHandle): Promise<void> => {
  state.trackedHandles.delete(handle);
  await handle.close();
};

const readFileEntry = async (
  handle: FileHandle,
  observation: ContainedTurnFilesystemObservation,
  relativePath: string,
  state: TraversalState,
): Promise<void> => {
  if (observation.nlink !== 1n) {
    throw new Error("contained turn workspace contains a hard-linked file");
  }
  await checkpoint(state, "after-entry-open", relativePath, "file");
  await checkpoint(state, "before-file-read", relativePath, "file");
  const remainingTotalBytes = state.limits.maxTotalBytes - state.totalBytes;
  const bytes = await boundedReadFileHandle(
    handle,
    Math.min(state.limits.maxFileBytes, remainingTotalBytes),
    observation,
  );
  await checkpoint(state, "after-file-read", relativePath, "file");
  const finalObservation = await inspectFileHandle(handle);
  if (!sameFilesystemObservation(observation, finalObservation)) {
    throw new Error("contained turn workspace file changed after its bounded read");
  }
  state.totalBytes += bytes.length;
  if (state.totalBytes > state.limits.maxTotalBytes) {
    throw new Error("contained turn workspace exceeded its byte limit");
  }
  const size = bytes.length;
  const mode = portablePermissionMode(observation);
  const digest = await digestFile(bytes, state);
  state.entries.push(Object.freeze({ digest, kind: "file", mode, relativePath, size }));
  state.files.push(Object.freeze({ bytes, digest, mode, relativePath, size }));
};

const portablePermissionMode = (
  observation: ContainedTurnFilesystemObservation,
): number => {
  if ((observation.mode & 0o7000n) !== 0n) {
    throw new Error("contained turn workspace contains unsupported special permission bits");
  }
  return Number(observation.mode & 0o777n);
};

const visitDirectory = async (
  handle: FileHandle,
  initial: ContainedTurnFilesystemObservation,
  relativeDirectoryPath: string,
  depth: number,
  state: TraversalState,
): Promise<void> => {
  await checkpoint(state, "before-directory-enumeration", relativeDirectoryPath, "directory");
  const names = (await readDirectoryNamesBounded(
    handle,
    state.limits.maxEntries - state.entries.length,
  )).toSorted(compareCodeUnits);
  validateEntryNames(names);
  await checkpoint(state, "after-directory-enumeration", relativeDirectoryPath, "directory");
  for (const name of names) {
    const relativePath = relativeDirectoryPath === "" ? name : `${relativeDirectoryPath}/${name}`;
    await checkpoint(state, "before-entry-open", relativePath);
    const inspected = await openInspectedEntry(handle, name);
    state.trackedHandles.add(inspected);
    try {
      const observation = await inspectFileHandle(inspected);
      if (observation.dev !== state.rootDevice) {
        throw new Error("contained turn workspace crosses a filesystem device boundary");
      }
      if (observation.isSymbolicLink) {
        throw new Error("contained turn workspace contains a symbolic link");
      }
      if (observation.isDirectory) {
        const childDepth = depth + 1;
        if (childDepth > state.limits.maxDepth) {
          throw new Error("contained turn workspace exceeded its depth limit");
        }
        state.entries.push(Object.freeze({
          kind: "directory",
          mode: portablePermissionMode(observation),
          relativePath,
        }));
        await checkpoint(state, "after-entry-open", relativePath, "directory");
        await visitDirectory(inspected, observation, relativePath, childDepth, state);
      } else if (observation.isFile) {
        const readable = await openReadableFileEntry(handle, inspected, observation);
        state.trackedHandles.add(readable);
        try {
          await readFileEntry(readable, observation, relativePath, state);
        } finally {await closeTracked(state, readable);}
      } else {
        throw new Error("contained turn workspace contains a non-file entry");
      }
    } finally {
      await closeTracked(state, inspected);
    }
  }
  await checkpoint(state, "before-directory-close", relativeDirectoryPath, "directory");
  const final = await inspectFileHandle(handle);
  if (!sameFilesystemObservation(initial, final)) {
    throw new Error("contained turn workspace directory changed during traversal");
  }
};

const scanOpenRoot = async (
  boundRoot: Readonly<{
    readonly identity: Pick<ContainedTurnFilesystemObservation, "dev" | "ino" | "mode">;
  }>,
  rootHandle: FileHandle,
  reopenRoot: () => Promise<FileHandle>,
  state: TraversalState,
): Promise<ContainedTurnWorkspaceTree> => {
  const rootInitial = await inspectFileHandle(rootHandle);
  if (
    !sameFilesystemIdentity(rootInitial, boundRoot.identity) ||
    rootInitial.mode !== boundRoot.identity.mode
  ) {
    throw new Error("contained turn workspace root changed before traversal");
  }
  await checkpoint(state, "root-opened", "", "directory");
  await visitDirectory(rootHandle, rootInitial, "", 0, state);
  const entries = state.entries.toSorted((left, right) =>
    compareCodeUnits(left.relativePath, right.relativePath));
  const files = state.files.toSorted((left, right) =>
    compareCodeUnits(left.relativePath, right.relativePath));
  const identity = entries.map(entry => entry.kind === "directory"
    ? [entry.kind, entry.relativePath, entry.mode]
    : [entry.kind, entry.relativePath, entry.mode, entry.size, entry.digest]);
  const treeDigest = createHash("sha256")
    .update(Buffer.from(JSON.stringify(identity), "utf8"))
    .digest("hex");
  await checkpoint(state, "before-root-revalidation", "", "directory");
  const rootFinal = await inspectFileHandle(rootHandle);
  if (!sameFilesystemObservation(rootInitial, rootFinal)) {
    throw new Error("contained turn workspace root changed during traversal");
  }
  const revalidated = await reopenRoot();
  try {
    if (!sameFilesystemIdentity(rootInitial, await inspectFileHandle(revalidated))) {
      throw new Error("contained turn workspace root path changed during traversal");
    }
  } finally {
    await revalidated.close();
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    files: Object.freeze(files),
    rootIdentity: Object.freeze({
      ctimeNs: rootInitial.ctimeNs,
      dev: rootInitial.dev,
      ino: rootInitial.ino,
      mode: rootInitial.mode,
      mtimeNs: rootInitial.mtimeNs,
    }),
    treeDigest,
  });
};

const closeAll = async (handles: Set<FileHandle>): Promise<readonly unknown[]> => {
  const errors: unknown[] = [];
  for (const handle of handles) {
    try {await handle.close();} catch (error) {errors.push(error);}
  }
  handles.clear();
  return errors;
};

export const scanContainedTurnWorkspace = async (
  workspaceRoot: string,
  limits: ContainedTurnWorkspaceTreeLimits = DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  dependencies: ContainedTurnWorkspaceScanDependencies = {},
): Promise<ContainedTurnWorkspaceTree> => {
  assertLimits(limits);
  const boundRoot = await bindContainedTurnRoot(workspaceRoot, {
    private: dependencies.requirePrivateRoot !== false,
  });
  const rootHandle = await openBoundDirectory(boundRoot);
  const trackedHandles = new Set<FileHandle>([rootHandle]);
  const state: TraversalState = {
    dependencies,
    entries: [],
    files: [],
    limits,
    rootDevice: boundRoot.identity.dev,
    totalBytes: 0,
    trackedHandles,
    workspaceRoot,
  };
  let result: ContainedTurnWorkspaceTree | undefined;
  let primary: unknown;
  try {
    result = await scanOpenRoot(boundRoot, rootHandle, () => openBoundDirectory(boundRoot), state);
  } catch (error) {
    primary = error;
  }
  const cleanupErrors = await closeAll(trackedHandles);
  if (primary !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primary, ...cleanupErrors], "contained turn scan and cleanup failed");
    }
    throw primary;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "contained turn scan cleanup failed");
  }
  if (result === undefined) {throw new Error("contained turn scan produced no tree identity");}
  return result;
};

export const scanContainedTurnWorkspaceHandle = async (
  rootHandle: FileHandle,
  workspaceRoot: string,
  limits: ContainedTurnWorkspaceTreeLimits = DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  dependencies: ContainedTurnWorkspaceScanDependencies = {},
): Promise<ContainedTurnWorkspaceTree> => {
  assertLimits(limits);
  const initial = await inspectFileHandle(rootHandle);
  if (!initial.isDirectory || initial.isSymbolicLink) {
    throw new Error("contained turn retained workspace root is not a directory");
  }
  const reopenRoot = async (): Promise<FileHandle> => {
    const reopened = await open(
      descriptorChildPath(rootHandle),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await assertSameMountIdentity(rootHandle, reopened);
      if (!sameFilesystemIdentity(initial, await inspectFileHandle(reopened))) {
        throw new Error("contained turn retained workspace root identity changed");
      }
      return reopened;
    } catch (error) {
      await reopened.close();
      throw error;
    }
  };
  const trackedHandles = new Set<FileHandle>();
  const state: TraversalState = {
    dependencies,
    entries: [],
    files: [],
    limits,
    rootDevice: initial.dev,
    totalBytes: 0,
    trackedHandles,
    workspaceRoot,
  };
  let result: ContainedTurnWorkspaceTree | undefined;
  let primary: unknown;
  try {
    result = await scanOpenRoot({ identity: initial }, rootHandle, reopenRoot, state);
  } catch (error) {
    primary = error;
  }
  const cleanupErrors = await closeAll(trackedHandles);
  if (primary !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primary, ...cleanupErrors], "contained turn scan and cleanup failed");
    }
    throw primary;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "contained turn scan cleanup failed");
  }
  if (result === undefined) {throw new Error("contained turn retained workspace scan produced no result");}
  return result;
};
