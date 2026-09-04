import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody";

import {
  DockerEgressJournalBusyError,
  DockerEgressJournalCapacityError,
  DockerEgressJournalConflictError,
  DockerEgressJournalCorruptionError,
  DockerEgressJournalError,
  type DockerEgressJournalFile,
  type DockerEgressJournalStorage,
  type DockerEgressStorageEntry,
  type DockerEgressTrustedRuntimeIdentity,
} from "./docker-egress-journal-types.js";
import { validateDockerEgressTrustedIdentity } from "./docker-egress-journal-codec.js";

const LOCATOR = /^[a-f0-9]{64}$/u;
const V3_PREFIX = "docker-egress-custody-v3-";
const JOURNAL_SUFFIX = ".journal";
const TOMBSTONE_SUFFIX = ".tombstone";
// This legacy named-lock residue is intentionally inert: it is ignored without
// reading PID/mtime and is never reclaimed or deleted. The process-lock cutover
// requires a fresh V3 root with no overlap with named-lock writers; this dormant
// checkpoint does not authorize production activation.
const LEGACY_LOCK_NAME = ".docker-egress-custody-v3.lock";
const V2_PREFIX = "docker-custody-v1-";

export interface DockerEgressLinuxFileSystemPort {
  readonly platform: string;
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  opendir(path: string): Promise<{ close(): Promise<void>; read(): Promise<Dirent | null> }>;
  realpath(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
}
const nodePort: DockerEgressLinuxFileSystemPort = { platform: process.platform, lstat: path => lstat(path, { bigint: true }), open, opendir, realpath, unlink };
const code = (error: unknown): string | undefined => error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
  ? error.code : undefined;
const mapped = (error: unknown): never => {
  if (error instanceof DockerEgressJournalError) { throw error; }
  if (["ENOSPC", "EDQUOT", "EFBIG"].includes(code(error) ?? "")) { throw new DockerEgressJournalCapacityError("egress storage is full"); }
  throw new DockerEgressJournalCorruptionError("egress storage is unavailable or unsafe");
};
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
const privateFile = (stats: BigIntStats, uid: bigint): void => {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid || stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n) {
    throw new DockerEgressJournalCorruptionError("unsafe journal entry");
  }
};
const privateDirectory = (stats: BigIntStats, uid: bigint): boolean =>
  stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === uid && (stats.mode & 0o077n) === 0n;

class NodeEgressFile implements DockerEgressJournalFile {
  private readonly writable: boolean;
  public byteLength: number;
  public constructor(private readonly path: string, private readonly handle: FileHandle, private readonly uid: bigint,
    private readonly port: DockerEgressLinuxFileSystemPort, initialState: Readonly<{writable: boolean; byteLength: number}>) {
    this.writable = initialState.writable; this.byteLength = initialState.byteLength;
  }
  private async identity(): Promise<BigIntStats> {
    const [opened, named] = await Promise.all([this.handle.stat({ bigint: true }), this.port.lstat(this.path)]);
    privateFile(opened, this.uid); privateFile(named, this.uid);
    if (!same(opened, named)) { throw new DockerEgressJournalCorruptionError("journal entry moved"); }
    return opened;
  }
  public async read(maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) { throw new TypeError("read bound must be non-negative"); }
    try {
      const bytes = Buffer.alloc(maxBytes + 1); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await this.handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) { break; } offset += bytesRead;
      }
      if (offset > maxBytes) { throw new DockerEgressJournalCapacityError("bounded read exceeded"); }
      const after = await this.identity();
      if (after.size !== BigInt(offset)) { throw new DockerEgressJournalConflictError("journal changed during read"); }
      return bytes.subarray(0, offset);
    } catch (error) { return mapped(error); }
  }
  public async append(expectedByteLength: number, bytes: Uint8Array): Promise<void> {
    if (!this.writable) { throw new DockerEgressJournalConflictError("read-only legacy entry"); }
    try {
      const before = await this.identity();
      if (before.size !== BigInt(expectedByteLength)) { throw new DockerEgressJournalConflictError(); }
      const buffer = Buffer.from(bytes); let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten === 0) { throw new DockerEgressJournalCorruptionError("short append"); } offset += bytesWritten;
      }
      await this.handle.datasync(); const after = await this.identity();
      if (after.size !== BigInt(expectedByteLength + buffer.length)) { throw new DockerEgressJournalConflictError("append size mismatch"); }
      this.byteLength = Number(after.size);
    } catch (error) { mapped(error); }
  }
  public async close(): Promise<void> { try { await this.handle.close(); } catch (error) { mapped(error); } }
}

interface PinnedRoot { readonly path: string; readonly handle: FileHandle; readonly stats: BigIntStats; }
export class NodeDockerEgressJournalStorage implements DockerEgressJournalStorage {
  private activeFence: string | null = null;
  private exclusivePending = false;
  private constructor(private readonly v3: PinnedRoot, private readonly v2: PinnedRoot,
    private readonly port: DockerEgressLinuxFileSystemPort) {}

