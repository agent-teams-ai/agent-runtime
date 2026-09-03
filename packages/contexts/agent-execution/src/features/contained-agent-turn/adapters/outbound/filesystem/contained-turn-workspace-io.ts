import { createHash } from "node:crypto";
import { unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { ContainedTurnScope } from "../../../contracts/contained-agent-turn.js";
import {
  descriptorChildPath,
  fsyncDirectoryHandle,
  inspectFileHandle,
  isMissingFilesystemEntry,
  openDirectoryEntry,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import {
  readStableFileAt,
  type ContainedTurnFilesystemFaults,
} from "./contained-turn-durable-file.js";
import type { ContainedTurnWorkspaceTreeLimits } from "./contained-turn-workspace-tree.js";
import type { ContainedTurnWorkspaceRoots } from "./contained-turn-workspace-custody.js";

const WORKSPACE_NAME = /^operation-[a-f\d]{64}$/u;
const RECORD_BYTES = 64 * 1_024;

export interface ContainedTurnWorkspaceContext {
  readonly custodyRoots: readonly BoundContainedTurnRoot[];
  readonly options: Readonly<{
    readonly canonicalProjectRoot: string;
    readonly limits?: ContainedTurnWorkspaceTreeLimits | undefined;
    readonly testFaults?: ContainedTurnFilesystemFaults | undefined;
  }>;
  readonly roots: ContainedTurnWorkspaceRoots;
}

export const workspaceName = (operationId: string, scope: ContainedTurnScope): string =>
  `operation-${createHash("sha256").update(JSON.stringify([
    scope.tenantId, scope.projectId, operationId,
  ])).digest("hex")}`;

export const sameScope = (left: ContainedTurnScope, right: ContainedTurnScope): boolean =>
  left.tenantId === right.tenantId && left.projectId === right.projectId;

export const assertWorkspaceRef = (workspaceRef: string, activeRoot: string): string => {
  if (!isAbsolute(workspaceRef) || resolve(workspaceRef) !== workspaceRef || dirname(workspaceRef) !== activeRoot) {
    throw new Error("contained turn workspace reference is outside active custody");
  }
  const name = basename(workspaceRef);
  if (!WORKSPACE_NAME.test(name)) {
    throw new Error("contained turn workspace reference has an invalid identity");
  }
  return name;
};

export const directoryExistsAt = async (parent: FileHandle, name: string): Promise<boolean> => {
  try {
    const handle = await openDirectoryEntry(parent, name);
    await handle.close();
    return true;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) {return false;}
    throw error;
  }
};

export const readOptionalWorkspaceFileAt = async (
  parent: FileHandle,
  name: string,
): Promise<Buffer | undefined> => {
  try {
    return await readStableFileAt(parent, name, RECORD_BYTES);
  } catch (error) {
    if (isMissingFilesystemEntry(error)) {return undefined;}
    throw error;
  }
};

export const unlinkOptionalAt = async (parent: FileHandle, name: string): Promise<void> => {
  try {
    await unlink(descriptorChildPath(parent, name));
    await fsyncDirectoryHandle(parent);
  } catch (error) {
    if (!isMissingFilesystemEntry(error)) {throw error;}
  }
};

export const closeWorkspaceHandles = async (handles: readonly FileHandle[]): Promise<void> => {
  let failure: unknown;
  for (const handle of handles.toReversed()) {
    try {await handle.close();} catch (error) {failure ??= error;}
  }
  if (failure !== undefined) {throw failure;}
};

export const throwWorkspaceCleanupFailure = (
  primary: unknown,
  cleanup: unknown,
  message: string,
): never => {
  throw new AggregateError([primary, cleanup], message);
};

export const prefixedWorkspaceFaults = (
  faults: ContainedTurnFilesystemFaults | undefined,
  prefix: string,
): ContainedTurnFilesystemFaults | undefined => faults === undefined ? undefined : Object.freeze({
  checkpoint: (point: string) => faults.checkpoint(`${prefix}.${point}`),
});

export const assertDirectoryIdentityAt = async (
  parent: FileHandle,
  name: string,
  expected: Readonly<{ dev: bigint | string; ino: bigint | string }>,
): Promise<void> => {
  const directory = await openDirectoryEntry(parent, name);
  try {
    const identity = await inspectFileHandle(directory);
    if (
      identity.dev.toString() !== expected.dev.toString() ||
      identity.ino.toString() !== expected.ino.toString()
    ) {
      throw new Error("contained turn workspace directory identity was replaced");
    }
  } finally {await directory.close();}
};

export const workspaceRecordBytes = RECORD_BYTES;
