import { opendir, type FileHandle } from "node:fs/promises";

import {
  descriptorChildPath,
  inspectFileHandle,
  sameFilesystemObservation,
  type ContainedTurnFilesystemIdentity,
} from "./contained-turn-filesystem-custody.js";

export const readDirectoryNamesBounded = async (
  handle: FileHandle,
  maximumEntries: number,
): Promise<readonly string[]> => {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    throw new TypeError("contained turn directory entry limit must be a non-negative safe integer");
  }
  const before = await inspectFileHandle(handle);
  if (!before.isDirectory) {throw new Error("contained turn descriptor is not a directory");}
  const directory = await opendir(descriptorChildPath(handle));
  const names: string[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {break;}
      names.push(entry.name);
      if (names.length > maximumEntries) {
        throw new Error("contained turn directory exceeded its bounded enumeration limit");
      }
    }
  } finally {await directory.close();}
  const after = await inspectFileHandle(handle);
  if (!sameFilesystemObservation(before, after)) {
    throw new Error("contained turn directory changed during bounded enumeration");
  }
  return Object.freeze(names);
};

export const boundedReadFileHandle = async (
  handle: FileHandle,
  maximumBytes: number,
  expected?: ContainedTurnFilesystemIdentity,
): Promise<Buffer> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("contained turn file byte limit is invalid");
  }
  const before = await inspectFileHandle(handle);
  if (!before.isFile || before.isSymbolicLink || before.nlink !== 1n) {
    throw new Error("contained turn file descriptor is not a private regular file");
  }
  if (expected !== undefined && !sameFilesystemObservation(before, expected)) {
    throw new Error("contained turn file changed before its bounded read");
  }
  if (before.size > BigInt(maximumBytes)) {
    throw new Error("contained turn file exceeded its bounded read limit");
  }
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const remainingWithSentinel = maximumBytes - position + 1;
    if (remainingWithSentinel <= 0) {
      throw new Error("contained turn file exceeded its bounded read limit");
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, remainingWithSentinel));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {break;}
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (position > maximumBytes) {
      throw new Error("contained turn file exceeded its bounded read limit");
    }
  }
  const after = await inspectFileHandle(handle);
  if (!sameFilesystemObservation(before, after) || after.nlink !== 1n ||
    after.size !== BigInt(position)) {
    throw new Error("contained turn file changed during its bounded read");
  }
  return Buffer.concat(chunks, position);
};
