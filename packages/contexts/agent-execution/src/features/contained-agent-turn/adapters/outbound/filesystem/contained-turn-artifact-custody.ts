import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody";

import type { ContainedTurnArtifactStoreRoots } from "./contained-turn-artifact-store.js";
import {
  assertSameFilesystemMount,
  bindContainedTurnRoot,
  bindContainedTurnRootSet,
  ensurePrivateDirectory,
  fsyncDirectoryHandle,
  openDirectoryEntry,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import { readDirectoryNamesBounded } from "./contained-turn-filesystem-reads.js";
import {
  type ContainedTurnFilesystemFaults,
  quarantineAmbiguousStagingDirectory,
  quarantineAmbiguousStagingEntry,
  readStableFileAt,
} from "./contained-turn-durable-file.js";
import { parseRehydrationRecord } from "./contained-turn-rehydration-state.js";
import {
  DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

const STAGING_ENTRY_LIMIT = 4_096;

export const assertContainedTurnArtifactLimits = (
  limits: ContainedTurnWorkspaceTreeLimits,
): void => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`contained turn artifact ${name} must be a non-negative safe integer`);
    }
  }
  if (
    limits.maxDepth > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxDepth ||
    limits.maxEntries > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxEntries ||
    limits.maxFileBytes > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxFileBytes ||
    limits.maxTotalBytes > DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS.maxTotalBytes ||
    limits.maxFileBytes > limits.maxTotalBytes
  ) {
    throw new TypeError("contained turn artifact limits exceed the qualified hard ceilings");
  }
};

export type ContainedTurnArtifactWorkspaceRoots = Readonly<Record<
  "active" | "creations" | "frozen" | "receipts" | "seals" | "staging" | "stagingQuarantine",
  BoundContainedTurnRoot
>>;
export type ContainedTurnArtifactRehydrationRoots = Readonly<Record<
  "metadataStaging" | "metadataStagingQuarantine" | "quarantine" | "records" | "results" | "staging",
  BoundContainedTurnRoot
>>;

export interface BoundArtifactCustody {
  readonly artifactRoots: ContainedTurnArtifactStoreRoots;
  readonly custodyRoots: readonly BoundContainedTurnRoot[];
  readonly rehydrationRoots: ContainedTurnArtifactRehydrationRoots;
  readonly resultPublications: BoundContainedTurnRoot;
  readonly workspaceRoots: ContainedTurnArtifactWorkspaceRoots;
}

interface ArtifactCustodyOptions {
  readonly canonicalProjectRoot: string;
  readonly disposableRoot: string;
  readonly rehydrationRoot: string;
  readonly root: string;
  readonly testFaults?: ContainedTurnFilesystemFaults | undefined;
  readonly workspaceRoot: string;
}

export const closeContainedTurnArtifactHandles = async (
  handles: readonly FileHandle[],
): Promise<void> => {
  let failure: unknown;
  for (const handle of handles.toReversed()) {
    try {await handle.close();} catch (error) {failure ??= error;}
  }
  if (failure !== undefined) {throw failure;}
};

