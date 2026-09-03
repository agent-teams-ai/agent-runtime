import { type FileHandle } from "node:fs/promises";

import {
  isMissingFilesystemEntry,
  openDirectoryEntry,
} from "./contained-turn-filesystem-custody.js";

export const directoryExistsAt = async (
  parent: FileHandle,
  name: string,
): Promise<boolean> => {
  try {
    const child = await openDirectoryEntry(parent, name);
    await child.close();
    return true;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) {return false;}
    throw error;
  }
};

export const isFilesystemCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

export const canonicalRehydrationStagingName = (digest: string): string => {
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return `.rehydrate-${digest}-${uuid}.tmp`;
};

export const closeRehydrationHandles = async (
  handles: readonly FileHandle[],
): Promise<void> => {
  let failure: unknown;
  for (const handle of handles.toReversed()) {
    try {await handle.close();} catch (error) {failure ??= error;}
  }
  if (failure !== undefined) {throw failure;}
};

export const throwRehydrationCleanupFailure = (primary: unknown, cleanup: unknown): never => {
  throw new AggregateError(
    [primary, cleanup],
    "contained turn rehydration and cleanup failed",
    { cause: primary },
  );
};
