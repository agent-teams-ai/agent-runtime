import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import {
  publishStableDirectoryNoReplace,
  StableDirectoryPublicationUnsupportedError,
  withStableDirectoryProcessLock,
} from "@agent-teams/filesystem-custody";
import { ContainedTurnFilesystemUnsupportedError } from "./contained-turn-filesystem-error.js";

import {
  assertSameMountIdentity,
  descriptorChildPath,
  fsyncDirectoryHandle,
} from "./contained-turn-filesystem-custody.js";
import { readDirectoryNamesBounded } from "./contained-turn-filesystem-reads.js";

type DurableOpenFile = (path: string, flags: number, mode: number) => Promise<FileHandle>;

export interface ContainedTurnFilesystemFaults {
  checkpoint(point: string): Promise<void> | void;
  openFile?: DurableOpenFile;
  writeFile?(handle: FileHandle, bytes: Buffer): Promise<void>;
}

const UUID_V4 = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u;

const isFilesystemCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const sameStableFile = (
  left: BigIntStats,
  right: BigIntStats,
): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
  left.nlink === right.nlink && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

export const readStableFileAt = async (
  parent: FileHandle,
  name: string,
  maxBytes: number,
): Promise<Buffer> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("contained turn stable read limit is invalid");
  }
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {throw new Error("contained turn no-follow reads are unsupported");}
  const handle = await open(
    descriptorChildPath(parent, name),
    constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
  );
  try {
    await assertSameMountIdentity(parent, handle);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw new Error("contained turn stable file is not a bounded single-link regular file");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const capacity = Math.min(64 * 1_024, maxBytes + 1 - total);
      if (capacity === 0) {break;}
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, null);
      if (bytesRead === 0) {break;}
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {throw new Error("contained turn stable file exceeded its read limit");}
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() || after.nlink !== 1n || !sameStableFile(before, after) ||
      after.size !== BigInt(total)
    ) {
      throw new Error("contained turn stable file changed while it was read");
    }
    const current = await open(
      descriptorChildPath(parent, name),
      constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
    );
    try {
      await assertSameMountIdentity(parent, current);
      const currentObservation = await current.stat({ bigint: true });
      if (!sameStableFile(after, currentObservation)) {
        throw new Error("contained turn stable file is no longer the canonical directory entry");
      }
    } finally {await current.close();}
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
};

const throwWithCleanup = (primary: unknown, cleanup: readonly unknown[]): never => {
  if (cleanup.length === 0) {throw primary;}
  throw new AggregateError([primary, ...cleanup], "contained turn durable write and cleanup failed");
};

const publishStagedFile = async (
  stagingDirectory: FileHandle,
  temporaryName: string,
  finalDirectory: FileHandle,
  finalName: string,
  expectedSourceIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>,
): Promise<"created" | "existing"> => {
  try {
    const outcome = await publishStableDirectoryNoReplace({
      destinationDirectory: finalDirectory,
      destinationName: finalName,
      expectedSourceIdentity,
      sourceDirectory: stagingDirectory,
      sourceName: temporaryName,
    });
    await fsyncDirectoryHandle(stagingDirectory);
    await fsyncDirectoryHandle(finalDirectory);
    return outcome;
  } catch (error) {
    if (error instanceof StableDirectoryPublicationUnsupportedError) {
      throw new ContainedTurnFilesystemUnsupportedError(error.message);
    }
    throw error;
  }
};

const cleanupStagedWrite = async (input: {
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly handle?: FileHandle | undefined;
  readonly stagingDirectory: FileHandle;
  readonly stagingModified: boolean;
  readonly temporaryCreated: boolean;
  readonly temporaryKind: "cas" | "metadata";
  readonly temporaryName: string;
}): Promise<readonly unknown[]> => {
  const cleanup: unknown[] = [];
  if (input.handle !== undefined) {
    try {await input.handle.close();} catch (error) {cleanup.push(error);}
  }
  if (input.temporaryCreated) {
    try {
      await unlink(descriptorChildPath(input.stagingDirectory, input.temporaryName));
    } catch (error) {
      if (!isFilesystemCode(error, "ENOENT")) {cleanup.push(error);}
    }
  }
  if (input.stagingModified) {
    try {await fsyncDirectoryHandle(input.stagingDirectory);} catch (error) {cleanup.push(error);}
  }
  try {await input.faults?.checkpoint(`${input.temporaryKind}.cleaned`);} catch (error) {
    cleanup.push(error);
  }
  return cleanup;
};

const prepareTemporaryWrite = (input: {
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly temporaryId?: string | undefined;
  readonly temporaryKind: "cas" | "metadata";
}): Readonly<{
  noFollow: number;
  openFile: DurableOpenFile;
  temporaryName: string;
}> => {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {throw new Error("contained turn no-follow writes are unsupported");}
  const temporaryId = input.temporaryId ?? randomUUID();
  if (!UUID_V4.test(temporaryId)) {
    throw new TypeError("contained turn durable temporary identifier is invalid");
  }
  return Object.freeze({
    noFollow,
    openFile: input.faults?.openFile ?? open,
    temporaryName: `.ar-stage-v1-${input.temporaryKind}-${temporaryId}.tmp`,
  });
};

const writeTemporaryBytes = async (
  faults: ContainedTurnFilesystemFaults | undefined,
  handle: FileHandle,
  bytes: Buffer,
): Promise<void> => {
  if (faults?.writeFile === undefined) {await handle.writeFile(bytes);}
  else {await faults.writeFile(handle, bytes);}
};

