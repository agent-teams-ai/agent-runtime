import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ContainedTurnFilesystemWorkspacePort as ContainedTurnWorkspacePort } from "./contained-turn-filesystem-port.js";
import {
  descriptorChildPath,
  fsyncDirectoryHandle,
  inspectFileHandle,
  openBoundDirectory,
  openDirectoryEntry,
  revalidateBoundRoots,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import { readDirectoryNamesBounded } from "./contained-turn-filesystem-reads.js";
import { writeImmutableFileAt } from "./contained-turn-durable-file.js";
import {
  moveDirectoryNoReplace,
  requireDirectoryPublication,
} from "./contained-turn-directory-publication.js";
import {
  assertDirectoryIdentityAt,
  closeWorkspaceHandles,
  directoryExistsAt,
  prefixedWorkspaceFaults,
  readOptionalWorkspaceFileAt,
  sameScope,
  throwWorkspaceCleanupFailure,
  workspaceName,
  type ContainedTurnWorkspaceContext,
} from "./contained-turn-workspace-io.js";
import { materializeCanonicalProject } from "./contained-turn-workspace-materialization.js";
import {
  encodeWorkspaceCreationRecord,
  parseWorkspaceCreationRecord,
  type ContainedTurnWorkspaceCreationRecord,
} from "./contained-turn-workspace-state.js";
import {
  DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  scanContainedTurnWorkspace,
} from "./contained-turn-workspace-tree.js";

type CreateInput = Parameters<ContainedTurnWorkspacePort["create"]>[0];
type DirectoryIdentity = Readonly<{ dev: bigint; ino: bigint }>;

interface CreationDirectories {
  readonly active: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly cleanup: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly closing: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly creations: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly frozen: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly handles: readonly Awaited<ReturnType<typeof openBoundDirectory>>[];
  readonly materializing: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly metadataStaging: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly quarantine: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly receipts: Awaited<ReturnType<typeof openBoundDirectory>>;
  readonly seals: Awaited<ReturnType<typeof openBoundDirectory>>;
}

const openCreationDirectories = async (
  context: ContainedTurnWorkspaceContext,
): Promise<CreationDirectories> => {
  const { roots } = context;
  const handles = await openBoundDirectories([
    roots.active, roots.cleanup, roots.closing, roots.frozen,
    roots.materializing, roots.quarantine, roots.receipts, roots.seals,
    roots.creations, roots.staging,
  ]);
  const [active, cleanup, closing, frozen, materializing, quarantine, receipts, seals,
    creations, metadataStaging] = handles;
  return { active, cleanup, closing, creations, frozen, handles, materializing,
    metadataStaging, quarantine, receipts, seals };
};

const replayCreation = async (input: {
  readonly context: ContainedTurnWorkspaceContext;
  readonly directories: CreationDirectories;
  readonly name: string;
  readonly request: CreateInput;
}): Promise<string | undefined> => {
  const { context, directories, name, request } = input;
  const { active, cleanup, closing, creations, frozen, materializing, receipts, seals } =
    directories;
  const activeExists = await directoryExistsAt(active, name);
  const materializingExists = await directoryExistsAt(materializing, name);
  const otherOccupied = [
    await directoryExistsAt(cleanup, name),
    await directoryExistsAt(frozen, name),
    await readOptionalWorkspaceFileAt(closing, `${name}.json`) !== undefined,
    await readOptionalWorkspaceFileAt(receipts, `${name}.json`) !== undefined,
    await readOptionalWorkspaceFileAt(seals, `${name}.json`) !== undefined,
  ];
  const creationBytes = await readOptionalWorkspaceFileAt(creations, `${name}.json`);
  if (creationBytes === undefined) {
    if (activeExists || otherOccupied.some(Boolean)) {
      throw new Error("contained turn workspace identity already has custody state");
    }
    return undefined;
  }
  const creation = parseWorkspaceCreationRecord(creationBytes);
  if (
    creation.operationId !== request.operationId || !sameScope(creation.scope, request.scope) ||
    creation.workspaceName !== name || activeExists === materializingExists ||
    otherOccupied.some(Boolean)
  ) {
    throw new Error("contained turn workspace creation replay conflicts with custody state");
  }
  if (materializingExists) {
    await assertDirectoryIdentityAt(materializing, name, creation.rootIdentity);
    requireDirectoryPublication(await moveDirectoryNoReplace({
      checkpoint: "workspace.create.recover-publish",
      destinationDirectory: active,
      destinationName: name,
      expectedSourceIdentity: {
        dev: BigInt(creation.rootIdentity.dev), ino: BigInt(creation.rootIdentity.ino),
      },
      faults: context.options.testFaults,
      sourceDirectory: materializing,
      sourceName: name,
    }), "workspace recovery publication");
    await context.options.testFaults?.checkpoint("workspace.create.recovered-publish");
  }
  await assertDirectoryIdentityAt(active, name, creation.rootIdentity);
  const replayedTree = await scanContainedTurnWorkspace(
    join(context.roots.active.canonicalPath, name),
    context.options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  );
  if (replayedTree.treeDigest !== creation.materializationDigest) {
    throw new Error("contained turn workspace creation replay materialization conflicts with its record");
  }
  return join(context.roots.active.canonicalPath, name);
};

const quarantineIncompleteCreation = async (
  context: ContainedTurnWorkspaceContext,
  directories: CreationDirectories,
  name: string,
  quarantineEntries: readonly string[],
): Promise<void> => {
  if (quarantineEntries.some(entry => entry.startsWith(`${name}-`))) {
    throw new Error("contained turn workspace identity already has custody state");
  }
  if (!await directoryExistsAt(directories.materializing, name)) {return;}
  const abandoned = `${name}-creation-incomplete`;
  if (await directoryExistsAt(directories.quarantine, abandoned)) {
    throw new Error("contained turn workspace has repeated incomplete creation custody");
  }
  requireDirectoryPublication(await moveDirectoryNoReplace({
    checkpoint: "workspace.create.incomplete-quarantine",
    destinationDirectory: directories.quarantine,
    destinationName: abandoned,
    faults: context.options.testFaults,
    sourceDirectory: directories.materializing,
    sourceName: name,
  }), "incomplete creation quarantine");
};

const materializeWorkspace = async (
  context: ContainedTurnWorkspaceContext,
  materializing: CreationDirectories["materializing"],
  name: string,
  onCreated: () => void,
): Promise<Readonly<{ identity: DirectoryIdentity; materializationDigest: string }>> => {
  await mkdir(descriptorChildPath(materializing, name), { mode: 0o700 });
  onCreated();
  await fsyncDirectoryHandle(materializing);
  await context.options.testFaults?.checkpoint("workspace.create.directory-created");
  const workspace = await openDirectoryEntry(materializing, name);
  try {
    const materializationDigest = await materializeCanonicalProject(
      context.options.canonicalProjectRoot,
      workspace,
      context.options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
    );
    const identity = await inspectFileHandle(workspace);
    return Object.freeze({
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      materializationDigest,
    });
  } finally {await workspace.close();}
};

const recordAndPublishCreation = async (input: {
  readonly context: ContainedTurnWorkspaceContext;
  readonly directories: CreationDirectories;
  readonly identity: DirectoryIdentity;
  readonly materializationDigest: string;
  readonly name: string;
  readonly onRecorded: () => void;
  readonly request: CreateInput;
}): Promise<void> => {
  const { context, directories, identity, materializationDigest, name, onRecorded, request } = input;
  const creation: ContainedTurnWorkspaceCreationRecord = Object.freeze({
    materializationDigest,
    operationId: request.operationId,
    rootIdentity: Object.freeze({ dev: identity.dev.toString(), ino: identity.ino.toString() }),
    schemaVersion: 1,
    scope: request.scope,
    workspaceName: name,
  });
  await writeImmutableFileAt({
    bytes: encodeWorkspaceCreationRecord(creation),
    faults: prefixedWorkspaceFaults(context.options.testFaults, "workspace.creation"),
    finalDirectory: directories.creations,
    finalName: `${name}.json`,
    stagingDirectory: directories.metadataStaging,
    temporaryKind: "metadata",
  });
  onRecorded();
  await context.options.testFaults?.checkpoint("workspace.create.creation-recorded");
  requireDirectoryPublication(await moveDirectoryNoReplace({
    checkpoint: "workspace.create.publish",
    destinationDirectory: directories.active,
    destinationName: name,
    expectedSourceIdentity: identity,
    faults: context.options.testFaults,
    sourceDirectory: directories.materializing,
    sourceName: name,
  }), "workspace publication");
  await context.options.testFaults?.checkpoint("workspace.create.published");
};

const quarantineFailedCreation = async (input: {
  readonly context: ContainedTurnWorkspaceContext;
  readonly directories: CreationDirectories;
  readonly identity: DirectoryIdentity | undefined;
  readonly name: string;
  readonly primaryError: unknown;
}): Promise<never> => {
  const { context, directories, identity, name, primaryError } = input;
  try {
    const abandoned = `${name}-creation-failed`;
    if (await directoryExistsAt(directories.quarantine, abandoned)) {
      throw new Error("contained turn workspace creation failure quarantine already exists", {
        cause: primaryError,
      });
    }
    requireDirectoryPublication(await moveDirectoryNoReplace({
      checkpoint: "workspace.create.failure-quarantine",
      destinationDirectory: directories.quarantine,
      destinationName: abandoned,
      expectedSourceIdentity: identity,
      faults: context.options.testFaults,
      sourceDirectory: directories.materializing,
      sourceName: name,
    }), "failed creation quarantine");
  } catch (cleanupError) {
    return throwWorkspaceCleanupFailure(
      primaryError, cleanupError, "contained turn workspace creation and cleanup failed",
    );
  }
  throw primaryError;
};

export const createContainedTurnWorkspace = async (
  request: CreateInput,
  context: ContainedTurnWorkspaceContext,
): Promise<{ readonly workspaceRef: string }> => {
  await revalidateBoundRoots(context.custodyRoots);
  const name = workspaceName(request.operationId, request.scope);
  const directories = await openCreationDirectories(context);
  let created = false;
  let creationCommitted = false;
  let identity: DirectoryIdentity | undefined;
  try {
    const quarantineEntries = await readDirectoryNamesBounded(directories.quarantine, 4_096);
    const replayed = await replayCreation({ context, directories, name, request });
    if (replayed !== undefined) {return { workspaceRef: replayed };}
    await quarantineIncompleteCreation(context, directories, name, quarantineEntries);
    const materialized = await materializeWorkspace(
      context, directories.materializing, name, () => {created = true;},
    );
    identity = materialized.identity;
    await recordAndPublishCreation({
      context, directories, identity, materializationDigest: materialized.materializationDigest,
      name, onRecorded: () => {creationCommitted = true;}, request,
    });
    created = false;
    return { workspaceRef: join(context.roots.active.canonicalPath, name) };
  } catch (error) {
    if (created && !creationCommitted) {
      return quarantineFailedCreation({ context, directories, identity, name, primaryError: error });
    }
    throw error;
  } finally {await closeWorkspaceHandles(directories.handles);}
};
