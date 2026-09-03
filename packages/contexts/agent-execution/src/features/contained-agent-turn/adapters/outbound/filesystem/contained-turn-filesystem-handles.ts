import type { FileHandle } from "node:fs/promises";

import {
  type BoundContainedTurnRoot,
  openBoundDirectory,
} from "./contained-turn-filesystem-custody.js";

export const openBoundDirectories = async <
  const Roots extends readonly BoundContainedTurnRoot[],
>(roots: Roots): Promise<{ -readonly [Index in keyof Roots]: FileHandle }> => {
  const settled = await Promise.allSettled(roots.map(openBoundDirectory));
  const primaryFailure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (primaryFailure === undefined) {
    return settled.map(result => (result as PromiseFulfilledResult<FileHandle>).value) as {
      -readonly [Index in keyof Roots]: FileHandle;
    };
  }
  const opened = settled.flatMap(result =>
    result.status === "fulfilled" ? [result.value] : []
  );
  const cleanup = await Promise.allSettled(
    opened.toReversed().map(async handle => handle.close()),
  );
  const cleanupFailures = cleanup.flatMap(result =>
    result.status === "rejected" ? [result.reason as unknown] : []
  );
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure.reason as unknown, ...cleanupFailures],
      "contained turn bound directory acquisition and cleanup failed",
      { cause: primaryFailure.reason },
    );
  }
  throw primaryFailure.reason;
};
