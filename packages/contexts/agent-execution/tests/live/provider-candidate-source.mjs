import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inside, sha256 } from "./provider-candidate-build-tree.mjs";
import { candidateFileBytes } from "./provider-candidate-file-read.mjs";

export const execFileAsync = promisify(execFile);
export const buildEnvironment = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  LC_ALL: "C", PATH: "/usr/local/bin:/usr/bin:/bin",
});
export const git = async (root, args) => {
  try {
    return (await execFileAsync("/usr/bin/git", [
      "-c", "core.excludesFile=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-C", root, ...args,
    ], {env: buildEnvironment, timeout: 10_000, maxBuffer: 8 * 1024 ** 2})).stdout;
  } catch {throw new Error("canary execution provenance is unavailable");}
};

export const sourceSnapshot = async (authorityUrl, claimedSourceSha) => {
  if (typeof claimedSourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(claimedSourceSha)) {
    throw new TypeError("canary source SHA must be exact");
  }
  const root = await realpath((await git(dirname(fileURLToPath(authorityUrl)), ["rev-parse", "--show-toplevel"])).trim());
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (head !== claimedSourceSha) {throw new Error("canary source SHA does not match executed checkout");}
  if ((await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).length) {
    throw new Error("canary source checkout is dirty");
  }
  const entries = (await git(root, ["ls-tree", "-rz", "--full-tree", head])).split("\0").filter(Boolean);
  const files = new Map();
  const tree = createHash("sha256");
  let total = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if (match === null) {throw new Error("source closure requires regular tracked files");}
    const [, mode, blob, path] = match;
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if ((stat.mode & 0o111) !== (mode === "100755" ? 0o111 : 0)) {
      throw new Error("source mode does not match exact HEAD");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, await realpath(absolute))) {
      throw new Error("source closure escaped checkout");
    }
    total += stat.size;
    if (total > 256 * 1024 ** 2 || entries.length > 25_000) {throw new Error("source closure exceeds limit");}
    const bytes = await candidateFileBytes(absolute, stat.size);
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== blob) {throw new Error("source bytes do not match exact HEAD");}
    tree.update(JSON.stringify([path, mode, sha256(bytes)]));
    files.set(path, Object.freeze({bytes, mode: mode === "100755" ? 0o755 : 0o644}));
  }
  return {root, head, files, treeDigest: tree.digest("hex")};
};

export const sourceFileDigest = (snapshot, url) => {
  const absolute = fileURLToPath(url);
  for (const [path, file] of snapshot.files) {
    if (join(snapshot.root, path) === absolute) {return sha256(file.bytes);}
  }
  throw new Error("executed canary implementation is absent from source commit");
};
