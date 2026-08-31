import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody";

import {
  parseContainedTurnResultUrnDigest,
  type ContainedTurnArtifactEntry,
  type ContainedTurnArtifactManifest,
} from "./contained-turn-artifact-manifest.js";
import type { VerifiedStoredArtifact } from "./contained-turn-artifact-store.js";
import {
  descriptorChildPath,
  assertSameMountIdentity,
  fsyncDirectoryHandle,
  isMissingFilesystemEntry,
  openDirectoryEntry,
  inspectFileHandle,
  revalidateBoundRoots,
  sameFilesystemIdentity,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import type { ContainedTurnFilesystemFaults } from "./contained-turn-durable-file.js";
import { readStableFileAt, writeImmutableFileAt } from "./contained-turn-durable-file.js";
import {
  encodeRehydrationRecord,
  parseRehydrationRecord,
  type ContainedTurnRehydrationRecord,
} from "./contained-turn-rehydration-state.js";
import {
  scanContainedTurnWorkspaceHandle,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";
import {
  moveDirectoryNoReplace,
  requireDirectoryPublication,
} from "./contained-turn-directory-publication.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import {
  canonicalRehydrationStagingName,
  closeRehydrationHandles,
  directoryExistsAt,
  isFilesystemCode,
  throwRehydrationCleanupFailure,
} from "./contained-turn-rehydration-filesystem.js";

export interface ContainedTurnArtifactRehydrationContext {
  readonly contentDigest: (domain: "blob" | "manifest", bytes: Uint8Array) => string;
  readonly custodyRoots: readonly BoundContainedTurnRoot[];
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly limits: ContainedTurnWorkspaceTreeLimits;
  readonly roots: Readonly<Record<
    "metadataStaging" | "quarantine" | "records" | "results" | "staging",
    BoundContainedTurnRoot
  >>;
  readonly verifyArtifact: (manifestDigest: string) => Promise<VerifiedStoredArtifact>;
}

const openRelativeDirectory = async (
  root: FileHandle,
  relativePath: string,
): Promise<FileHandle | undefined> => {
  if (relativePath.length === 0) {return undefined;}
  let current: FileHandle | undefined;
  try {
    for (const component of relativePath.split("/")) {
      const next = await openDirectoryEntry(current ?? root, component);
      if (current !== undefined) {
        const previous = current;
        current = undefined;
        try {await previous.close();} catch (error) {
          try {await next.close();} catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "contained turn rehydration path handoff and cleanup failed",
              { cause: error },
            );
          }
          throw error;
        }
      }
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== undefined) {
      try {await current.close();} catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "contained turn rehydration path capture and cleanup failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
};

const reconstruct = async (
  root: FileHandle,
  verified: VerifiedStoredArtifact,
): Promise<void> => {
  const directories: ContainedTurnArtifactEntry[] = [];
  for (const entry of verified.manifest.entries) {
    const separator = entry.path.lastIndexOf("/");
    const parentPath = separator === -1 ? "" : entry.path.slice(0, separator);
    const name = separator === -1 ? entry.path : entry.path.slice(separator + 1);
    const openedParent = await openRelativeDirectory(root, parentPath);
    const parent = openedParent ?? root;
    try {
      if (entry.kind === "directory") {
        await mkdir(descriptorChildPath(parent, name), { mode: 0o700 });
        directories.push(entry);
      } else {
        const bytes = verified.blobs.get(entry.digest);
        if (bytes === undefined || bytes.length !== entry.size) {
          throw new Error("contained turn reconstruction is missing a verified blob");
        }
        const file = await open(
          descriptorChildPath(parent, name),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await assertSameMountIdentity(parent, file);
          await file.writeFile(bytes);
          await file.chmod(entry.mode);
          await file.sync();
        } finally {await file.close();}
      }
      await fsyncDirectoryHandle(parent);
    } finally {await openedParent?.close();}
  }
  for (const directory of directories.toReversed()) {
    const handle = await openRelativeDirectory(root, directory.path);
    if (handle === undefined) {throw new Error("contained turn reconstructed directory disappeared");}
    try {
      await handle.chmod(directory.mode);
      await handle.sync();
    } finally {await handle.close();}
  }
  await fsyncDirectoryHandle(root);
};

const verifyRehydrated = async (
  handle: FileHandle,
  diagnosticPath: string,
  manifest: ContainedTurnArtifactManifest,
  context: ContainedTurnArtifactRehydrationContext,
): Promise<void> => {
  const tree = await scanContainedTurnWorkspaceHandle(handle, diagnosticPath, context.limits, {
    contentDigest: bytes => context.contentDigest("blob", bytes),
  });
  if (
    tree.treeDigest !== manifest.treeDigest
  ) {
    throw new Error("contained turn rehydrated tree does not match its artifact manifest");
  }
};

const ensureRehydrationIntent = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly manifestDigest: string;
  readonly metadataStaging: FileHandle;
  readonly records: FileHandle;
  readonly stagingName: string;
  readonly verified: VerifiedStoredArtifact;
}): Promise<ContainedTurnRehydrationRecord> => {
  const expected: ContainedTurnRehydrationRecord = Object.freeze({
    manifestDigest: input.manifestDigest,
    operationId: input.verified.manifest.operationId,
    projectId: input.verified.manifest.projectId,
    rootIdentity: Object.freeze({
      dev: input.identity.dev.toString(), ino: input.identity.ino.toString(),
    }),
    schemaVersion: 2,
    stagingName: input.stagingName,
    tenantId: input.verified.manifest.tenantId,
    treeDigest: input.verified.manifest.treeDigest,
  });
  let existing: Buffer | undefined;
  try {existing = await readStableFileAt(input.records, `${input.manifestDigest}.json`, 64 * 1_024);} catch (error) {
    if (!isMissingFilesystemEntry(error)) {throw error;}
  }
  if (existing !== undefined) {
    const parsed = parseRehydrationRecord(existing);
    if (!encodeRehydrationRecord(parsed).equals(encodeRehydrationRecord(expected))) {
      throw new Error("contained turn rehydration identity conflicts with its canonical record");
    }
    return parsed;
  }
  await writeImmutableFileAt({
    bytes: encodeRehydrationRecord(expected),
    faults: input.context.faults === undefined ? undefined : Object.freeze({
      checkpoint: (point: string) => input.context.faults?.checkpoint(`artifact.rehydrate-record.${point}`),
    }),
    finalDirectory: input.records,
    finalName: `${input.manifestDigest}.json`,
    stagingDirectory: input.metadataStaging,
    temporaryKind: "metadata",
  });
  return expected;
};

