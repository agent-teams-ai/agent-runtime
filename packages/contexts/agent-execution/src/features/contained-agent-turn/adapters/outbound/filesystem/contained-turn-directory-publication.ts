import type { FileHandle } from "node:fs/promises";
import {
  publishStableDirectoryNoReplace,
  StableDirectoryPublicationUnsupportedError,
} from "@agent-teams/filesystem-custody";

import {
  assertSameMountIdentity,
  fsyncDirectoryHandle,
  inspectFileHandle,
  isMissingFilesystemEntry,
  openDirectoryEntry,
  sameFilesystemIdentity,
} from "./contained-turn-filesystem-custody.js";
import { ContainedTurnFilesystemUnsupportedError } from "./contained-turn-filesystem-error.js";
import type { ContainedTurnFilesystemFaults } from "./contained-turn-durable-file.js";

export interface ContainedTurnDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const publishDirectory = async (input: {
  readonly destinationDirectory: FileHandle;
  readonly destinationName: string;
  readonly expectedSourceIdentity: ContainedTurnDirectoryIdentity;
  readonly sourceDirectory: FileHandle;
  readonly sourceName: string;
}): Promise<"created" | "existing"> => {
  try {
    return await publishStableDirectoryNoReplace(input);
  } catch (error) {
    if (error instanceof StableDirectoryPublicationUnsupportedError) {
      throw new ContainedTurnFilesystemUnsupportedError(error.message);
    }
    throw error;
  }
};

const verifyPublishedIdentity = async (input: {
  readonly destinationDirectory: FileHandle;
  readonly destinationName: string;
  readonly expectedIdentity: ContainedTurnDirectoryIdentity;
}): Promise<void> => {
  const published = await openDirectoryEntry(input.destinationDirectory, input.destinationName);
  try {
    if (!sameFilesystemIdentity(await inspectFileHandle(published), input.expectedIdentity)) {
      throw new Error("contained turn directory publication committed an unknown source");
    }
  } finally {await published.close();}
};

const recoverEvidenceOwnedPublication = async (input: {
  readonly checkpoint: string;
  readonly destinationDirectory: FileHandle;
  readonly destinationName: string;
  readonly expectedSourceIdentity: ContainedTurnDirectoryIdentity;
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly sourceDirectory: FileHandle;
  readonly sourceName: string;
}): Promise<"created" | "existing"> => {
  const outcome = await publishDirectory(input);
  await verifyPublishedIdentity({
    destinationDirectory: input.destinationDirectory,
    destinationName: input.destinationName,
    expectedIdentity: input.expectedSourceIdentity,
  });
  if (outcome === "created") {
    await fsyncDirectoryHandle(input.sourceDirectory);
    if (input.sourceDirectory.fd !== input.destinationDirectory.fd) {
      await fsyncDirectoryHandle(input.destinationDirectory);
    }
    await input.faults?.checkpoint(`${input.checkpoint}.published`);
  }
  return outcome;
};

export const moveDirectoryNoReplace = async (input: {
  readonly checkpoint: string;
  readonly destinationDirectory: FileHandle;
  readonly destinationName: string;
  readonly expectedSourceIdentity?: ContainedTurnDirectoryIdentity | undefined;
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly sourceDirectory: FileHandle;
  readonly sourceName: string;
}): Promise<"created" | "existing"> => {
  await assertSameMountIdentity(input.sourceDirectory, input.destinationDirectory);
  let retained: FileHandle;
  try {
    retained = await openDirectoryEntry(input.sourceDirectory, input.sourceName);
  } catch (error) {
    if (input.expectedSourceIdentity === undefined || !isMissingFilesystemEntry(error)) {throw error;}
    return recoverEvidenceOwnedPublication({
      checkpoint: input.checkpoint,
      destinationDirectory: input.destinationDirectory,
      destinationName: input.destinationName,
      expectedSourceIdentity: input.expectedSourceIdentity,
      faults: input.faults,
      sourceDirectory: input.sourceDirectory,
      sourceName: input.sourceName,
    });
  }
  try {
    const identity = await inspectFileHandle(retained);
    if (
      input.expectedSourceIdentity !== undefined &&
      !sameFilesystemIdentity(identity, input.expectedSourceIdentity)
    ) {
      throw new Error("contained turn directory publication source identity was replaced");
    }
    await input.faults?.checkpoint(`${input.checkpoint}.source-bound`);
    const current = await openDirectoryEntry(input.sourceDirectory, input.sourceName);
    try {
      const currentIdentity = await inspectFileHandle(current);
      if (!sameFilesystemIdentity(identity, currentIdentity)) {
        throw new Error("contained turn directory publication source changed before commit");
      }
    } finally {await current.close();}

    const outcome = await publishDirectory({
      destinationDirectory: input.destinationDirectory,
      destinationName: input.destinationName,
      expectedSourceIdentity: identity,
      sourceDirectory: input.sourceDirectory,
      sourceName: input.sourceName,
    });
    if (outcome === "existing") {return outcome;}
    await verifyPublishedIdentity({
      destinationDirectory: input.destinationDirectory,
      destinationName: input.destinationName,
      expectedIdentity: identity,
    });
    await fsyncDirectoryHandle(input.sourceDirectory);
    if (input.sourceDirectory.fd !== input.destinationDirectory.fd) {
      await fsyncDirectoryHandle(input.destinationDirectory);
    }
    await input.faults?.checkpoint(`${input.checkpoint}.published`);
    return outcome;
  } finally {await retained.close();}
};

export const requireDirectoryPublication = (
  outcome: "created" | "existing",
  description: string,
): void => {
  if (outcome === "existing") {
    throw new Error(`contained turn ${description} destination already exists`);
  }
};
