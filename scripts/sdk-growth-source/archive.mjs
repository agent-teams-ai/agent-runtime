import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const MAX_TGZ = 16 * 1024 * 1024;
const MAX_TAR = 64 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_MEMBERS = 256;
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex");

export function readBoundedArchive(path, read = readSync) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size === 0n || stat.size > BigInt(MAX_TGZ)) { throw new Error("archive: regular compressed file within size limit required"); }
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_TGZ + 1 - size));
      const count = read(descriptor, chunk, 0, chunk.length, size);
      if (count === 0) { break; }
      size += count;
      if (size > MAX_TGZ) { throw new Error("archive: compressed size limit during read"); }
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (BigInt(size) !== stat.size || stat.dev !== after.dev || stat.ino !== after.ino ||
        stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) {
      throw new Error("archive: changed during read");
    }
    return Buffer.concat(chunks, size);
  } finally { closeSync(descriptor); }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(",")}]`; }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const zero = bytes.indexOf(0);
  return bytes.subarray(0, zero < 0 ? bytes.length : zero).toString("utf8");
}

function octal(header, start, length) {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/u.test(value)) { throw new Error("archive: invalid octal field"); }
  return Number.parseInt(value, 8);
}

function memberPath(name) {
  if (!name.startsWith("package/") || name.endsWith("/") || name.length > 240 ||
      /[^\x20-\x7e]|[\\:<>"?*|]/u.test(name) ||
      name.split("/").some(part => !part || part === "." || part === ".." ||
        /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error(`archive: unsafe path ${JSON.stringify(name)}`);
  }
  return name.slice("package/".length);
}

function archiveMember(header, offset, tarLength, count) {
  const expected = octal(header, 148, 8);
  const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (expected !== actual) { throw new Error("archive: header checksum mismatch"); }
  if (field(header, 257, 6) !== "ustar") { throw new Error("archive: unsupported header extension"); }
  const kind = header[156];
  if (kind !== 0 && kind !== 48) { throw new Error("archive: links and nonregular members forbidden"); }
  if (field(header, 157, 100)) { throw new Error("archive: link target forbidden"); }
  const prefix = field(header, 345, 155);
  const path = memberPath(`${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`);
  const size = octal(header, 124, 12);
  if (!Number.isSafeInteger(size) || size > MAX_FILE || count >= MAX_MEMBERS) { throw new Error("archive: member size or count limit"); }
  const next = offset + 512 + Math.ceil(size / 512) * 512;
  if (next > tarLength) { throw new Error("archive: truncated member"); }
  return { path, size, next };
}

function recordMemberPath(path, folded, directories) {
  const lower = path.toLowerCase();
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const directory = parts.slice(0, i).join("/");
    const alias = directories.get(directory.toLowerCase());
    if (alias && alias !== directory) { throw new Error("archive: directory case collision"); }
    directories.set(directory.toLowerCase(), directory);
  }
  if (folded.has(lower) || [...folded].some(existing => lower.startsWith(`${existing}/`) || existing.startsWith(`${lower}/`))) {
    throw new Error("archive: duplicate or path collision");
  }
  folded.add(lower);
}

export function inspectArchive(tgz) {
  if (!Buffer.isBuffer(tgz) || tgz.length > MAX_TGZ || tgz.length === 0) { throw new Error("archive: compressed size limit"); }
  const tar = gunzipSync(tgz, { maxOutputLength: MAX_TAR });
  const files = new Map();
  const folded = new Set();
  const directories = new Map();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const { path, size, next } = archiveMember(header, offset, tar.length, files.size);
    recordMemberPath(path, folded, directories);
    files.set(path, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset = next;
  }
  if (!ended || tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) {
    throw new Error("archive: malformed trailer");
  }
  const ordered = [...files].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const payload = canonicalJson({ schemaVersion: "foundation:sdk-growth:archive:1",
    files: ordered.map(([path, bytes]) => ({ path, contentHex: bytes.toString("hex") })) });
  const canonical = Buffer.from(payload);
  return {
    files,
    transport: { sha256: hash("sha256", tgz), integrity: `sha512-${hash("sha512", tgz)}` },
    canonical: { schemaVersion: "foundation:sdk-growth:archive:1", sha256: hash("sha256", canonical),
      integrity: `sha512-${hash("sha512", canonical)}`, payload,
      members: ordered.map(([path, bytes]) => ({ path, sha256: hash("sha256", bytes), size: bytes.length })) },
  };
}