const writeImmutableFileUnderLock = async (input: {
  readonly bytes: Buffer;
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly finalDirectory: FileHandle;
  readonly finalName: string;
  readonly stagingDirectory: FileHandle;
  readonly temporaryId?: string | undefined;
  readonly temporaryKind: "cas" | "metadata";
}): Promise<"created" | "existing"> => {
  const { noFollow, openFile, temporaryName } = prepareTemporaryWrite(input);
  let handle: FileHandle | undefined;
  let primary: unknown;
  let result: "created" | "existing" = "created";
  let sourceIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }> | undefined;
  let stagingModified = false;
  let temporaryCreated = false;
  try {
    await input.faults?.checkpoint(`${input.temporaryKind}.before-open`);
    handle = await openFile(
      descriptorChildPath(input.stagingDirectory, temporaryName),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    await assertSameMountIdentity(input.stagingDirectory, handle);
    temporaryCreated = true;
    stagingModified = true;
    await input.faults?.checkpoint(`${input.temporaryKind}.opened`);
    await writeTemporaryBytes(input.faults, handle, input.bytes);
    await input.faults?.checkpoint(`${input.temporaryKind}.written`);
    await handle.sync();
    const staged = await handle.stat({ bigint: true });
    sourceIdentity = Object.freeze({ dev: staged.dev, ino: staged.ino });
    await input.faults?.checkpoint(`${input.temporaryKind}.synced`);
    await handle.close();
    handle = undefined;
    await input.faults?.checkpoint(`${input.temporaryKind}.closed`);
    await input.faults?.checkpoint(`${input.temporaryKind}.before-publish`);
    result = await publishStagedFile(
      input.stagingDirectory,
      temporaryName,
      input.finalDirectory,
      input.finalName,
      sourceIdentity,
    );
    if (result === "created") {temporaryCreated = false;}
    await input.faults?.checkpoint(`${input.temporaryKind}.published`);
    await input.faults?.checkpoint(`${input.temporaryKind}.before-unlink`);
    if (temporaryCreated) {
      await unlink(descriptorChildPath(input.stagingDirectory, temporaryName));
      temporaryCreated = false;
    }
    await input.faults?.checkpoint(`${input.temporaryKind}.unlinked`);
    await fsyncDirectoryHandle(input.stagingDirectory);
    await input.faults?.checkpoint(`${input.temporaryKind}.staging-synced`);
    const actual = await readStableFileAt(input.finalDirectory, input.finalName, input.bytes.length);
    if (!actual.equals(input.bytes)) {
      throw new Error("contained turn content digest collision or immutable file mismatch");
    }
    await input.faults?.checkpoint(`${input.temporaryKind}.verified`);
  } catch (error) {
    primary = error;
  }
  const cleanup = await cleanupStagedWrite({
    faults: input.faults,
    handle,
    stagingDirectory: input.stagingDirectory,
    stagingModified,
    temporaryCreated,
    temporaryKind: input.temporaryKind,
    temporaryName,
  });
  if (primary !== undefined) {return throwWithCleanup(primary, cleanup);}
  if (cleanup.length > 0) {
    throw new AggregateError(cleanup, "contained turn durable write cleanup failed");
  }
  return result;
};

export const writeImmutableFileAt = async (
  input: Parameters<typeof writeImmutableFileUnderLock>[0],
): Promise<"created" | "existing"> => withStableDirectoryProcessLock(
  input.stagingDirectory,
  () => writeImmutableFileUnderLock(input),
);

const LINUX_O_PATH = 0x20_0000;

export const quarantineAmbiguousStagingDirectory = async (
  stagingDirectory: FileHandle,
  quarantineDirectory: FileHandle,
  maxEntries: number,
): Promise<number> => {
  const names = await readDirectoryNamesBounded(stagingDirectory, maxEntries);
  for (const name of names) {
    await quarantineAmbiguousStagingEntry(stagingDirectory, quarantineDirectory, name);
  }
  if (names.length > 0) {
    await fsyncDirectoryHandle(stagingDirectory);
    await fsyncDirectoryHandle(quarantineDirectory);
  }
  return names.length;
};

export const quarantineAmbiguousStagingEntry = async (
  stagingDirectory: FileHandle,
  quarantineDirectory: FileHandle,
  name: string,
): Promise<void> => {
  const handle = await open(
    descriptorChildPath(stagingDirectory, name),
    LINUX_O_PATH | constants.O_NOFOLLOW,
  );
  try {
    await assertSameMountIdentity(stagingDirectory, handle);
    const observation = await handle.stat({ bigint: true });
    const quarantineName = `.ar-ambiguous-${randomUUID()}-${name}.retained`;
    let outcome: "created" | "existing";
    try {
      outcome = await publishStableDirectoryNoReplace({
        destinationDirectory: quarantineDirectory,
        destinationName: quarantineName,
        expectedSourceIdentity: observation,
        sourceDirectory: stagingDirectory,
        sourceName: name,
      });
    } catch (error) {
      if (error instanceof StableDirectoryPublicationUnsupportedError) {
        throw new ContainedTurnFilesystemUnsupportedError(error.message);
      }
      throw error;
    }
    if (outcome !== "created") {
      throw new Error("contained turn ambiguous staging quarantine destination exists");
    }
  } finally {await handle.close();}
};

export const assertEmptyStagingDirectory = async (
  stagingDirectory: FileHandle,
  maxEntries: number,
): Promise<void> => {
  const names = await readDirectoryNamesBounded(stagingDirectory, maxEntries);
  if (names.length > 0) {
    throw new Error("contained turn staging directory contains unowned residue");
  }
};