const bindPrivateRoots = async <Paths extends Readonly<Record<string, string>>>(
  paths: Paths,
  custodyRoot: BoundContainedTurnRoot,
): Promise<Readonly<{ [Key in keyof Paths]: BoundContainedTurnRoot }>> => {
  for (const path of Object.values(paths)) {await ensurePrivateDirectory(path);}
  const entries: [string, BoundContainedTurnRoot][] = [];
  for (const [key, path] of Object.entries(paths)) {
    const root = await bindContainedTurnRoot(path, { private: true });
    assertSameFilesystemMount(custodyRoot, root);
    entries.push([key, root]);
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<{
    [Key in keyof Paths]: BoundContainedTurnRoot;
  }>;
};

const recoverRehydrationStaging = async (
  staging: FileHandle,
  quarantine: FileHandle,
  records: FileHandle,
): Promise<void> => {
  const names = await readDirectoryNamesBounded(staging, STAGING_ENTRY_LIMIT);
  for (const name of names) {
    const digest = /^\.rehydrate-([a-f\d]{64})-[a-f\d-]{36}\.tmp$/u.exec(name)?.[1];
    let retainedIntent = false;
    if (digest !== undefined) {
      try {
        const owned = await openDirectoryEntry(staging, name);
        try {
          const identity = await owned.stat({ bigint: true });
          const record = parseRehydrationRecord(await readStableFileAt(
            records, `${digest}.json`, 64 * 1_024,
          ));
          retainedIntent = record.stagingName === name &&
            record.rootIdentity.dev === identity.dev.toString() &&
            record.rootIdentity.ino === identity.ino.toString();
        } finally {await owned.close();}
      } catch {retainedIntent = false;}
    }
    if (retainedIntent) {continue;}
    await quarantineAmbiguousStagingEntry(staging, quarantine, name);
  }
  if (names.length > 0) {
    await fsyncDirectoryHandle(staging);
    await fsyncDirectoryHandle(quarantine);
  }
};

export const bindArtifactCustody = async (
  options: ArtifactCustodyOptions,
): Promise<BoundArtifactCustody> => {
  const bound = await bindContainedTurnRootSet({
    canonicalProjectRoot: options.canonicalProjectRoot,
    disposableRoot: options.disposableRoot,
    ownedRoots: {
      artifacts: options.root,
      rehydration: options.rehydrationRoot,
      workspaces: options.workspaceRoot,
    },
  });
  const allArtifactRoots = await bindPrivateRoots({
    blobs: join(bound.ownedRoots.artifacts.canonicalPath, "blobs"),
    manifests: join(bound.ownedRoots.artifacts.canonicalPath, "manifests"),
    results: join(bound.ownedRoots.artifacts.canonicalPath, "results"),
    staging: join(bound.ownedRoots.artifacts.canonicalPath, "staging"),
    stagingQuarantine: join(bound.ownedRoots.artifacts.canonicalPath, "staging-quarantine"),
  }, bound.ownedRoots.artifacts);
  const artifactRoots: ContainedTurnArtifactStoreRoots = Object.freeze({
    blobs: allArtifactRoots.blobs,
    manifests: allArtifactRoots.manifests,
    staging: allArtifactRoots.staging,
    stagingQuarantine: allArtifactRoots.stagingQuarantine,
  });
  const workspaceRoots = await bindPrivateRoots({
    active: join(bound.ownedRoots.workspaces.canonicalPath, "active"),
    creations: join(bound.ownedRoots.workspaces.canonicalPath, "creations"),
    frozen: join(bound.ownedRoots.workspaces.canonicalPath, "frozen"),
    receipts: join(bound.ownedRoots.workspaces.canonicalPath, "receipts"),
    seals: join(bound.ownedRoots.workspaces.canonicalPath, "seals"),
    staging: join(bound.ownedRoots.workspaces.canonicalPath, "staging"),
    stagingQuarantine: join(bound.ownedRoots.workspaces.canonicalPath, "staging-quarantine"),
  }, bound.ownedRoots.workspaces) as ContainedTurnArtifactWorkspaceRoots;
  const rehydrationRoots = await bindPrivateRoots({
    metadataStaging: join(bound.ownedRoots.rehydration.canonicalPath, "metadata-staging"),
    metadataStagingQuarantine: join(
      bound.ownedRoots.rehydration.canonicalPath,
      "metadata-staging-quarantine",
    ),
    quarantine: join(bound.ownedRoots.rehydration.canonicalPath, "quarantine"),
    records: join(bound.ownedRoots.rehydration.canonicalPath, "records"),
    results: join(bound.ownedRoots.rehydration.canonicalPath, "results"),
    staging: join(bound.ownedRoots.rehydration.canonicalPath, "staging"),
  }, bound.ownedRoots.rehydration) as ContainedTurnArtifactRehydrationRoots;
  const startupHandles = await openBoundDirectories([
    artifactRoots.staging,
    artifactRoots.stagingQuarantine,
    workspaceRoots.staging,
    workspaceRoots.stagingQuarantine,
    rehydrationRoots.staging,
    rehydrationRoots.quarantine,
    rehydrationRoots.records,
    rehydrationRoots.metadataStaging,
    rehydrationRoots.metadataStagingQuarantine,
  ]);
  try {
    await withStableDirectoryProcessLock(
      startupHandles[0],
      async () => quarantineAmbiguousStagingDirectory(
        startupHandles[0], startupHandles[1], STAGING_ENTRY_LIMIT,
      ),
      { onContention: () => options.testFaults?.checkpoint(
        "artifact.cas-startup.exclusion-waiting",
      ) },
    );
    await withStableDirectoryProcessLock(
      startupHandles[2],
      async () => quarantineAmbiguousStagingDirectory(
        startupHandles[2], startupHandles[3], STAGING_ENTRY_LIMIT,
      ),
      { onContention: () => options.testFaults?.checkpoint(
        "workspace.staging-startup.exclusion-waiting",
      ) },
    );
    await withStableDirectoryProcessLock(
      startupHandles[4],
      async () => recoverRehydrationStaging(
        startupHandles[4], startupHandles[5], startupHandles[6],
      ),
      { onContention: () => options.testFaults?.checkpoint(
        "artifact.rehydrate-startup.exclusion-waiting",
      ) },
    );
    await withStableDirectoryProcessLock(
      startupHandles[7],
      async () => quarantineAmbiguousStagingDirectory(
        startupHandles[7], startupHandles[8], STAGING_ENTRY_LIMIT,
      ),
      { onContention: () => options.testFaults?.checkpoint(
        "artifact.rehydrate-metadata-startup.exclusion-waiting",
      ) },
    );
  } finally {await closeContainedTurnArtifactHandles(startupHandles);}
  return Object.freeze({
    artifactRoots,
    custodyRoots: Object.freeze([
      bound.canonicalProjectRoot,
      bound.disposableRoot,
      ...Object.values(bound.ownedRoots),
    ]),
    rehydrationRoots,
    resultPublications: allArtifactRoots.results,
    workspaceRoots,
  });
};
