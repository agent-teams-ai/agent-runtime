import { createHash } from "node:crypto";
import { readdir, readFile, readlink, lstat } from "node:fs/promises";
import { join, relative } from "node:path";

import type {
  FileSnapshot,
  FileSnapshotDiff,
  FileSnapshotEntry,
} from "../../model.ts";

const contentHash = async (path: string): Promise<string> => {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
};

const entryFor = async (
  root: string,
  absolutePath: string,
): Promise<FileSnapshotEntry> => {
  const stat = await lstat(absolutePath);
  const path = relative(root, absolutePath) || ".";
  const base = {
    path,
    mode: stat.mode & 0o777,
    size: stat.size,
  };

  if (stat.isDirectory()) {
    return { ...base, kind: "directory" };
  }
  if (stat.isSymbolicLink()) {
    return {
      ...base,
      kind: "symlink",
      symlinkTarget: await readlink(absolutePath),
    };
  }
  if (stat.isFile()) {
    return {
      ...base,
      kind: "file",
      contentHash: await contentHash(absolutePath),
    };
  }
  return { ...base, kind: "other" };
};

const walk = async (
  root: string,
  absolutePath: string,
  entries: FileSnapshotEntry[],
): Promise<void> => {
  const entry = await entryFor(root, absolutePath);
  entries.push(entry);

  if (entry.kind !== "directory") {
    return;
  }

  const children = await readdir(absolutePath);
  children.sort();
  for (const child of children) {
    await walk(root, join(absolutePath, child), entries);
  }
};

export const captureFileSnapshot = async (
  root: string,
): Promise<FileSnapshot> => {
  const entries: FileSnapshotEntry[] = [];
  await walk(root, root, entries);
  return { root, entries };
};

const equalEntry = (
  left: FileSnapshotEntry,
  right: FileSnapshotEntry,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const diffFileSnapshots = (
  before: FileSnapshot,
  after: FileSnapshot,
): FileSnapshotDiff => {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added: FileSnapshotEntry[] = [];
  const removed: FileSnapshotEntry[] = [];
  const changed: Array<{
    before: FileSnapshotEntry;
    after: FileSnapshotEntry;
  }> = [];

  for (const [path, entry] of afterByPath) {
    const previous = beforeByPath.get(path);
    if (previous === undefined) {
      added.push(entry);
    } else if (!equalEntry(previous, entry)) {
      changed.push({ before: previous, after: entry });
    }
  }

  for (const [path, entry] of beforeByPath) {
    if (!afterByPath.has(path)) {
      removed.push(entry);
    }
  }

  return { added, removed, changed };
};
