import type { StableFilesystemHandle, StableFilesystemStats } from "@agent-teams/filesystem-custody/composition";
import { constants } from "node:fs";
import { lstat, open, rmdir, unlink } from "node:fs/promises";
import {
  assertSameMountIdentity, descriptorChildPath, fsyncDirectoryHandle,
  inspectFileHandle, isMissingFilesystemEntry, openDirectoryEntry,
  readFilesystemMountIdentity, sameFilesystemIdentity,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import { readDirectoryNamesBounded } from "./contained-turn-filesystem-reads.js";

/** Linux O_PATH is not exposed by Node's constants. It opens special files
 * without invoking a device driver, and permits no-follow symlink fstat. */
const LINUX_O_PATH = 0x200000;

export interface PrivateRootTraversal {
  remaining: number;
  readonly maximumDepth: number;
  readonly directoryIdentities: Set<string>;
  readonly forbiddenDirectoryIdentities: ReadonlySet<string>;
  check(): void;
  retain(handle: StableFilesystemHandle): StableFilesystemHandle;
  close(handle: StableFilesystemHandle): Promise<void>;
}

// Mount IDs qualify descriptor custody, but cannot distinguish bind aliases of
// the same inode. Separation must compare device/inode pairs across mounts.
export const privateRootDirectoryIdentity = (identity: Pick<StableFilesystemStats, "dev" | "ino">): string =>
  `${identity.dev}:${identity.ino}`;

const inspectTraversalDirectory = async (root: StableFilesystemHandle, budget: PrivateRootTraversal): Promise<void> => {
  const observed = await inspectFileHandle(root);
  const identity = privateRootDirectoryIdentity(observed);
  if (!observed.isDirectory || observed.nlink === 0n || budget.forbiddenDirectoryIdentities.has(identity)) {
    throw new Error("Private root directory identity overlaps protected parent or workspace");
  }
  budget.directoryIdentities.add(identity);
};

export const assertPrivateRootHandle = async (handle: StableFilesystemHandle, root: BoundContainedTurnRoot): Promise<void> => {
  const observed = await inspectFileHandle(handle);
  if (!observed.isDirectory || observed.nlink === 0n ||
      !sameFilesystemIdentity(observed, root.identity) || observed.mode !== root.identity.mode ||
      observed.uid !== BigInt(process.getuid!()) || (observed.mode & 0o7777n) !== 0o700n ||
      await readFilesystemMountIdentity(handle) !== root.identity.mountId) {
    throw new Error("Private root retained directory identity or protection changed");
  }
};

export const assertPrivateRootEntry = async (
  parent: StableFilesystemHandle, name: string, expected: BoundContainedTurnRoot, budget: PrivateRootTraversal,
): Promise<void> => {
  budget.check();
  const entry = budget.retain(await openDirectoryEntry(parent, name));
  try {await assertPrivateRootHandle(entry, expected);} finally {await budget.close(entry);}
  budget.check();
};

export const assertPrivateRootAbsent = async (parent: StableFilesystemHandle, name: string): Promise<void> => {
  try {await lstat(descriptorChildPath(parent, name));} catch (error) {
    if (isMissingFilesystemEntry(error)) {return;}
    throw error;
  }
  throw new Error("Private root entry is still present");
};

const inspectLeaf = async (parent: StableFilesystemHandle, name: string, budget: PrivateRootTraversal): Promise<StableFilesystemHandle> => {
  const handle = budget.retain(await open(descriptorChildPath(parent, name), LINUX_O_PATH | constants.O_NOFOLLOW));
  await assertSameMountIdentity(parent, handle);
  const observed = await inspectFileHandle(handle);
  if ((!observed.isFile && !observed.isSymbolicLink) || observed.nlink !== 1n) {
    throw new Error("Private root special file or unknown hardlink rejected");
  }
  return handle;
};

const traverseLeaf = async (
  parent: StableFilesystemHandle, name: string, budget: PrivateRootTraversal, input: Readonly<{ remove: boolean; expected: StableFilesystemStats }>,
): Promise<void> => {
  const handle = await inspectLeaf(parent, name, budget);
  try {
    const before = await inspectFileHandle(handle);
    if (!sameFilesystemIdentity(before, input.expected)) {throw new Error("Private root leaf replaced before open");}
    const named = await lstat(descriptorChildPath(parent, name), { bigint: true });
    if (!sameFilesystemIdentity(before, named) || before.mode !== named.mode || named.nlink !== 1n) {
      throw new Error("Private root leaf replaced");
    }
    budget.check();
    if (input.remove) {
      await unlink(descriptorChildPath(parent, name));
      budget.check();
      await assertPrivateRootAbsent(parent, name);
      if ((await inspectFileHandle(handle)).nlink !== 0n) {throw new Error("Private root leaf unlink unproven");}
    }
  } finally {await budget.close(handle);}
};

const traverseChildDirectory = async (
  parent: StableFilesystemHandle, name: string, budget: PrivateRootTraversal,
  input: Readonly<{ depth: number; remove: boolean; expected: StableFilesystemStats }>,
): Promise<void> => {
  const child = budget.retain(await openDirectoryEntry(parent, name));
  try {
    const before = await inspectFileHandle(child);
    if (!sameFilesystemIdentity(before, input.expected)) {throw new Error("Private root directory replaced before open");}
    await traversePrivateRoot(child, budget, input);
    const named = await lstat(descriptorChildPath(parent, name), { bigint: true });
    if (!sameFilesystemIdentity(before, named) || !named.isDirectory()) {throw new Error("Private root directory replaced");}
    await assertSameMountIdentity(parent, child);
    budget.check();
    if (input.remove) {
      await rmdir(descriptorChildPath(parent, name));
      budget.check();
      await assertPrivateRootAbsent(parent, name);
      if ((await inspectFileHandle(child)).nlink !== 0n) {throw new Error("Private root directory unlink unproven");}
      await fsyncDirectoryHandle(parent);
    }
  } finally {await budget.close(child);}
};

/** Only called under the private quiescence owner for mutation. Every child is
 * opened relative to a retained descriptor; links themselves are unlinked. */
export const traversePrivateRoot = async (
  root: StableFilesystemHandle, budget: PrivateRootTraversal,
  input: Readonly<{ depth: number; remove: boolean }> = { depth: 0, remove: false },
): Promise<void> => {
  budget.check();
  if (input.depth > budget.maximumDepth) {throw new Error("Private root traversal depth exceeded");}
  await inspectTraversalDirectory(root, budget);
  const names = await readDirectoryNamesBounded(root, budget.remaining);
  budget.remaining -= names.length;
  await inspectTraversalDirectory(root, budget);
  for (const name of names) {
    budget.check();
    const observed = await lstat(descriptorChildPath(root, name), { bigint: true });
    if (observed.isDirectory()) {
      await traverseChildDirectory(root, name, budget, { depth: input.depth + 1, remove: input.remove, expected: observed });
    } else {await traverseLeaf(root, name, budget, { remove: input.remove, expected: observed });}
  }
  if (input.remove) {
    if ((await readDirectoryNamesBounded(root, 0)).length !== 0) {throw new Error("Private root is not empty");}
    await fsyncDirectoryHandle(root);
  }
  budget.check();
};
