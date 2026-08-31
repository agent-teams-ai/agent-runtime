import { constants } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertSameStableDirectoryMountIdentity,
  readStableDirectoryMountIdentity,
  stableDirectoryMutationCapability,
} from "@agent-teams/filesystem-custody";
import { ContainedTurnFilesystemUnsupportedError } from "./contained-turn-filesystem-error.js";

export {
  ContainedTurnFilesystemCustodyError,
  ContainedTurnFilesystemUnsupportedError,
  guardContainedTurnFilesystemOperation,
} from "./contained-turn-filesystem-error.js";
const PRIVATE_DIRECTORY_MODE = 0o700n;
const UNSAFE_DIRECTORY_WRITE_MODE = 0o022n;
const STICKY_MODE = 0o1000n;

const filesystemCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export const isMissingFilesystemEntry = (error: unknown): boolean =>
  filesystemCode(error) === "ENOENT";

const isAlreadyPresent = (error: unknown): boolean => filesystemCode(error) === "EEXIST";

export interface ContainedTurnFilesystemIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
}

export interface BoundContainedTurnRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly identity: Readonly<Pick<ContainedTurnFilesystemIdentity, "dev" | "ino" | "mode"> & {
    readonly mountId: string;
  }>;
  readonly private: boolean;
}

export interface BindContainedTurnRootSetOptions<
  OwnedRoots extends Readonly<Record<string, string>>,
> {
  readonly canonicalProjectRoot: string;
  readonly disposableRoot: string;
  readonly ownedRoots: OwnedRoots;
}

export interface BoundContainedTurnRootSet<
  OwnedRoots extends Readonly<Record<string, string>>,
> {
  readonly canonicalProjectRoot: BoundContainedTurnRoot;
  readonly disposableRoot: BoundContainedTurnRoot;
  readonly ownedRoots: Readonly<{ [Key in keyof OwnedRoots]: BoundContainedTurnRoot }>;
}

export interface ContainedTurnFilesystemObservation extends ContainedTurnFilesystemIdentity {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly uid: bigint;
}

export const readFilesystemMountIdentity = async (
  handle: Pick<FileHandle, "fd">,
): Promise<string> => readStableDirectoryMountIdentity(handle.fd);

export const assertSameMountIdentity = async (
  parent: Pick<FileHandle, "fd">,
  child: Pick<FileHandle, "fd">,
): Promise<void> => {
  const parentMount = await readFilesystemMountIdentity(parent);
  const childMount = await readFilesystemMountIdentity(child);
  try {assertSameStableDirectoryMountIdentity(parentMount, childMount);} catch {
    throw new Error("contained turn filesystem traversal crossed a mount boundary");
  }
};

const observationFromHandle = async (
  handle: FileHandle,
): Promise<ContainedTurnFilesystemObservation> => {
  const observation = await handle.stat({ bigint: true });
  return Object.freeze({
    ctimeNs: observation.ctimeNs,
    dev: observation.dev,
    ino: observation.ino,
    isDirectory: observation.isDirectory(),
    isFile: observation.isFile(),
    isSymbolicLink: observation.isSymbolicLink(),
    mode: observation.mode,
    mtimeNs: observation.mtimeNs,
    nlink: observation.nlink,
    size: observation.size,
    uid: observation.uid,
  });
};

export const sameFilesystemIdentity = (
  left: Pick<ContainedTurnFilesystemIdentity, "dev" | "ino">,
  right: Pick<ContainedTurnFilesystemIdentity, "dev" | "ino">,
): boolean => left.dev === right.dev && left.ino === right.ino;

export const sameFilesystemObservation = (
  left: ContainedTurnFilesystemIdentity,
  right: ContainedTurnFilesystemIdentity,
): boolean =>
  sameFilesystemIdentity(left, right) &&
  left.ctimeNs === right.ctimeNs &&
  left.mode === right.mode &&
  left.mtimeNs === right.mtimeNs;

const assertLinuxDescriptorSupport = (): void => {
  const capability = stableDirectoryMutationCapability();
  if (capability.kind === "unsupported") {
    throw new ContainedTurnFilesystemUnsupportedError(
      `contained turn filesystem custody is unsupported on ${capability.platform}: ${capability.reason}`,
    );
  }
};

