import fs, { type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import {
  CONSUMPTION_FILE, CONSUMPTION_TOMBSTONE, MAX_FRAME_BYTES, MAX_SCAN_ENTRIES,
  consumptionDigest, inspectConsumptionResidue,
} from "./host-http-consumption-format.js";

/** Created/pinned by the trusted Host outside the provider mount. No public port
 * supplies a filesystem path. The caller must retain this pin across restart;
 * reselecting an empty directory is not operation recovery. */
export interface HostHttpConsumptionDirectory {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

const sameInode = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameFileObservation = (left: BigIntStats, right: BigIntStats): boolean =>
  sameInode(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs && left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink;

const privateFile = (stats: BigIntStats, uid: bigint): void => {
  if (!stats.isFile() || stats.uid !== uid || stats.nlink !== 1n || (stats.mode & 0o7777n) !== 0o600n) {
    throw new Error("unsafe consumption file");
  }
};

const privateDirectory = (stats: BigIntStats, uid: bigint): void => {
  if (!stats.isDirectory() || stats.uid !== uid || stats.nlink < 2n || (stats.mode & 0o7777n) !== 0o700n) {
    throw new Error("unsafe consumption directory");
  }
};

export const captureConsumptionDirectory = (input: HostHttpConsumptionDirectory): HostHttpConsumptionDirectory => {
  const { path, device, inode } = input;
  if (typeof path !== "string" || path.length > 4_096 || !isAbsolute(path) || normalize(path) !== path ||
      typeof device !== "string" || !/^\d{1,20}$/u.test(device) ||
      typeof inode !== "string" || !/^[1-9]\d{0,19}$/u.test(inode)) {
    throw new Error("invalid consumption directory pin");
  }
  return Object.freeze({ path, device, inode });
};

// Node has no synchronous FileHandle.read. Use the held descriptor; never open
// the append path anew at the first-byte boundary. The syscall count is bounded
// independently of byte bounds, including positive short reads/writes.
const readBounded = (fd: number, maxBytes: number): Buffer => {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  for (let calls = 0; calls < 32; calls += 1) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) { return bytes.subarray(0, offset); }
    if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) {
      throw new Error("invalid consumption read");
    }
    offset += count;
    if (offset > maxBytes) { throw new Error("consumption read exceeds capacity"); }
  }
  throw new Error("consumption read syscall capacity");
};

const writeComplete = (fd: number, bytes: Buffer): void => {
  let offset = 0;
  let short = false;
  for (let calls = 0; offset < bytes.length && calls < 32; calls += 1) {
    const remaining = bytes.length - offset;
    const count = fs.writeSync(fd, bytes, offset, remaining, null);
    if (!Number.isSafeInteger(count) || count <= 0 || count > remaining) {
      throw new Error("incomplete consumption write");
    }
    short ||= count < remaining;
    offset += count;
  }
  if (offset !== bytes.length) { throw new Error("consumption write syscall capacity"); }
  fs.fdatasyncSync(fd);
  // Even an eventually completed short write burns admission. A caller never
  // retries after any potentially consumed key or ambiguous acknowledgement.
  if (short) { throw new Error("short consumption write"); }
};