interface RehydrationAttemptState {
  identity?: Readonly<{ dev: bigint; ino: bigint }>;
  intentCommitted?: boolean;
  stagingName?: string;
}

const loadRehydrationIntent = async (
  records: FileHandle,
  manifestDigest: string,
  verified: VerifiedStoredArtifact,
  state: RehydrationAttemptState,
): Promise<ContainedTurnRehydrationRecord | undefined> => {
  let existingRecord: ContainedTurnRehydrationRecord | undefined;
  try {
    existingRecord = parseRehydrationRecord(await readStableFileAt(
      records, `${manifestDigest}.json`, 64 * 1_024,
    ));
    if (
      existingRecord.manifestDigest !== manifestDigest ||
      existingRecord.operationId !== verified.manifest.operationId ||
      existingRecord.projectId !== verified.manifest.projectId ||
      existingRecord.tenantId !== verified.manifest.tenantId ||
      existingRecord.treeDigest !== verified.manifest.treeDigest
    ) {
      throw new Error("contained turn rehydration intent conflicts with artifact provenance");
    }
    state.intentCommitted = true;
    state.stagingName = existingRecord.stagingName;
    state.identity = Object.freeze({
      dev: BigInt(existingRecord.rootIdentity.dev),
      ino: BigInt(existingRecord.rootIdentity.ino),
    });
  } catch (error) {
    if (!isMissingFilesystemEntry(error)) {throw error;}
  }
  return existingRecord;
};

const recoverPublishedRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly finalPath: string;
  readonly manifestDigest: string;
  readonly quarantine: FileHandle;
  readonly results: FileHandle;
  readonly state: RehydrationAttemptState;
  readonly verified: VerifiedStoredArtifact;
}): Promise<string | undefined> => {
  const { context, finalPath, manifestDigest, quarantine, results, state, verified } = input;
  if (!await directoryExistsAt(results, manifestDigest)) {return undefined;}
  if (state.intentCommitted === true && state.identity !== undefined) {
    const current = await openDirectoryEntry(results, manifestDigest);
    try {
      const identity = await inspectFileHandle(current);
      if (identity.dev !== state.identity.dev || identity.ino !== state.identity.ino) {
        throw new Error("contained turn rehydration publication identity conflicts with intent");
      }
      await verifyRehydrated(current, finalPath, verified.manifest, context);
    } finally {await current.close();}
    return finalPath;
  }
  requireDirectoryPublication(await moveDirectoryNoReplace({
    checkpoint: "artifact.rehydrate.unknown-final-quarantine",
    destinationDirectory: quarantine,
    destinationName: `.rehydrate-${manifestDigest}-${randomUUID()}.unknown`,
    faults: context.faults,
    sourceDirectory: results,
    sourceName: manifestDigest,
  }), "unknown rehydration quarantine");
  return undefined;
};