const descriptorRoot = (): string => {
  const capability = stableDirectoryMutationCapability();
  if (capability.kind === "unsupported") {
    throw new ContainedTurnFilesystemUnsupportedError(capability.reason);
  }
  return capability.descriptorRoot;
};

const assertNormalizedAbsolutePath = (path: string): void => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError("contained turn filesystem root must be a normalized absolute path");
  }
  if (path.includes("\0")) {
    throw new TypeError("contained turn filesystem root contains a null byte");
  }
};

const assertEntryName = (name: string): void => {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new Error("contained turn descriptor child name is invalid");
  }
};

export const descriptorChildPath = (
  handle: Pick<FileHandle, "fd">,
  name?: string,
): string => {
  assertLinuxDescriptorSupport();
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) {
    throw new Error("contained turn filesystem descriptor is invalid");
  }
  if (name === undefined) {return `${descriptorRoot()}/${handle.fd}`;}
  assertEntryName(name);
  return `${descriptorRoot()}/${handle.fd}/${name}`;
};

const directoryOpenFlags = (): number => {
  assertLinuxDescriptorSupport();
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
};

export const openDirectoryEntry = async (
  parent: FileHandle,
  name: string,
  allowMountBoundary = false,
): Promise<FileHandle> => {
  assertEntryName(name);
  const child = await open(descriptorChildPath(parent, name), directoryOpenFlags());
  try {
    const observation = await observationFromHandle(child);
    if (!observation.isDirectory || observation.isSymbolicLink) {
      throw new Error("contained turn filesystem entry is not a no-follow directory");
    }
    if (!allowMountBoundary) {await assertSameMountIdentity(parent, child);}
    return child;
  } catch (error) {
    await child.close();
    throw error;
  }
};

const assertSafeAncestor = (observation: ContainedTurnFilesystemObservation): void => {
  if (!observation.isDirectory || observation.isSymbolicLink) {
    throw new Error("contained turn filesystem ancestor is not a no-follow directory");
  }
  if (
    (observation.mode & UNSAFE_DIRECTORY_WRITE_MODE) !== 0n &&
    (observation.mode & STICKY_MODE) === 0n
  ) {
    throw new Error("contained turn filesystem has a writable unsafe ancestor");
  }
};

