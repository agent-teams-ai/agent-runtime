import type { FileHandle } from "node:fs/promises";

import { openDirectoryEntry } from "./contained-turn-filesystem-custody.js";

const relativeDirectoryCleanupFailure = (
  error: unknown,
  cleanupError: unknown,
  message: string,
): AggregateError => new AggregateError([error, cleanupError], message, { cause: error });

const closeDirectoryHandoff = async (
  previous: FileHandle,
  next: FileHandle,
  operation: "materialization" | "rehydration",
): Promise<void> => {
  try {
    await previous.close();
  } catch (error) {
    try {
      await next.close();
    } catch (cleanupError) {
      throw relativeDirectoryCleanupFailure(
        error,
        cleanupError,
        `contained turn ${operation} path handoff and cleanup failed`,
      );
    }
    throw error;
  }
};

export const openContainedTurnRelativeDirectory = async (
  root: FileHandle,
  relativePath: string,
  operation: "materialization" | "rehydration",
): Promise<FileHandle | undefined> => {
  if (relativePath.length === 0) {return undefined;}
  let current: FileHandle | undefined;
  try {
    for (const component of relativePath.split("/")) {
      const next = await openDirectoryEntry(current ?? root, component);
      if (current !== undefined) {
        const previous = current;
        current = undefined;
        await closeDirectoryHandoff(previous, next, operation);
      }
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== undefined) {
      try {
        await current.close();
      } catch (cleanupError) {
        throw relativeDirectoryCleanupFailure(
          error,
          cleanupError,
          `contained turn ${operation} path capture and cleanup failed`,
        );
      }
    }
    throw error;
  }
};
