import { createHash } from "node:crypto";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { readCandidateFile } from "./provider-candidate-file-read.mjs";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const inside = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};

// Paths and link targets participate in the preimage but never leave the
// provenance authority. Dependencies may link only into this exact checkout.
export const digestTree = async (root, dependencyRepository) => {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("candidate tree root must be a regular directory");
  }
  root = await realpath(root);
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  let nodes = 0;
  const visited = new Set();
  const visitLink = async (path, key, depth) => {
    if (dependencyRepository === undefined || !inside(dependencyRepository, await realpath(path))) {
      throw new Error("candidate tree contains an unauthorized symbolic link");
    }
    hash.update(JSON.stringify([key, "link", await readlink(path)]));
    const target = await realpath(path);
    const targetEntry = await lstat(target);
    // Link text alone does not bind a workspace package or SDK's bytes.
    if (targetEntry.isDirectory()) {await visit(target, `${key}/`, depth + 1);}
    else if (targetEntry.isFile()) {
      bytes += targetEntry.size;
      if (bytes > 4 * 1024 ** 3) {throw new Error("candidate tree exceeds byte limit");}
      hash.update(JSON.stringify([key, "target", targetEntry.mode & 0o111, targetEntry.size]));
      await readCandidateFile(target, targetEntry.size, chunk => hash.update(chunk));
    } else {throw new Error("candidate link target is not regular");}
  };
  const visit = async (directory, prefix, depth) => {
    if (depth > 32) {throw new Error("candidate tree exceeds depth limit");}
    const canonical = await realpath(directory);
    const before = await lstat(directory);
    if (canonical !== directory || !before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("candidate directory changed during traversal");
    }
    if (visited.has(canonical)) {return;}
    visited.add(canonical);
    const entries = (await readdir(directory)).toSorted();
    for (const name of entries) {
      const path = `${directory}/${name}`;
      const key = `${prefix}${name}`;
      const entry = await lstat(path);
      nodes += 1;
      if (nodes > 200_000) {throw new Error("candidate tree exceeds entry limit");}
      if (entry.isDirectory()) {
        hash.update(JSON.stringify([key, "directory"]));
        await visit(path, `${key}/`, depth + 1); continue;
      }
      files += 1;
      if (files > 200_000) {throw new Error("candidate tree exceeds file limit");}
      if (entry.isSymbolicLink()) {
        await visitLink(path, key, depth);
        continue;
      }
      if (!entry.isFile()) {throw new Error("candidate tree contains a non-regular entry");}
      bytes += entry.size;
      if (bytes > 4 * 1024 ** 3) {throw new Error("candidate tree exceeds byte limit");}
      hash.update(JSON.stringify([key, "file", entry.mode & 0o111, entry.size]));
      await readCandidateFile(path, entry.size, chunk => hash.update(chunk));
    }
    const after = await lstat(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
        await realpath(directory) !== directory) {throw new Error("candidate directory changed during traversal");}
  };
  await visit(root, "", 0);
  if (files === 0) {throw new Error("candidate tree is empty");}
  return Object.freeze({bytes, files, treeDigest: hash.digest("hex")});
};
