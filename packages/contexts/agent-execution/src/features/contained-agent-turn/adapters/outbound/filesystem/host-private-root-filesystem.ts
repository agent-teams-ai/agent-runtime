import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
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
  check(): void;
  retain(handle: FileHandle): FileHandle;
  close(handle: FileHandle): Promise<void>;
}

export const assertPrivateRootHandle = async (handle: FileHandle, root: BoundContainedTurnRoot): Promise<void> => {
  const observed = await inspectFileHandle(handle);
  if (!observed.isDirectory || observed.nlink === 0n ||
      !sameFilesystemIdentity(observed, root.identity) || observed.mode !== root.identity.mode ||
      observed.uid !== BigInt(process.getuid!()) || (observed.mode & 0o7777n) !== 0o700n ||
      await readFilesystemMountIdentity(handle) !== root.identity.mountId) {
    throw new Error("Private root retained directory identity or protection changed");
  }
};

export const assertPrivateRootEntry = async (
  parent: FileHandle, name: string, expected: BoundContainedTurnRoot, budget: PrivateRootTraversal,
): Promise<void> => {
  budget.check();
  const entry = budget.retain(await openDirectoryEntry(parent, name));
  try {await assertPrivateRootHandle(entry, expected);} finally {await budget.close(entry);}
  budget.check();
};

export const assertPrivateRootAbsent = async (parent: FileHandle, name: string): Promise<void> => {
  try {await lstat(descriptorChildPath(parent, name));} catch (error) {
    if (isMissingFilesystemEntry(error)) {return;}
    throw error;
  }
  throw new Error("Private root entry is still present");
};

const inspectLeaf = async (parent: FileHandle, name: string, budget: PrivateRootTraversal): Promise<FileHandle> => {
  const handle = budget.retain(await open(descriptorChildPath(parent, name), LINUX_O_PATH | constants.O_NOFOLLOW));
  await assertSameMountIdentity(parent, handle);
  const observed = await inspectFileHandle(handle);
  if ((!observed.isFile && !observed.isSymbolicLink) || observed.nlink !== 1n) {
    throw new Error("Private root special file or unknown hardlink rejected");
  }
  return handle;
};

const traverseLeaf = async (
  parent: FileHandle, name: string, budget: PrivateRootTraversal, input: Readonly<{ remove: boolean; expected: BigIntStats }>,
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
  parent: FileHandle, name: string, budget: PrivateRootTraversal,
  input: Readonly<{ depth: number; remove: boolean; expected: BigIntStats }>,
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
  root: FileHandle, budget: PrivateRootTraversal,
  input: Readonly<{ depth: number; remove: boolean }> = { depth: 0, remove: false },
): Promise<void> => {
  budget.check();
  if (input.depth > budget.maximumDepth) {throw new Error("Private root traversal depth exceeded");}
  const names = await readDirectoryNamesBounded(root, budget.remaining);
  budget.remaining -= names.length;
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
