import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openStablePath, withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody/composition";
import { v4Digest } from "./host-http-egress-v4-codec.js";
import { HOST_HTTP_EGRESS_V4_LIMITS as LIMITS, HostHttpEgressV4Error, type HostHttpEgressV4Storage } from "./host-http-egress-v4-types.js";

/** Narrow filesystem seam for synthetic short-write/fsync/identity-loss tests. */
export interface HostHttpEgressV4FileSystem {
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  opendir(path: string): Promise<{ read(): Promise<Dirent | null>; close(): Promise<void> }>;
}
const nodeFiles: HostHttpEgressV4FileSystem = { lstat: path => lstat(path, { bigint: true }), realpath, open, opendir };
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const safeFile = (s: BigIntStats): boolean => s.isFile() && s.nlink === 1n && s.uid === BigInt(process.getuid!()) && (s.mode & 0o7777n) === 0o600n;
const safeRoot = (s: BigIntStats): boolean => s.isDirectory() && s.uid === BigInt(process.getuid!()) && (s.mode & 0o7777n) === 0o700n;
const quarantine = (): HostHttpEgressV4Error => new HostHttpEgressV4Error("quarantined");

/**
 * Inert constructor. prepare holds the existing kernel directory lock until close.
 * One dedicated V4 directory, one operation, one generation for its entire life.
 * No unlink/rewrite/legacy import path exists. Logical byte reservations cannot
 * guarantee filesystem quota; any failed durability acknowledgement is unknown.
 */
export class HostHttpEgressV4NodeStorage implements HostHttpEgressV4Storage {
  readonly #root: string;
  readonly #fs: HostHttpEgressV4FileSystem;
  #rootHandle: FileHandle | undefined;
  #rootStats: BigIntStats | undefined;
  #file: FileHandle | undefined;
  #stamp: BigIntStats | undefined;
  #locator = "";
  #started = false;
  #unknown = false;
  #locked = false;
  #busy = false;
  #hadTombstone = false;
  #release: (() => void) | undefined;
  #held: Promise<void> | undefined;

