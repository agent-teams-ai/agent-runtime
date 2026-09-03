import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";

import {
  assertSameMountIdentity,
  descriptorChildPath,
  fsyncDirectoryHandle,
} from "./contained-turn-filesystem-custody.js";
import { openContainedTurnRelativeDirectory } from "./contained-turn-relative-directory.js";
import {
  scanContainedTurnWorkspace,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

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
    const openedParent = await openContainedTurnRelativeDirectory(
      workspace, parentPath, "materialization",
    );
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
    const handle = await openContainedTurnRelativeDirectory(
      workspace, directory.path, "materialization",
    );
    if (handle === undefined) {throw new Error("contained turn materialized directory disappeared");}
    try {await handle.chmod(directory.mode); await handle.sync();} finally {await handle.close();}
  }
  await fsyncDirectoryHandle(workspace);
  return source.treeDigest;
};
