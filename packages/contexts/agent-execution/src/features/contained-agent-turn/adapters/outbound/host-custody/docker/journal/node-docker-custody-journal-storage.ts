import { constants, type BigIntStats, type Dirent } from "node:fs";
import {
  lstat, open, opendir, realpath, unlink, type FileHandle,
} from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  DockerCustodyJournalBusyError,
  DockerCustodyJournalCapacityError,
  DockerCustodyJournalConflictError,
  DockerCustodyJournalError,
  DockerCustodyJournalFilesystemError,
  type DockerCustodyFilesystemDiagnostic,
  type DockerCustodyJournalFile,
  type DockerCustodyJournalStorage,
} from "./docker-custody-journal-types.js";

const LOCATOR = /^[a-f0-9]{64}$/u;
const FILE_PREFIX = "docker-custody-v1-";
const FILE_SUFFIX = ".journal";
const RETIREMENT_SUFFIX = ".retired";
const LOCK_NAME = ".docker-custody-v1.lock";

export interface DockerCustodyLinuxFileSystemPort {
  readonly platform: string;
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  opendir(path: string): Promise<{ close(): Promise<void>; read(): Promise<Dirent | null> }>;
  realpath(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

const nodePort: DockerCustodyLinuxFileSystemPort = {
  platform: process.platform,
  lstat: path => lstat(path, { bigint: true }),
  open,
  opendir,
  realpath,
  unlink,
};

const codeOf = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const diagnosticFor = (error: unknown): DockerCustodyFilesystemDiagnostic => {
  const code = codeOf(error);
  if (code === "EACCES" || code === "EPERM") {return "permission_denied";}
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") {return "storage_full";}
  if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR" || code === "EISDIR") {return "unsafe_entry";}
  return "io_failure";
};

const mapped = (error: unknown): never => {
  if (error instanceof DockerCustodyJournalError) {throw error;}
  throw new DockerCustodyJournalFilesystemError(diagnosticFor(error));
};

const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertPrivateFile = (stats: BigIntStats, ownerUid: bigint): void => {
  if (
    !stats.isFile() || stats.isSymbolicLink() || stats.uid !== ownerUid ||
    stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n
  ) {
    throw new DockerCustodyJournalFilesystemError("unsafe_entry");
  }
};

const isPrivateDirectory = (stats: BigIntStats, ownerUid: bigint): boolean =>
  stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === ownerUid && (stats.mode & 0o077n) === 0n;

class NodeJournalFile implements DockerCustodyJournalFile {
  public constructor(
    private readonly port: DockerCustodyLinuxFileSystemPort,
    private readonly descriptorPath: string,
    private readonly handle: FileHandle,
    private readonly ownerUid: bigint,
    public byteLength: number,
  ) {}

  private async assertNamedIdentity(): Promise<BigIntStats> {
    try {
      const opened = await this.handle.stat({ bigint: true });
      const named = await this.port.lstat(this.descriptorPath);
      if (!sameIdentity(opened, named)) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      assertPrivateFile(opened, this.ownerUid);
      assertPrivateFile(named, this.ownerUid);
      return opened;
    } catch (error) {return mapped(error);}
  }

  public async read(maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {throw new TypeError("read bound must be a non-negative integer");}
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await this.handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) {break;}
        offset += result.bytesRead;
      }
      if (offset > maxBytes) {throw new DockerCustodyJournalCapacityError("journal exceeds restart read bound");}
      const after = await this.assertNamedIdentity();
      if (after.size !== BigInt(offset)) {throw new DockerCustodyJournalConflictError("journal changed during bounded read");}
      return bytes.subarray(0, offset);
    } catch (error) {return mapped(error);}
  }

  public async append(expectedByteLength: number, bytes: Uint8Array): Promise<void> {
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {throw new TypeError("append offset must be a non-negative integer");}
    try {
      const before = await this.assertNamedIdentity();
      if (before.size !== BigInt(expectedByteLength)) {throw new DockerCustodyJournalConflictError();}
      const buffer = Buffer.from(bytes);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const result = await this.handle.write(buffer, offset, buffer.byteLength - offset);
        if (result.bytesWritten === 0) {throw new DockerCustodyJournalFilesystemError("io_failure");}
        offset += result.bytesWritten;
      }
      await this.handle.datasync();
      const after = await this.assertNamedIdentity();
      if (after.size !== BigInt(expectedByteLength + buffer.byteLength)) {
        throw new DockerCustodyJournalConflictError("journal changed during durable append");
      }
      this.byteLength = Number(after.size);
    } catch (error) {mapped(error);}
  }

  public async close(): Promise<void> {
    try {await this.handle.close();} catch (error) {mapped(error);}
  }
}

export class NodeDockerCustodyJournalStorage implements DockerCustodyJournalStorage {
  private constructor(
    private readonly root: string,
    private readonly rootHandle: FileHandle,
    private readonly rootStats: BigIntStats,
    private readonly port: DockerCustodyLinuxFileSystemPort,
  ) {}

