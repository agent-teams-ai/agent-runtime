import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

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
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const visit = async (directory, prefix, depth) => {
    if (depth > 32) {throw new Error("candidate tree exceeds depth limit");}
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      const path = `${directory}/${name}`;
      const key = `${prefix}${name}`;
      const entry = await lstat(path);
      if (entry.isDirectory()) {await visit(path, `${key}/`, depth + 1); continue;}
      files += 1;
      if (files > 200_000) {throw new Error("candidate tree exceeds file limit");}
      if (entry.isSymbolicLink()) {
        if (dependencyRepository === undefined || !inside(dependencyRepository, await realpath(path))) {
          throw new Error("candidate tree contains an unauthorized symbolic link");
        }
        hash.update(JSON.stringify([key, "link", await readlink(path)]));
        continue;
      }
      if (!entry.isFile()) {throw new Error("candidate tree contains a non-regular entry");}
      bytes += entry.size;
      if (bytes > 4 * 1024 ** 3) {throw new Error("candidate tree exceeds byte limit");}
      hash.update(JSON.stringify([key, "file", entry.mode & 0o111, entry.size]));
      for await (const chunk of createReadStream(path)) {hash.update(chunk);}
    }
  };
  await visit(root, "", 0);
  if (files === 0) {throw new Error("candidate tree is empty");}
  return Object.freeze({bytes, files, treeDigest: hash.digest("hex")});
};