const joinConcurrentMaterialization = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly diagnosticPath: string;
  readonly materializing: FileHandle;
  readonly verified: VerifiedStoredArtifact;
}): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await verifyRehydrated(
        input.materializing, input.diagnosticPath, input.verified.manifest, input.context,
      );
      return;
    } catch (error) {
      if (attempt === 299) {throw error;}
      await delay(100);
    }
  }
};

const buildStagedRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly staging: FileHandle;
  readonly stagingName: string;
  readonly state: RehydrationAttemptState;
  readonly verified: VerifiedStoredArtifact;
}): Promise<void> => {
  const { context, staging, stagingName, state, verified } = input;
  let materializationOwner = false;
  try {
    await mkdir(descriptorChildPath(staging, stagingName), { mode: 0o700 });
    materializationOwner = true;
    await fsyncDirectoryHandle(staging);
    await context.faults?.checkpoint("artifact.rehydrate.created");
  } catch (error) {
    if (!isFilesystemCode(error, "EEXIST")) {throw error;}
  }
  if (!materializationOwner) {
    await context.faults?.checkpoint("artifact.rehydrate.joining");
  }
  const diagnosticPath = join(context.roots.staging.canonicalPath, stagingName);
  const materializing = await openDirectoryEntry(staging, stagingName);
  try {
    const identity = await inspectFileHandle(materializing);
    state.identity = Object.freeze({ dev: identity.dev, ino: identity.ino });
    if (materializationOwner) {
      await reconstruct(materializing, verified);
    } else {
      await joinConcurrentMaterialization({ context, diagnosticPath, materializing, verified });
    }
    await verifyRehydrated(materializing, diagnosticPath, verified.manifest, context);
  } finally {await materializing.close();}
};

const materializeRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly manifestDigest: string;
  readonly metadataStaging: FileHandle;
  readonly records: FileHandle;
  readonly staging: FileHandle;
  readonly state: RehydrationAttemptState;
  readonly verified: VerifiedStoredArtifact;
}): Promise<void> => {
  const { context, manifestDigest, metadataStaging, records, staging, state, verified } = input;
  const stagingName = canonicalRehydrationStagingName(manifestDigest);
  state.stagingName = stagingName;
  await buildStagedRehydration({ context, staging, stagingName, state, verified });
  await context.faults?.checkpoint("artifact.rehydrate.verified");
  if (state.identity === undefined) {
    throw new Error("contained turn rehydration intent has no source identity");
  }
  await ensureRehydrationIntent({
    context, identity: state.identity, manifestDigest, metadataStaging,
    records, stagingName, verified,
  });
  state.intentCommitted = true;
  await context.faults?.checkpoint("artifact.rehydrate.intent-recorded");
};

const assertCompleteAttempt = (
  state: RehydrationAttemptState,
): Readonly<{ identity: Readonly<{ dev: bigint; ino: bigint }>; stagingName: string }> => {
  if (state.stagingName === undefined || state.identity === undefined) {
    throw new Error("contained turn rehydration intent is incomplete");
  }
  return Object.freeze({ identity: state.identity, stagingName: state.stagingName });
};

const verifyPublishedRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly expectedIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  readonly finalPath: string;
  readonly manifestDigest: string;
  readonly results: FileHandle;
  readonly verified: VerifiedStoredArtifact;
}): Promise<void> => {
  const canonical = await openDirectoryEntry(input.results, input.manifestDigest);
  try {
    const identity = await inspectFileHandle(canonical);
    if (!sameFilesystemIdentity(identity, input.expectedIdentity)) {
      throw new Error("contained turn concurrent rehydration published conflicting identity");
    }
    await verifyRehydrated(canonical, input.finalPath, input.verified.manifest, input.context);
  } finally {await canonical.close();}
};

const publishRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly finalPath: string;
  readonly manifestDigest: string;
  readonly results: FileHandle;
  readonly staging: FileHandle;
  readonly state: RehydrationAttemptState;
  readonly verified: VerifiedStoredArtifact;
}): Promise<string> => {
  const { context, finalPath, manifestDigest, results, staging, state, verified } = input;
  const complete = assertCompleteAttempt(state);
  let retainedStaging: FileHandle | undefined;
  try {
    retainedStaging = await openDirectoryEntry(staging, complete.stagingName);
  } catch (error) {
    if (state.intentCommitted !== true || !isMissingFilesystemEntry(error)) {throw error;}
  }
  if (retainedStaging !== undefined) {
    try {
      await verifyRehydrated(
        retainedStaging,
        join(context.roots.staging.canonicalPath, complete.stagingName),
        verified.manifest,
        context,
      );
    } finally {await retainedStaging.close();}
  }
  const publication = await moveDirectoryNoReplace({
    checkpoint: "artifact.rehydrate.publish",
    destinationDirectory: results,
    destinationName: manifestDigest,
    expectedSourceIdentity: complete.identity,
    faults: context.faults,
    sourceDirectory: staging,
    sourceName: complete.stagingName,
  });
  if (publication === "existing") {
    await verifyPublishedRehydration({
      context, expectedIdentity: complete.identity, finalPath, manifestDigest, results, verified,
    });
    return finalPath;
  }
  const revalidated = await openDirectoryEntry(results, manifestDigest);
  try {
    const identity = await inspectFileHandle(revalidated);
    if (identity.dev !== complete.identity.dev || identity.ino !== complete.identity.ino) {
      throw new Error("contained turn rehydration result identity changed after publication");
    }
    await verifyRehydrated(revalidated, finalPath, verified.manifest, context);
  } finally {await revalidated.close();}
  return finalPath;
};

const joinMovedRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly finalPath: string;
  readonly manifestDigest: string;
  readonly records: FileHandle;
  readonly results: FileHandle;
  readonly staging: FileHandle;
  readonly state: RehydrationAttemptState;
  readonly verified: VerifiedStoredArtifact;
}): Promise<string | undefined> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await loadRehydrationIntent(
      input.records, input.manifestDigest, input.verified, input.state,
    );
    if (record !== undefined) {
      return publishRehydration(input);
    }
    await delay(20);
  }
  return undefined;
};

const quarantineFailedRehydration = async (input: {
  readonly context: ContainedTurnArtifactRehydrationContext;
  readonly manifestDigest: string;
  readonly primaryError: unknown;
  readonly quarantine: FileHandle;
  readonly staging: FileHandle;
  readonly state: RehydrationAttemptState;
}): Promise<void> => {
  const { context, manifestDigest, primaryError, quarantine, staging, state } = input;
  if (state.stagingName === undefined || state.identity === undefined || state.intentCommitted) {return;}
  try {
    requireDirectoryPublication(await moveDirectoryNoReplace({
      checkpoint: "artifact.rehydrate.failure-quarantine",
      destinationDirectory: quarantine,
      destinationName: `.rehydrate-${manifestDigest}-${randomUUID()}.quarantined`,
      expectedSourceIdentity: state.identity,
      faults: context.faults,
      sourceDirectory: staging,
      sourceName: state.stagingName,
    }), "failed rehydration quarantine");
  } catch (cleanupError) {
    if (!isMissingFilesystemEntry(cleanupError)) {
      return throwRehydrationCleanupFailure(primaryError, cleanupError);
    }
  }
};

export const rehydrateContainedTurnArtifact = async (
  resultRef: string,
  context: ContainedTurnArtifactRehydrationContext,
): Promise<string> => {
  await revalidateBoundRoots(context.custodyRoots);
  const manifestDigest = parseContainedTurnResultUrnDigest(resultRef);
  const verified = await context.verifyArtifact(manifestDigest);
  const handles = await openBoundDirectories([
    context.roots.results,
    context.roots.quarantine,
    context.roots.records,
    context.roots.metadataStaging,
    context.roots.staging,
  ]);
  const [results, quarantine, records, metadataStaging, staging] = handles;
  const finalPath = join(context.roots.results.canonicalPath, manifestDigest);
  const state: RehydrationAttemptState = {};
  let recovered: string | undefined;
  try {
    await withStableDirectoryProcessLock(staging, async () => {
      try {
        const existingRecord = await loadRehydrationIntent(records, manifestDigest, verified, state);
        recovered = await recoverPublishedRehydration({
          context, finalPath, manifestDigest, quarantine, results, state, verified,
        });
        if (recovered !== undefined) {return;}
        if (existingRecord === undefined) {
          try {
            await materializeRehydration({
              context, manifestDigest, metadataStaging, records, staging, state, verified,
            });
          } catch (error) {
            if (!isMissingFilesystemEntry(error)) {throw error;}
            const joined = await joinMovedRehydration({
              context, finalPath, manifestDigest, records, results, staging, state, verified,
            });
            if (joined !== undefined) {recovered = joined; return;}
            throw error;
          }
        }
        if (recovered === undefined) {
          recovered = await publishRehydration({
            context, finalPath, manifestDigest, results, staging, state, verified,
          });
        }
      } catch (error) {
        await quarantineFailedRehydration({ context, manifestDigest, primaryError: error,
          quarantine, staging, state });
        throw error;
      }
    });
    if (recovered === undefined) {
      throw new Error("contained turn rehydration completed without a published result");
    }
    return recovered;
  } finally {
    await closeRehydrationHandles(handles);
  }
};