  public static async open(v3Root: string, legacyV2Root: string,
    port: DockerEgressLinuxFileSystemPort = nodePort): Promise<NodeDockerEgressJournalStorage> {
    if (port.platform !== "linux") { throw new DockerEgressJournalCorruptionError("unsupported platform"); }
    if (!isAbsolute(v3Root) || !isAbsolute(legacyV2Root) || v3Root === legacyV2Root) {
      throw new TypeError("V3 and read-only V2 roots must be distinct absolute paths");
    }
    const pin = async (path: string): Promise<PinnedRoot> => {
      let handle: FileHandle | undefined;
      try {
        const canonical = await port.realpath(path); const named = await port.lstat(path);
        handle = await port.open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const held = await handle.stat({ bigint: true }); const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : named.uid;
        if (canonical !== path || !privateDirectory(named, uid) || !privateDirectory(held, uid) || !same(named, held)) {
          throw new DockerEgressJournalCorruptionError("unsafe root");
        }
        return { path, handle, stats: held };
      } catch (error) { await handle?.close().catch(() => {}); return mapped(error); }
    };
    const v3 = await pin(v3Root);
    try { return new NodeDockerEgressJournalStorage(v3, await pin(legacyV2Root), port); }
    catch (error) { await v3.handle.close().catch(() => {}); throw error; }
  }
  private path(root: PinnedRoot, name = ""): string { return `/proc/self/fd/${root.handle.fd}${name === "" ? "" : `/${name}`}`; }
  private async assertRoot(root: PinnedRoot): Promise<void> {
    try {
      const [canonical, named, held] = await Promise.all([this.port.realpath(root.path), this.port.lstat(root.path), root.handle.stat({ bigint: true })]);
      if (canonical !== root.path || !same(named, root.stats) || !same(held, root.stats) ||
          !privateDirectory(named, root.stats.uid) || !privateDirectory(held, root.stats.uid)) {
        throw new DockerEgressJournalCorruptionError("journal root changed");
      }
    } catch (error) { mapped(error); }
  }
  private fenceBytes(value: DockerEgressTrustedRuntimeIdentity): Buffer {
    const fence = validateDockerEgressTrustedIdentity(value);
    return Buffer.from(`${Object.values(fence).join("|")}\n`, "utf8");
  }
  public async exclusive<Result>(fence: DockerEgressTrustedRuntimeIdentity, operation: () => Promise<Result>): Promise<Result> {
    // flock is reentrant on this pinned descriptor, so same-instance exclusion
    // must be claimed synchronously before the first await.
    if (this.exclusivePending) { throw new DockerEgressJournalBusyError(); }
    this.exclusivePending = true;
    try {
      const expected = this.fenceBytes(fence);
      try {
        await this.assertRoot(this.v3);
        return await withStableDirectoryProcessLock(this.v3.handle, async () => {
          await this.assertRoot(this.v3);
          this.activeFence = expected.toString("hex");
          try {
            const result = await operation();
            await this.assertRoot(this.v3);
            return result;
          } finally {
            this.activeFence = null;
          }
        }, { onContention: () => { throw new DockerEgressJournalBusyError(); } });
      } catch (error) { return mapped(error); }
    } finally { this.exclusivePending = false; }
  }
  private name(locator: string, suffix: string): string {
    if (!LOCATOR.test(locator)) { throw new TypeError("invalid egress locator"); }
    return `${V3_PREFIX}${locator}${suffix}`;
  }
  private async openNamed(root: PinnedRoot, name: string, writable: boolean): Promise<NodeEgressFile> {
    let handle: FileHandle | undefined;
    try {
      const path = this.path(root, name); const named = await this.port.lstat(path); privateFile(named, root.stats.uid);
      handle = await this.port.open(path, (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
      const held = await handle.stat({ bigint: true }); privateFile(held, root.stats.uid);
      if (!same(named, held) || held.size > BigInt(Number.MAX_SAFE_INTEGER)) { throw new DockerEgressJournalCorruptionError("unsafe entry"); }
      return new NodeEgressFile(path, handle, root.stats.uid, this.port, {writable, byteLength: Number(held.size)});
    } catch (error) { await handle?.close().catch(() => {}); return mapped(error); }
  }
  public async createWithFirstRecord(locator: string, firstRecord: Uint8Array): Promise<DockerEgressJournalFile> {
    if (this.activeFence === null) { throw new DockerEgressJournalConflictError("create requires held fence lock"); }
    const name = this.name(locator, JOURNAL_SUFFIX); let handle: FileHandle | undefined;
    try {
      try {
        handle = await this.port.open(this.path(this.v3, name),
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
      } catch (error) {
        if (code(error) !== "EEXIST") { throw error; }
        const existing = await this.openNamed(this.v3, name, true);
        if (existing.byteLength !== 0) { await existing.close(); throw new DockerEgressJournalConflictError("journal exists"); }
        await existing.append(0, firstRecord); await this.v3.handle.sync(); return existing;
      }
      const file = new NodeEgressFile(this.path(this.v3, name), handle, this.v3.stats.uid, this.port, {writable: true, byteLength: 0});
      await file.append(0, firstRecord); await this.v3.handle.sync(); return file;
    } catch (error) { await handle?.close().catch(() => {}); return mapped(error); }
  }
  public async openV3(locator: string): Promise<DockerEgressJournalFile | undefined> {
    const name = this.name(locator, JOURNAL_SUFFIX);
    try { await this.port.lstat(this.path(this.v3, name)); }
    catch (error) { if (code(error) === "ENOENT") { return; } return mapped(error); }
    return this.openNamed(this.v3, name, true);
  }
  private async scan(root: PinnedRoot, maxFiles: number, classify: (name: string) => string | undefined,
    writable: boolean): Promise<readonly DockerEgressStorageEntry[]> {
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) { throw new TypeError("scan bound must be positive"); }
    await this.assertRoot(root); const names: Array<{ name: string; locator: string }> = []; let directory;
    try {
      directory = await this.port.opendir(this.path(root));
      for (;;) {
        const entry = await directory.read(); if (entry === null) { break; }
        if (root === this.v3 && entry.name === LEGACY_LOCK_NAME) { continue; }
        const locator = classify(entry.name);
        if (locator === undefined) {
          if (root === this.v3 && (this.locator(entry.name, JOURNAL_SUFFIX) !== undefined ||
              this.locator(entry.name, TOMBSTONE_SUFFIX) !== undefined)) { continue; }
          if (root === this.v3 || entry.name.startsWith(V2_PREFIX)) { throw new DockerEgressJournalCorruptionError("unknown or misplaced journal entry"); }
          continue;
        }
        if (names.length >= maxFiles) { throw new DockerEgressJournalCapacityError(); }
        names.push({ name: entry.name, locator });
      }
    } catch (error) { return mapped(error); }
    finally { await directory?.close().catch(() => {}); }
    const output: DockerEgressStorageEntry[] = [];
    try {
      for (const item of names) {
        const file = await this.openNamed(root, item.name, writable); output.push({ locatorSha256: item.locator, byteLength: file.byteLength, file });
      }
      return output;
    } catch (error) { await Promise.all(output.map(async item => item.file.close().catch(() => {}))); throw error; }
  }
  private locator(name: string, suffix: string): string | undefined {
    if (!name.startsWith(V3_PREFIX) || !name.endsWith(suffix)) { return; }
    const locator = name.slice(V3_PREFIX.length, -suffix.length); return LOCATOR.test(locator) ? locator : undefined;
  }
  public scanV3(maxFiles: number): Promise<readonly DockerEgressStorageEntry[]> {
    return this.scan(this.v3, maxFiles, name => this.locator(name, JOURNAL_SUFFIX), true);
  }
  public scanTombstones(maxFiles: number): Promise<readonly DockerEgressStorageEntry[]> {
    return this.scan(this.v3, maxFiles, name => this.locator(name, TOMBSTONE_SUFFIX), false);
  }
  public scanLegacyV2(maxFiles: number): Promise<readonly DockerEgressStorageEntry[]> {
    return this.scan(this.v2, maxFiles, name => {
      if (!name.startsWith(V2_PREFIX) || !name.endsWith(JOURNAL_SUFFIX)) { return; }
      const locator = name.slice(V2_PREFIX.length, -JOURNAL_SUFFIX.length); return LOCATOR.test(locator) ? locator : undefined;
    }, false);
  }
  public async persistTombstone(locator: string, bytes: Uint8Array, removeLive: boolean): Promise<void> {
    if (this.activeFence === null) { throw new DockerEgressJournalConflictError("tombstone requires held fence lock"); }
    const name = this.name(locator, TOMBSTONE_SUFFIX); let file: NodeEgressFile | undefined;
    try {
      try {
        const handle = await this.port.open(this.path(this.v3, name), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR |
          constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
        file = new NodeEgressFile(this.path(this.v3, name), handle, this.v3.stats.uid, this.port, {writable: true, byteLength: 0}); await file.append(0, bytes);
      } catch (error) {
        if (code(error) !== "EEXIST") { throw error; }
        file = await this.openNamed(this.v3, name, false); const present = await file.read(bytes.byteLength);
        if (!Buffer.from(present).equals(Buffer.from(bytes))) { throw new DockerEgressJournalConflictError("tombstone conflicts"); }
      }
      await this.v3.handle.sync();
      if (removeLive) {
        try { await this.port.unlink(this.path(this.v3, this.name(locator, JOURNAL_SUFFIX))); await this.v3.handle.sync(); }
        catch (error) { if (code(error) !== "ENOENT") { throw error; } }
      }
    } catch (error) { return mapped(error); }
    finally { await file?.close().catch(() => {}); }
  }
  public async close(): Promise<void> {
    if (this.exclusivePending) { throw new DockerEgressJournalBusyError(); }
    await Promise.all([this.v3.handle.close(), this.v2.handle.close()]);
  }
}