  public static async open(
    root: string,
    port: DockerCustodyLinuxFileSystemPort = nodePort,
  ): Promise<NodeDockerCustodyJournalStorage> {
    if (port.platform !== "linux") {throw new DockerCustodyJournalFilesystemError("unsupported_platform");}
    if (typeof root !== "string" || !isAbsolute(root)) {throw new TypeError("journal root must be absolute");}
    let rootHandle: FileHandle | undefined;
    try {
      const canonical = await port.realpath(root);
      const pathStats = await port.lstat(root);
      rootHandle = await port.open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const handleStats = await rootHandle.stat({ bigint: true });
      const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : pathStats.uid;
      if (
        canonical !== root || !pathStats.isDirectory() || pathStats.isSymbolicLink() ||
        pathStats.uid !== currentUid || (pathStats.mode & 0o077n) !== 0n || !sameIdentity(pathStats, handleStats)
      ) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      return new NodeDockerCustodyJournalStorage(root, rootHandle, handleStats, port);
    } catch (error) {
      await rootHandle?.close().catch(() => {});
      return mapped(error);
    }
  }

  private descriptorPath(name = ""): string {
    return `/proc/self/fd/${this.rootHandle.fd}${name.length === 0 ? "" : `/${name}`}`;
  }

  private nameFor(locatorSha256: string): string {
    if (typeof locatorSha256 !== "string" || !LOCATOR.test(locatorSha256)) {throw new TypeError("invalid journal locator");}
    return `${FILE_PREFIX}${locatorSha256}${FILE_SUFFIX}`;
  }

  private retirementNameFor(locatorSha256: string): string {
    if (typeof locatorSha256 !== "string" || !LOCATOR.test(locatorSha256)) {throw new TypeError("invalid journal locator");}
    return `${FILE_PREFIX}${locatorSha256}${RETIREMENT_SUFFIX}`;
  }

  private async assertRootIdentity(): Promise<void> {
    try {
      const [canonical, current, pinned] = await Promise.all([
        this.port.realpath(this.root), this.port.lstat(this.root), this.rootHandle.stat({ bigint: true }),
      ]);
      if (
        canonical !== this.root || !sameIdentity(current, this.rootStats) || !sameIdentity(pinned, this.rootStats) ||
        !sameIdentity(current, pinned) || !isPrivateDirectory(current, this.rootStats.uid) ||
        !isPrivateDirectory(pinned, this.rootStats.uid)
      ) {
        throw new DockerCustodyJournalFilesystemError("root_changed");
      }
    } catch (error) {
      if (error instanceof DockerCustodyJournalFilesystemError) {throw error;}
      throw new DockerCustodyJournalFilesystemError("root_changed");
    }
  }

  public async close(): Promise<void> {
    try {await this.rootHandle.close();} catch (error) {mapped(error);}
  }

  private async releaseLock(lock: FileHandle): Promise<void> {
    try {
      const [held, named] = await Promise.all([
        lock.stat({ bigint: true }), this.port.lstat(this.descriptorPath(LOCK_NAME)),
      ]);
      if (!sameIdentity(held, named)) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      assertPrivateFile(held, this.rootStats.uid);
      assertPrivateFile(named, this.rootStats.uid);
      await this.port.unlink(this.descriptorPath(LOCK_NAME));
      await this.rootHandle.sync();
    } catch (error) {mapped(error);}
  }

  public async exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    await this.assertRootIdentity();
    let lock: FileHandle;
    try {
      lock = await this.port.open(
        this.descriptorPath(LOCK_NAME),
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (codeOf(error) === "EEXIST") {throw new DockerCustodyJournalBusyError();}
      return mapped(error);
    }
    let result: Result;
    let operationError: unknown;
    try {
      const stats = await lock.stat({ bigint: true });
      assertPrivateFile(stats, this.rootStats.uid);
      await lock.datasync();
      const named = await this.port.lstat(this.descriptorPath(LOCK_NAME));
      if (!sameIdentity(stats, named)) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      assertPrivateFile(named, this.rootStats.uid);
      await this.assertRootIdentity();
      result = await operation();
      await this.assertRootIdentity();
    } catch (error) {
      try {mapped(error);} catch (safeError) {operationError = safeError;}
    } finally {
      try {await this.releaseLock(lock);} catch (error) {if (operationError === undefined) {operationError = error;}}
      try {await lock.close();} catch (error) {operationError = new DockerCustodyJournalFilesystemError(diagnosticFor(error));}
    }
    if (operationError !== undefined) {throw operationError;}
    await this.assertRootIdentity();
    return result!;
  }