const assertPrivateObservation = (observation: ContainedTurnFilesystemObservation): void => {
  const currentUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : undefined;
  if (
    currentUid === undefined ||
    !observation.isDirectory ||
    observation.isSymbolicLink ||
    observation.uid !== currentUid ||
    (observation.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error("contained turn filesystem custody directory is not private and owned");
  }
};

const pathComponents = (path: string): readonly string[] =>
  path.split(sep).filter(component => component.length > 0);

const assertDescriptorAnchor = async (handle: FileHandle): Promise<void> => {
  let anchored: FileHandle;
  try {
    anchored = await open(
      descriptorChildPath(handle),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
  } catch (error) {
    throw new ContainedTurnFilesystemUnsupportedError(
      `contained turn filesystem descriptor custody is unavailable (${filesystemCode(error) ?? "unknown"})`,
    );
  }
  try {
    const expected = await observationFromHandle(handle);
    const actual = await observationFromHandle(anchored);
    if (!sameFilesystemIdentity(expected, actual)) {
      throw new ContainedTurnFilesystemUnsupportedError(
        "contained turn filesystem descriptor anchor did not preserve directory identity",
      );
    }
  } finally {
    await anchored.close();
  }
};

const createPrivateDirectoryEntry = async (
  parent: FileHandle,
  component: string,
): Promise<FileHandle> => {
  try {
    await mkdir(descriptorChildPath(parent, component), { mode: Number(PRIVATE_DIRECTORY_MODE) });
    await fsyncDirectoryHandle(parent);
  } catch (error) {
    if (!isAlreadyPresent(error)) {throw error;}
  }
  return openDirectoryEntry(parent, component);
};

const openDirectoryNoFollow = async (
  path: string,
  createMissing: boolean,
): Promise<FileHandle> => {
  assertLinuxDescriptorSupport();
  assertNormalizedAbsolutePath(path);
  let current = await open(sep, directoryOpenFlags());
  try {
    await assertDescriptorAnchor(current);
    assertSafeAncestor(await observationFromHandle(current));
    for (const component of pathComponents(path)) {
      let next: FileHandle;
      try {
        next = await openDirectoryEntry(current, component, true);
      } catch (error) {
        if (!createMissing || !isMissingFilesystemEntry(error)) {throw error;}
        next = await createPrivateDirectoryEntry(current, component);
      }
      try {
        assertSafeAncestor(await observationFromHandle(next));
        await current.close();
      } catch (error) {
        try {await next.close();} catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "contained turn directory capture and cleanup failed",
            { cause: error },
          );
        }
        throw error;
      }
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
};

const bindExistingRoot = async (
  path: string,
  requirePrivate: boolean,
): Promise<BoundContainedTurnRoot> => {
  const handle = await openDirectoryNoFollow(path, false);
  try {
    const observation = await observationFromHandle(handle);
    const mountId = await readStableDirectoryMountIdentity(handle.fd);
    if (requirePrivate) {assertPrivateObservation(observation);}
    const canonicalPath = await realpath(descriptorChildPath(handle));
    if (canonicalPath !== path) {
      throw new Error("contained turn filesystem root is a symlink or non-canonical alias");
    }
    return Object.freeze({
      absolutePath: path,
      canonicalPath,
      identity: Object.freeze({
        dev: observation.dev,
        ino: observation.ino,
        mode: observation.mode,
        mountId,
      }),
      private: requirePrivate,
    });
  } finally {
    await handle.close();
  }
};

export const bindContainedTurnRoot = async (
  path: string,
  options: Readonly<{ private?: boolean }> = {},
): Promise<BoundContainedTurnRoot> => bindExistingRoot(path, options.private === true);

export const bindContainedTurnDirectoryEntry = async (
  parentRoot: BoundContainedTurnRoot,
  name: string,
  options: Readonly<{ create?: boolean; private?: boolean }> = {},
): Promise<BoundContainedTurnRoot> => {
  const parent = await openBoundDirectory(parentRoot);
  try {
    if (options.create === true) {
      try {
        await mkdir(descriptorChildPath(parent, name), { mode: Number(PRIVATE_DIRECTORY_MODE) });
        await fsyncDirectoryHandle(parent);
      } catch (error) {if (!isAlreadyPresent(error)) {throw error;}}
    }
    const child = await openDirectoryEntry(parent, name);
    try {
      const observation = await observationFromHandle(child);
      if (options.private === true) {assertPrivateObservation(observation);}
      const canonicalPath = await realpath(descriptorChildPath(child));
      if (canonicalPath !== `${parentRoot.canonicalPath}${sep}${name}`) {
        throw new Error("contained turn filesystem child is a non-canonical alias");
      }
      return Object.freeze({
        absolutePath: canonicalPath,
        canonicalPath,
        identity: Object.freeze({
          dev: observation.dev, ino: observation.ino, mode: observation.mode,
          mountId: await readFilesystemMountIdentity(child),
        }),
        private: options.private === true,
      });
    } finally {await child.close();}
  } finally {await parent.close();}
};

const isStrictDescendant = (parent: string, candidate: string): boolean => {
  const suffix = relative(parent, candidate);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

export const assertDisjointNonAncestorRoots = (
  left: BoundContainedTurnRoot,
  right: BoundContainedTurnRoot,
): void => {
  if (
    sameFilesystemIdentity(left.identity, right.identity) ||
    isStrictDescendant(left.canonicalPath, right.canonicalPath) ||
    isStrictDescendant(right.canonicalPath, left.canonicalPath)
  ) {
    throw new Error("contained turn filesystem roots overlap or have an ancestor relationship");
  }
};

export const assertSameFilesystemMount = (
  parent: BoundContainedTurnRoot,
  child: BoundContainedTurnRoot,
): void => {
  if (parent.identity.mountId !== child.identity.mountId) {
    throw new Error("contained turn owned root crosses its disposable filesystem mount");
  }
};

const portableRootCollisionKey = (path: string): string =>
  path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");

export const bindContainedTurnRootSet = async <
  OwnedRoots extends Readonly<Record<string, string>>,
>(
  options: BindContainedTurnRootSetOptions<OwnedRoots>,
): Promise<BoundContainedTurnRootSet<OwnedRoots>> => {
  const canonicalProjectRoot = await bindExistingRoot(options.canonicalProjectRoot, false);
  const disposableRoot = await bindExistingRoot(options.disposableRoot, true);
  assertDisjointNonAncestorRoots(canonicalProjectRoot, disposableRoot);

  const requestedOwnedEntries = Object.entries(options.ownedRoots);
  for (const [, path] of requestedOwnedEntries) {
    assertNormalizedAbsolutePath(path);
    if (!isStrictDescendant(disposableRoot.canonicalPath, path)) {
      throw new Error("contained turn owned root is not a strict disposable-root descendant");
    }
  }
  for (const [index, [, left]] of requestedOwnedEntries.entries()) {
    for (const [, right] of requestedOwnedEntries.slice(index + 1)) {
      if (
        left === right ||
        portableRootCollisionKey(left) === portableRootCollisionKey(right) ||
        isStrictDescendant(left, right) ||
        isStrictDescendant(right, left)
      ) {
        throw new Error("contained turn owned roots overlap or have an ancestor relationship");
      }
    }
  }

  const ownedEntries: [string, BoundContainedTurnRoot][] = [];
  for (const [key, path] of requestedOwnedEntries) {
    const canonicalPath = await ensurePrivateDirectory(path);
    const root = await bindExistingRoot(canonicalPath, true);
    assertDisjointNonAncestorRoots(canonicalProjectRoot, root);
    assertSameFilesystemMount(disposableRoot, root);
    ownedEntries.push([key, root]);
  }

  for (const [index, [, left]] of ownedEntries.entries()) {
    for (const [, right] of ownedEntries.slice(index + 1)) {
      assertDisjointNonAncestorRoots(left, right);
    }
  }

  return Object.freeze({
    canonicalProjectRoot,
    disposableRoot,
    ownedRoots: Object.freeze(Object.fromEntries(ownedEntries)) as Readonly<{
      [Key in keyof OwnedRoots]: BoundContainedTurnRoot;
    }>,
  });
};

export const openBoundDirectory = async (
  root: BoundContainedTurnRoot,
): Promise<FileHandle> => {
  const handle = await openDirectoryNoFollow(root.canonicalPath, false);
  try {
    const observation = await observationFromHandle(handle);
    const mountId = await readStableDirectoryMountIdentity(handle.fd);
    if (root.private) {assertPrivateObservation(observation);}
    if (
      !sameFilesystemIdentity(observation, root.identity) ||
      observation.mode !== root.identity.mode ||
      mountId !== root.identity.mountId
    ) {
      throw new Error("contained turn bound filesystem root identity changed");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export const revalidateBoundRoots = async (
  roots: readonly BoundContainedTurnRoot[],
): Promise<void> => {
  for (const root of roots) {
    const handle = await openBoundDirectory(root);
    try {
      // Retaining the descriptor until this point proves the captured root is openable.
    } finally {
      await handle.close();
    }
  }
};

export const fsyncDirectoryHandle = async (handle: FileHandle): Promise<void> => {
  const observation = await observationFromHandle(handle);
  if (!observation.isDirectory) {throw new Error("contained turn fsync target is not a directory");}
  await handle.sync();
};

export const fsyncDirectory = async (path: string): Promise<void> => {
  const handle = await openDirectoryNoFollow(path, false);
  try {
    await fsyncDirectoryHandle(handle);
  } finally {
    await handle.close();
  }
};

export const assertPrivateDirectory = async (path: string): Promise<void> => {
  const root = await bindExistingRoot(path, true);
  const handle = await openBoundDirectory(root);
  await handle.close();
};

export const ensurePrivateDirectory = async (path: string): Promise<string> => {
  const handle = await openDirectoryNoFollow(path, true);
  try {
    const observation = await observationFromHandle(handle);
    assertPrivateObservation(observation);
    const canonicalPath = await realpath(descriptorChildPath(handle));
    if (canonicalPath !== path) {
      throw new Error("contained turn filesystem custody root is a non-canonical alias");
    }
    return canonicalPath;
  } finally {
    await handle.close();
  }
};

export const inspectFileHandle = observationFromHandle;
