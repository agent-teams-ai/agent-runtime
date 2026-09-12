import {constants} from "node:fs";
import {lstat, open, readdir, realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import {isAbsolute, join, parse, resolve} from "node:path";

export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const metadata = (s: Awaited<ReturnType<typeof lstat>>): string => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.size, s.mtimeMs, s.ctimeMs].join(":");
/** Reject links in every component. This is cooperative same-uid validation, not hostile containment. */
export async function directory(path: string, owned = false): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {throw new Error("ordinary_path_not_canonical");}
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {throw new Error("ordinary_directory_link_or_type");}
  }
  if (await realpath(path) !== path) {throw new Error("ordinary_path_escape");}
  const stat = await lstat(path);
  if (owned && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {throw new Error("ordinary_root_not_private_owned");}
  return path;
}
export async function readStable(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()) {throw new Error("ordinary_file_link_or_type");}
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (metadata(before) !== metadata(await handle.stat())) {throw new Error("ordinary_file_replaced");}
    if (before.size > 16 * 1024 * 1024) {throw new Error("ordinary_file_size_limit");}
    const bytes = await handle.readFile();
    if (metadata(before) !== metadata(await handle.stat()) || metadata(before) !== metadata(await lstat(path))) {throw new Error("ordinary_file_mutated");}
    return bytes;
  } finally { await handle.close(); }
}
export interface Inventory {readonly metadataDigest: string; readonly contentDigest: string; readonly files: ReadonlyMap<string, Buffer>; readonly directories: readonly string[]}
export async function inventory(root: string): Promise<Inventory> {
  await directory(root);
  const facts: string[] = [], contents: string[] = [], directories: string[] = [];
  const files = new Map<string, Buffer>();
  let totalBytes = 0, entries = 0;
  const walk = async (relative: string): Promise<void> => {
    const path = join(root, relative), before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.()) {throw new Error("ordinary_inventory_directory");}
    facts.push(`${relative}:${metadata(before)}`);
    for (const name of (await readdir(path)).toSorted()) {
      if (++entries > 4096) {throw new Error("ordinary_inventory_entry_limit");}
      const child = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, child));
      if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(child); await walk(child); }
      else {
        const bytes = await readStable(join(root, child));
        totalBytes += bytes.length;
        if (totalBytes > 64 * 1024 * 1024) {throw new Error("ordinary_inventory_byte_limit");}
        facts.push(`${child}:${metadata(stat)}`); contents.push(`${JSON.stringify(child)}:${digest(bytes)}`); files.set(child, bytes);
      }
    }
    if (metadata(before) !== metadata(await lstat(path))) {throw new Error("ordinary_inventory_mutated");}
  };
  await walk("");
  return {metadataDigest: digest(JSON.stringify(facts)), contentDigest: digest(JSON.stringify({directories, contents})), files, directories};
}
export async function writeSynced(path: string, bytes: Uint8Array | string, mode = 0o600): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