  private async observed(name: string): Promise<NodeJournalFile> {
    let handle: FileHandle | undefined;
    try {
      const path = this.descriptorPath(name);
      const named = await this.port.lstat(path);
      assertPrivateFile(named, this.rootStats.uid);
      handle = await this.port.open(path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, named)) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      assertPrivateFile(opened, this.rootStats.uid);
      const size = Number(opened.size);
      if (!Number.isSafeInteger(size)) {throw new DockerCustodyJournalCapacityError();}
      return new NodeJournalFile(this.port, path, handle, this.rootStats.uid, size);
    } catch (error) {
      try {await handle?.close();} catch (closeError) {return mapped(closeError);}
      return mapped(error);
    }
  }

  private async createNamed(name: string): Promise<DockerCustodyJournalFile> {
    let handle: FileHandle;
    try {
      handle = await this.port.open(
        this.descriptorPath(name),
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (codeOf(error) === "EEXIST") {throw new DockerCustodyJournalConflictError("journal already exists");}
      return mapped(error);
    }
    try {
      const opened = await handle.stat({ bigint: true });
      assertPrivateFile(opened, this.rootStats.uid);
      await handle.datasync();
      await this.rootHandle.sync();
      const named = await this.port.lstat(this.descriptorPath(name));
      if (!sameIdentity(opened, named)) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      assertPrivateFile(named, this.rootStats.uid);
      return new NodeJournalFile(this.port, this.descriptorPath(name), handle, this.rootStats.uid, 0);
    } catch (error) {
      try {await handle.close();} catch (closeError) {return mapped(closeError);}
      return mapped(error);
    }
  }

  public create(locatorSha256: string): Promise<DockerCustodyJournalFile> {
    return this.createNamed(this.nameFor(locatorSha256));
  }

  public async open(locatorSha256: string): Promise<DockerCustodyJournalFile | undefined> {
    const name = this.nameFor(locatorSha256);
    try {await this.port.lstat(this.descriptorPath(name));}
    catch (error) {if (codeOf(error) === "ENOENT") {return;} mapped(error);}
    return this.observed(name);
  }

  public async openRetirement(locatorSha256: string): Promise<DockerCustodyJournalFile | undefined> {
    const name = this.retirementNameFor(locatorSha256);
    try {await this.port.lstat(this.descriptorPath(name));}
    catch (error) {if (codeOf(error) === "ENOENT") {return;} mapped(error);}
    return this.observed(name);
  }

  public async retire(locatorSha256: string, receipt: Uint8Array): Promise<void> {
    const name = this.nameFor(locatorSha256);
    const retirementName = this.retirementNameFor(locatorSha256);
    let retirement = await this.openRetirement(locatorSha256);
    if (retirement === undefined) {
      try {
        retirement = await this.createNamed(retirementName);
        await retirement.append(0, receipt);
      } catch (error) {
        await retirement?.close().catch(() => {});
        if (!(error instanceof DockerCustodyJournalConflictError)) {throw error;}
        retirement = await this.openRetirement(locatorSha256);
        if (retirement === undefined) {throw error;}
      }
    }
    try {
      const durable = await retirement.read(receipt.byteLength);
      if (!Buffer.from(durable).equals(Buffer.from(receipt))) {
        throw new DockerCustodyJournalConflictError("retirement receipt conflicts");
      }
    } finally {await retirement.close();}
    let handle: FileHandle | undefined;
    try {
      const path = this.descriptorPath(name);
      const named = await this.port.lstat(path);
      assertPrivateFile(named, this.rootStats.uid);
      handle = await this.port.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, named)) {throw new DockerCustodyJournalFilesystemError("unsafe_entry");}
      assertPrivateFile(opened, this.rootStats.uid);
      await this.port.unlink(path);
      await this.rootHandle.sync();
    } catch (error) {
      if (codeOf(error) !== "ENOENT") {mapped(error);}
    }
    finally {
      try {await handle?.close();} catch (error) {mapped(error);}
    }
  }

  public async scan(maxFiles: number): Promise<readonly { readonly locatorSha256: string; readonly file: DockerCustodyJournalFile }[]> {
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {throw new TypeError("scan bound must be a positive integer");}
    const names: string[] = [];
    let directory: { close(): Promise<void>; read(): Promise<Dirent | null> } | undefined;
    let scanError: unknown;
    try {
      directory = await this.port.opendir(this.descriptorPath());
      for (;;) {
        const entry = await directory.read();
        if (entry === null) {break;}
        const retirementLocator = entry.name.slice(FILE_PREFIX.length, -RETIREMENT_SUFFIX.length);
        if (entry.name === LOCK_NAME || (
          entry.name.startsWith(FILE_PREFIX) && entry.name.endsWith(RETIREMENT_SUFFIX) && LOCATOR.test(retirementLocator)
        )) {continue;}
        if (names.length >= maxFiles) {throw new DockerCustodyJournalCapacityError("restart journal file bound exceeded");}
        names.push(entry.name);
      }
    } catch (error) {
      try {mapped(error);} catch (safeError) {scanError = safeError;}
    } finally {
      if (directory !== undefined) {
        try {await directory.close();} catch (error) {
          scanError = new DockerCustodyJournalFilesystemError(diagnosticFor(error));
        }
      }
    }
    if (scanError !== undefined) {throw scanError;}
    const results: { locatorSha256: string; file: DockerCustodyJournalFile }[] = [];
    try {
      for (const name of names.toSorted()) {
        const locatorSha256 = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
        if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX) || !LOCATOR.test(locatorSha256)) {
          throw new DockerCustodyJournalFilesystemError("unsafe_entry");
        }
        results.push({ locatorSha256, file: await this.observed(name) });
      }
      return Object.freeze(results);
    } catch (error) {
      for (const result of results) {await result.file.close();}
      throw error;
    }
  }
}
