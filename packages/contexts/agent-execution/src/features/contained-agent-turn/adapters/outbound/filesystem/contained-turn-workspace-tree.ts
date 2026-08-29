import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { openStablePath } from "@agent-teams/filesystem-custody";

const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;

export interface ContainedTurnWorkspaceTreeLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface ContainedTurnWorkspaceFile {
  readonly bytes: Buffer;
  readonly digest: string;
  readonly mode: number;
  readonly relativePath: string;
  readonly size: number;
}

export interface ContainedTurnWorkspaceTree {
  readonly entries: readonly { readonly kind: "directory" | "file"; readonly relativePath: string }[];
  readonly files: readonly ContainedTurnWorkspaceFile[];
  readonly treeDigest: string;
}

export const DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS: ContainedTurnWorkspaceTreeLimits = Object.freeze({
  maxDepth: 32,
  maxEntries: 4_096,
  maxFileBytes: 8 * 1_024 * 1_024,
  maxTotalBytes: 32 * 1_024 * 1_024,
});

const safeRelativePath = (root: string, candidate: string): string => {
  const suffix = relative(root, candidate);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("contained turn workspace path escaped its root");
  }
  return suffix.split(sep).join("/");
};

const validateEntryNames = (names: readonly string[]): void => {
  const caseKeys = new Set<string>();
  for (const name of names) {
    if (
      name.length === 0 || name.includes("\u0000") || name !== name.normalize("NFC") ||
      /[ .]$/u.test(name) || WINDOWS_RESERVED_NAME.test(name)
    ) {
      throw new Error("contained turn workspace contains a non-portable entry name");
    }
    const caseKey = name.toLowerCase();
    if (caseKeys.has(caseKey)) {throw new Error("contained turn workspace contains a case or Unicode collision");}
    caseKeys.add(caseKey);
  }
};

const assertStableRoot = async (workspaceRoot: string): Promise<void> => {
  if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw new Error("contained turn workspace root must be a normalized absolute path");
  }
  const [observation, canonical] = await Promise.all([lstat(workspaceRoot, { bigint: true }), realpath(workspaceRoot)]);
  if (!observation.isDirectory() || observation.isSymbolicLink() || canonical !== workspaceRoot) {
    throw new Error("contained turn workspace root is not a stable directory");
  }
};

export const scanContainedTurnWorkspace = async (
  workspaceRoot: string,
  limits: ContainedTurnWorkspaceTreeLimits = DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
): Promise<ContainedTurnWorkspaceTree> => {
  await assertStableRoot(workspaceRoot);
  const entries: { readonly kind: "directory" | "file"; readonly relativePath: string }[] = [];
  const files: ContainedTurnWorkspaceFile[] = [];
  const pending: { readonly absolutePath: string; readonly depth: number }[] = [{ absolutePath: workspaceRoot, depth: 0 }];
  let totalBytes = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {break;}
    if (directory.depth >= limits.maxDepth) {throw new Error("contained turn workspace exceeded its depth limit");}
    const names = (await readdir(directory.absolutePath)).toSorted();
    validateEntryNames(names);
    for (const name of names) {
      const absolutePath = join(directory.absolutePath, name);
      const relativePath = safeRelativePath(workspaceRoot, absolutePath);
      const observation = await lstat(absolutePath, { bigint: true });
      if (observation.isSymbolicLink()) {throw new Error("contained turn workspace contains a symbolic link");}
      if (observation.isDirectory()) {
        entries.push(Object.freeze({ kind: "directory", relativePath }));
        pending.push({ absolutePath, depth: directory.depth + 1 });
      } else if (observation.isFile()) {
        if (observation.nlink !== 1n) {throw new Error("contained turn workspace contains a hard-linked file");}
        const size = Number(observation.size);
        if (!Number.isSafeInteger(size) || size > limits.maxFileBytes) {
          throw new Error("contained turn workspace file exceeded its size limit");
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {throw new Error("contained turn workspace exceeded its byte limit");}
        const bytes = await openStablePath(
          absolutePath,
          absolutePath,
          opened => opened.handle.readFile(),
          { custodyBoundary: { absolutePath: workspaceRoot, canonicalPath: workspaceRoot } },
        );
        const digest = createHash("sha256").update(bytes).digest("hex");
        entries.push(Object.freeze({ kind: "file", relativePath }));
        files.push(Object.freeze({
          bytes,
          digest,
          mode: Number(observation.mode & 0o777n),
          relativePath,
          size,
        }));
      } else {
        throw new Error("contained turn workspace contains a non-file entry");
      }
      if (entries.length > limits.maxEntries) {throw new Error("contained turn workspace exceeded its entry limit");}
    }
  }

  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const treeIdentity = entries.map(entry => {
    if (entry.kind === "directory") {return [entry.kind, entry.relativePath];}
    const file = files.find(candidate => candidate.relativePath === entry.relativePath);
    if (file === undefined) {throw new Error("contained turn workspace file projection disappeared");}
    return [entry.kind, entry.relativePath, file.digest, file.mode, file.size];
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    files: Object.freeze(files),
    treeDigest: createHash("sha256").update(JSON.stringify(treeIdentity)).digest("hex"),
  });
};