  public constructor(root: string, filesystem: HostHttpEgressV4FileSystem = nodeFiles) {
    this.#root = root; this.#fs = filesystem;
  }
  #name(tombstone = false): string { return `host-http-egress-v4-${this.#locator}.${tombstone ? "tombstone" : "journal"}`; }
  #path(tombstone = false): string { return `/proc/self/fd/${this.#rootHandle!.fd}/${this.#name(tombstone)}`; }
  async #rootOwned(): Promise<void> {
    if (!this.#rootHandle || !this.#rootStats) { throw quarantine(); }
    const [named, held, canonical] = await Promise.all([this.#fs.lstat(this.#root),
      this.#rootHandle.stat({ bigint: true }), this.#fs.realpath(this.#root)]);
    if (canonical !== this.#root || !safeRoot(named) || !safeRoot(held) ||
      !same(named, this.#rootStats) || !same(held, this.#rootStats)) { throw quarantine(); }
  }
  public async assertOwned(): Promise<void> {
    try {
      if (!this.#locked || this.#unknown) { throw quarantine(); }
      await this.#rootOwned();
      const names = await this.#scan();
      if (names.has(this.#name(true)) !== this.#hadTombstone) { throw quarantine(); }
      if (this.#file) { await this.#fileOwned(); }
    } catch { this.#unknown = true; throw quarantine(); }
  }
  async #fileOwned(): Promise<BigIntStats> {
    const [named, held] = await Promise.all([this.#fs.lstat(this.#path()), this.#file!.stat({ bigint: true })]);
    if (!safeFile(named) || !safeFile(held) || !same(named, held) || !this.#stamp || !same(held, this.#stamp) ||
      held.size !== this.#stamp.size || held.mtimeNs !== this.#stamp.mtimeNs || held.ctimeNs !== this.#stamp.ctimeNs) { throw quarantine(); }
    return held;
  }
  async #lock(): Promise<void> {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    this.#release = release.resolve;
    this.#held = withStableDirectoryProcessLock(this.#rootHandle!, async () => {
      await this.#rootOwned(); this.#locked = true; entered.resolve();
      try { await release.promise; await this.#rootOwned(); }
      finally { this.#locked = false; }
    }, { onContention: () => { throw new HostHttpEgressV4Error("busy"); } });
    void this.#held.catch(error => { this.#unknown = true; entered.reject(error); });
    await entered.promise;
  }
  async #scan(): Promise<Set<string>> {
    const directory = await this.#fs.opendir(`/proc/self/fd/${this.#rootHandle!.fd}`);
    const names = new Set<string>();
    try {
      for (;;) {
        const entry = await directory.read(); if (entry === null) { break; }
        if (names.size >= 2 || ![this.#name(), this.#name(true)].includes(entry.name) || names.has(entry.name)) { throw quarantine(); }
        names.add(entry.name);
      }
    } finally { await directory.close(); }
    if (names.has(this.#name(true)) && !names.has(this.#name())) { throw quarantine(); }
    return names;
  }
  async #read(tombstone: boolean): Promise<Uint8Array> {
    const path = `${this.#root}/${this.#name(tombstone)}`;
    // Reuse stable file/lineage custody for the bounded read; append retains its own FD.
    return openStablePath(path, path, async opened => {
      const max = tombstone ? LIMITS.maxRecordBytes : LIMITS.maxBytes;
      if (!safeFile(opened.stats) || opened.stats.size <= 0n || opened.stats.size > BigInt(max)) { throw quarantine(); }
      const bytes = Buffer.alloc(Number(opened.stats.size)); let offset = 0;
      while (offset < bytes.length) {
        const read = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) { throw quarantine(); } offset += read.bytesRead;
      }
      const after = await opened.handle.stat({ bigint: true });
      if (after.size !== opened.stats.size || after.mtimeNs !== opened.stats.mtimeNs || after.ctimeNs !== opened.stats.ctimeNs) { throw quarantine(); }
      if (!tombstone) {
        this.#file = await this.#fs.open(this.#path(), constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        this.#stamp = after; await this.#fileOwned();
      }
      return bytes;
    }, { custodyBoundary: { absolutePath: this.#root, canonicalPath: this.#root } });
  }
  public async prepare(locatorSha256: string): Promise<Readonly<{ journal: Uint8Array | null; tombstone: Uint8Array | null }>> {
    if (this.#started) { throw new HostHttpEgressV4Error("conflict"); } this.#started = true;
    try {
      this.#locator = v4Digest(locatorSha256);
      if (process.platform !== "linux" || !isAbsolute(this.#root) || await this.#fs.realpath(this.#root) !== this.#root) { throw quarantine(); }
      this.#rootStats = await this.#fs.lstat(this.#root);
      if (!safeRoot(this.#rootStats)) { throw quarantine(); }
      this.#rootHandle = await this.#fs.open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await this.#rootOwned(); await this.#lock();
      const names = await this.#scan();
      this.#hadTombstone = names.has(this.#name(true));
      const journal = names.has(this.#name()) ? await this.#read(false) : null;
      const tombstone = names.has(this.#name(true)) ? await this.#read(true) : null;
      await this.assertOwned(); return Object.freeze({ journal, tombstone });
    } catch (error) {
      this.#unknown = true; await this.close().catch(() => {});
      throw error instanceof HostHttpEgressV4Error ? error : quarantine();
    }
  }
  async #durableWrite(handle: FileHandle, path: string, bytes: Uint8Array, expectedSize: number): Promise<BigIntStats> {
    const before = await handle.stat({ bigint: true });
    if (!safeFile(before) || before.size !== BigInt(expectedSize)) { throw quarantine(); }
    const { bytesWritten } = await handle.write(bytes);
    if (bytesWritten !== bytes.length) { throw quarantine(); }
    await handle.sync(); await this.#rootHandle!.sync(); await this.#rootOwned();
    const [after, named] = await Promise.all([handle.stat({ bigint: true }), this.#fs.lstat(path)]);
    if (!safeFile(after) || !safeFile(named) || !same(before, after) || !same(after, named) ||
      after.size !== BigInt(expectedSize + bytes.length)) { throw quarantine(); }
    return after;
  }
  public async append(expectedBytes: number, input: Uint8Array): Promise<void> {
    if (this.#busy) { throw new HostHttpEgressV4Error("busy"); } this.#busy = true;
    try {
      if (input.length === 0 || input.length > LIMITS.maxRecordBytes || !Number.isSafeInteger(expectedBytes) ||
        expectedBytes < 0 || expectedBytes + input.length > LIMITS.maxBytes) { throw quarantine(); }
      const bytes = Uint8Array.from(input); await this.assertOwned();
      if (!this.#file) {
        if (expectedBytes !== 0 || (await this.#scan()).size !== 0) { throw quarantine(); }
        this.#file = await this.#fs.open(this.#path(), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR |
          constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      }
      this.#stamp = await this.#durableWrite(this.#file, this.#path(), bytes, expectedBytes);
    } catch { this.#unknown = true; throw quarantine(); }
    finally { this.#busy = false; }
  }
  public async tombstone(input: Uint8Array): Promise<void> {
    if (this.#busy) { throw new HostHttpEgressV4Error("busy"); } this.#busy = true;
    let handle: FileHandle | undefined;
    try {
      if (!this.#locked || !input.length || input.length > LIMITS.maxRecordBytes) { throw quarantine(); }
      const bytes = Uint8Array.from(input); await this.#rootOwned();
      handle = await this.#fs.open(this.#path(true), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await this.#durableWrite(handle, this.#path(true), bytes, 0);
      this.#hadTombstone = true;
    } catch { this.#unknown = true; throw quarantine(); }
    finally { this.#busy = false; await handle?.close(); }
  }
  public async close(): Promise<void> {
    if (this.#busy) { throw new HostHttpEgressV4Error("busy"); }
    this.#release?.();
    const results = await Promise.allSettled([this.#held, this.#file?.close()]);
    this.#file = undefined; this.#locked = false;
    try { await this.#rootHandle?.close(); }
    finally { this.#rootHandle = undefined; }
    if (results.some(result => result.status === "rejected")) { this.#unknown = true; throw quarantine(); }
  }
}