const fdInfo = (fd: number): string => {
  const info = fs.openSync(`/proc/self/fdinfo/${fd}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return readBounded(info, 16_384).toString("utf8"); }
  finally { fs.closeSync(info); }
};

const mountFrom = (info: string): string => {
  const matches = [...info.matchAll(/^mnt_id:\s*(\d+)$/gmu)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) { throw new Error("consumption mount unavailable"); }
  return matches[0][1];
};

const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

export class HostHttpConsumptionStorage {
  private file: number | undefined;
  private fileIdentity: BigIntStats | undefined;
  private rootSnapshot: BigIntStats;
  private fileSnapshot: BigIntStats | undefined;
  private expectedDigest = consumptionDigest("");
  private byteLength = 0;
  private closed = false;

  private constructor(
    public readonly directory: FileHandle,
    private readonly pin: HostHttpConsumptionDirectory,
    private readonly identity: BigIntStats,
    private readonly maxBytes: number,
    private readonly mount: string,
  ) {
    this.rootSnapshot = identity;
  }

  public static async open(pin: HostHttpConsumptionDirectory, maxBytes: number): Promise<HostHttpConsumptionStorage> {
    if (process.platform !== "linux" || typeof process.getuid !== "function" ||
        fs.constants.O_NOFOLLOW === undefined || fs.constants.O_DIRECTORY === undefined) {
      throw new Error("consumption platform unsupported");
    }
    const uid = BigInt(process.getuid());
    const named = fs.lstatSync(pin.path, { bigint: true });
    privateDirectory(named, uid);
    if (String(named.dev) !== pin.device || String(named.ino) !== pin.inode || fs.realpathSync(pin.path) !== pin.path) {
      throw new Error("consumption root pin mismatch");
    }
    const directory = await open(pin.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
      const held = fs.fstatSync(directory.fd, { bigint: true });
      privateDirectory(held, uid);
      if (!sameInode(held, named)) { throw new Error("consumption root changed on open"); }
      const storage = new HostHttpConsumptionStorage(directory, pin, held, maxBytes, mountFrom(fdInfo(directory.fd)));
      storage.assertRoot(false);
      return storage;
    } catch (error) { await directory.close(); throw error; }
  }

  private path(name: string): string { return `/proc/self/fd/${this.directory.fd}/${name}`; }

  private assertHeldRoot(): BigIntStats {
    if (this.closed) { throw new Error("consumption storage closed"); }
    const held = fs.fstatSync(this.directory.fd, { bigint: true });
    privateDirectory(held, this.identity.uid);
    if (!sameInode(held, this.identity)) { throw new Error("consumption descriptor changed"); }
    return held;
  }

  private assertRoot(locked = true): void {
    const held = this.assertHeldRoot();
    const named = fs.lstatSync(this.pin.path, { bigint: true });
    privateDirectory(named, this.identity.uid);
    if (!sameInode(named, this.identity) || fs.realpathSync(this.pin.path) !== this.pin.path ||
        held.nlink !== this.rootSnapshot.nlink || held.mtimeNs !== this.rootSnapshot.mtimeNs ||
        held.ctimeNs !== this.rootSnapshot.ctimeNs) { throw new Error("consumption root drift"); }
    const info = fdInfo(this.directory.fd);
    if (mountFrom(info) !== this.mount) { throw new Error("consumption mount changed"); }
    if (locked) {
      const locks = [...info.matchAll(/^lock:\s*\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s+0 EOF$/gmu)];
      if (locks.length !== 1 || locks[0]?.[1] !== String(process.pid) || locks[0]?.[2] !== String(held.ino)) {
        throw new Error("consumption directory lock lost");
      }
    }
  }

  /** Streaming scan: at most two entries, one overflow observation, and bounded
   * private file reads. Any entry, including an empty/torn/foreign generation,
   * irreversibly selects reconciliation. No executable index is reconstructed. */
  public hasResidue(): boolean {
    this.assertRoot();
    const directory = fs.opendirSync(`/proc/self/fd/${this.directory.fd}`, { bufferSize: 1 });
    let count = 0;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) { break; }
        count += 1;
        if (count > MAX_SCAN_ENTRIES) { throw new Error("consumption scan capacity"); }
        if (![CONSUMPTION_FILE, CONSUMPTION_TOMBSTONE].includes(entry.name)) {
          throw new Error("unexpected consumption residue");
        }
        this.inspectResidue(entry.name);
      }
    } finally { directory.closeSync(); }
    this.assertRoot();
    return count !== 0;
  }

  private inspectResidue(name: string): void {
    const path = this.path(name);
    const named = fs.lstatSync(path, { bigint: true });
    privateFile(named, this.identity.uid);
    const limit = name === CONSUMPTION_FILE ? this.maxBytes : MAX_FRAME_BYTES;
    if (named.size > BigInt(limit)) { throw new Error("consumption residue capacity"); }
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const held = fs.fstatSync(fd, { bigint: true });
      privateFile(held, this.identity.uid);
      if (!sameInode(held, named)) { throw new Error("consumption residue changed"); }
      const bytes = readBounded(fd, limit);
      inspectConsumptionResidue(bytes, 257);
      const after = fs.fstatSync(fd, { bigint: true });
      if (after.size !== BigInt(bytes.length) || after.ctimeNs !== held.ctimeNs ||
          !sameInode(after, fs.lstatSync(path, { bigint: true }))) { throw new Error("consumption residue drift"); }
    } finally { fs.closeSync(fd); }
  }

  public create(header: Buffer): void {
    this.assertRoot();
    if (header.length > MAX_FRAME_BYTES || header.length > this.maxBytes) { throw new Error("consumption header capacity"); }
    this.file = fs.openSync(this.path(CONSUMPTION_FILE), fs.constants.O_CREAT | fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW | fs.constants.O_RDWR | fs.constants.O_APPEND, 0o600);
    this.fileIdentity = fs.fstatSync(this.file, { bigint: true });
    privateFile(this.fileIdentity, this.identity.uid);
    this.rootSnapshot = this.assertHeldRoot();
    this.assertFile(0);
    writeComplete(this.file, header);
    fs.fsyncSync(this.directory.fd);
    this.assertRoot();
    this.acceptBytes(header);
  }

  private assertFile(length: number): BigIntStats {
    if (this.file === undefined || this.fileIdentity === undefined) { throw new Error("consumption file absent"); }
    const held = fs.fstatSync(this.file, { bigint: true });
    const named = fs.lstatSync(this.path(CONSUMPTION_FILE), { bigint: true });
    privateFile(held, this.identity.uid);
    privateFile(named, this.identity.uid);
    if (!sameInode(held, this.fileIdentity) || !sameInode(held, named) || held.size !== BigInt(length)) {
      throw new Error("consumption file identity drift");
    }
    return held;
  }

  private readIntact(): Buffer {
    this.assertRoot();
    const current = this.assertFile(this.byteLength);
    const bytes = readBounded(this.file!, this.byteLength);
    if (this.fileSnapshot === undefined || !sameFileObservation(current, this.fileSnapshot) ||
        !sameFileObservation(current, this.assertFile(this.byteLength)) || consumptionDigest(bytes) !== this.expectedDigest) {
      throw new Error("consumption tail corrupt");
    }
    this.assertRoot();
    // Detect a preexisting tombstone without following it or allocating data.
    try { fs.lstatSync(this.path(CONSUMPTION_TOMBSTONE)); }
    catch (error) { if (isMissing(error)) { return bytes; } throw error; }
    throw new Error("consumption already sealed");
  }

  public assertIntact(): void { this.readIntact(); }

  private acceptBytes(expected: Buffer): void {
    const after = this.assertFile(expected.length);
    if (consumptionDigest(readBounded(this.file!, expected.length)) !== consumptionDigest(expected) ||
        !sameFileObservation(after, this.assertFile(expected.length))) {
      throw new Error("consumption postwrite bytes mismatch");
    }
    this.assertRoot();
    this.byteLength = expected.length;
    this.expectedDigest = consumptionDigest(expected);
    this.fileSnapshot = after;
  }

  public append(record: Buffer): void {
    const previous = this.readIntact();
    if (record.length > this.remainingBytes) { throw new Error("consumption byte capacity"); }
    // The entire bounded tail is checked before and after every append. This is
    // deliberately finite (256 uses); the in-memory index never repairs disk.
    const expected = Buffer.concat([previous, record], this.byteLength + record.length);
    writeComplete(this.file!, record);
    this.acceptBytes(expected);
  }

  public get remainingBytes(): number { return this.maxBytes - this.byteLength; }

  public persistTombstone(bytes: Buffer): boolean {
    let fd: number | undefined;
    let persisted = false;
    try {
      // On pathname replacement retain evidence in the pinned old directory.
      // Never follow/recreate the replacement and never truncate old evidence.
      this.assertHeldRoot();
      if (bytes.length > MAX_FRAME_BYTES) { return false; }
      fd = fs.openSync(this.path(CONSUMPTION_TOMBSTONE), fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW | fs.constants.O_RDWR | fs.constants.O_APPEND, 0o600);
      const before = fs.fstatSync(fd, { bigint: true });
      privateFile(before, this.identity.uid);
      writeComplete(fd, bytes);
      fs.fsyncSync(this.directory.fd);
      const after = fs.fstatSync(fd, { bigint: true });
      privateFile(after, this.identity.uid);
      if (!sameInode(before, after) || !sameInode(after, fs.lstatSync(this.path(CONSUMPTION_TOMBSTONE), { bigint: true })) ||
          !readBounded(fd, bytes.length).equals(bytes)) { return false; }
      this.rootSnapshot = this.assertHeldRoot();
      this.assertRoot();
      persisted = true;
    } catch { return false; }
    finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); }
        // Close may have consumed the descriptor before failing. Withhold the
        // seal acknowledgement; never retry a possibly reused descriptor.
        catch { persisted = false; }
      }
    }
    return persisted;
  }

  public async close(): Promise<void> {
    this.closed = true;
    try { if (this.file !== undefined) { fs.closeSync(this.file); } }
    finally { this.file = undefined; await this.directory.close(); }
  }
}
