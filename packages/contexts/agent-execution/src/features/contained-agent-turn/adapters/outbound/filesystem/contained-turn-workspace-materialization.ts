import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";

import {
  assertSameMountIdentity,
  descriptorChildPath,
  fsyncDirectoryHandle,
  openDirectoryEntry,
} from "./contained-turn-filesystem-custody.js";
import {
  scanContainedTurnWorkspace,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

const openRelativeDirectory = async (
  root: FileHandle,
  relativePath: string,
): Promise<FileHandle | undefined> => {
  if (relativePath.length === 0) {return undefined;}
  let current: FileHandle | undefined;
  try {
    for (const component of relativePath.split("/")) {
      const next = await openDirectoryEntry(current ?? root, component);
      if (current !== undefined) {
        const previous = current;
        current = undefined;
        try {await previous.close();} catch (error) {
          try {await next.close();} catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "contained turn materialization path handoff and cleanup failed",
              { cause: error },
            );
          }
          throw error;
        }
      }
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== undefined) {
      try {await current.close();} catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "contained turn materialization path capture and cleanup failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
};

export const materializeCanonicalProject = async (
  canonicalProjectRoot: string,
  workspace: FileHandle,
  limits: ContainedTurnWorkspaceTreeLimits,
): Promise<string> => {
  const source = await scanContainedTurnWorkspace(canonicalProjectRoot, limits, {
    requirePrivateRoot: false,
  });
  const directoryModes: { readonly mode: number; readonly path: string }[] = [];
  for (const entry of source.entries) {
    const separator = entry.relativePath.lastIndexOf("/");
    const parentPath = separator === -1 ? "" : entry.relativePath.slice(0, separator);
    const name = separator === -1 ? entry.relativePath : entry.relativePath.slice(separator + 1);
    const openedParent = await openRelativeDirectory(workspace, parentPath);
    const parent = openedParent ?? workspace;
    try {
      if (entry.kind === "directory") {
        await mkdir(descriptorChildPath(parent, name), { mode: 0o700 });
        directoryModes.push({ mode: entry.mode, path: entry.relativePath });
      } else {
        const sourceFile = source.files.find(file => file.relativePath === entry.relativePath);
        if (sourceFile === undefined) {throw new Error("contained turn materialization lost a verified source file");}
        const target = await open(
          descriptorChildPath(parent, name),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await assertSameMountIdentity(parent, target);
          await target.writeFile(sourceFile.bytes);
          await target.chmod(entry.mode);
          await target.sync();
        } finally {await target.close();}
      }
      await fsyncDirectoryHandle(parent);
    } finally {await openedParent?.close();}
  }
  for (const directory of directoryModes.toReversed()) {
    const handle = await openRelativeDirectory(workspace, directory.path);
    if (handle === undefined) {throw new Error("contained turn materialized directory disappeared");}
    try {await handle.chmod(directory.mode); await handle.sync();} finally {await handle.close();}
  }
  await fsyncDirectoryHandle(workspace);
  return source.treeDigest;
};
