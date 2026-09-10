import type { StableFilesystemHandle } from "@agent-teams/filesystem-custody/composition";

import type { ContainedTurnFilesystemWorkspacePort as ContainedTurnWorkspacePort } from "./contained-turn-filesystem-port.js";
import {
  inspectFileHandle,
  openDirectoryEntry,
  revalidateBoundRoots,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import { readStableFileAt, writeImmutableFileAt } from "./contained-turn-durable-file.js";
import {
  createWorkspaceClosureRecord,
  encodeWorkspaceClosureRecord,
  parseWorkspaceClosureRecord,
  parseWorkspaceCreationRecord,
  parseWorkspaceSealRecord,
  sameWorkspaceClosureRecord,
} from "./contained-turn-workspace-state.js";
import {
  assertDirectoryIdentityAt,
  assertWorkspaceRef,
  closeWorkspaceHandles,
  directoryExistsAt,
  prefixedWorkspaceFaults,
  readOptionalWorkspaceFileAt,
  sameScope,
  unlinkOptionalAt,
  workspaceName,
  workspaceRecordBytes,
  type ContainedTurnWorkspaceContext,
} from "./contained-turn-workspace-io.js";
import {
  moveDirectoryNoReplace,
  requireDirectoryPublication,
} from "./contained-turn-directory-publication.js";

const replayClosedWorkspace = async (input: {
  readonly closing: StableFilesystemHandle;
  readonly name: string;
  readonly receiptName: string;
  readonly receipts: StableFilesystemHandle;
  readonly seals: StableFilesystemHandle;
}): Promise<{ readonly receiptRef: string } | undefined> => {
  const receiptBytes = await readOptionalWorkspaceFileAt(input.receipts, input.receiptName);
  if (receiptBytes === undefined) {return undefined;}
  const existing = parseWorkspaceClosureRecord(receiptBytes);
  const sealBytes = await readOptionalWorkspaceFileAt(input.seals, input.receiptName);
  if (sealBytes === undefined) {
    throw new Error("contained turn workspace closure receipt has no retained seal");
  }
  const expected = createWorkspaceClosureRecord(input.name, parseWorkspaceSealRecord(sealBytes));
  if (
    !sameWorkspaceClosureRecord(existing, expected) ||
    workspaceName(existing.operationId, existing.scope) !== input.name
  ) {
    throw new Error("contained turn workspace closure receipt identity mismatch");
  }
  await unlinkOptionalAt(input.closing, input.receiptName);
  return Object.freeze({ receiptRef: existing.receiptRef });
};

const assertReceiptCustody = async (input: {
  readonly active: StableFilesystemHandle;
  readonly cleanup: StableFilesystemHandle;
  readonly closed: StableFilesystemHandle;
  readonly frozen: StableFilesystemHandle;
  readonly name: string;
  readonly rootIdentity: Readonly<{ dev: string; ino: string }>;
}): Promise<void> => {
  const activeResidue = await directoryExistsAt(input.active, input.name);
  const frozenResidue = await directoryExistsAt(input.frozen, input.name);
  const cleanupResidue = await directoryExistsAt(input.cleanup, input.name);
  const closedExists = await directoryExistsAt(input.closed, input.name);
  if (activeResidue || frozenResidue || cleanupResidue || !closedExists) {
    throw new Error("contained turn workspace closure receipt conflicts with retained custody");
  }
  await assertDirectoryIdentityAt(input.closed, input.name, input.rootIdentity);
};

/** Repeatable durable recovery with a fresh native closed-inode query.
 * Post-release readClosed belongs to the later native release/readback lifecycle. */
export const queryContainedTurnWorkspaceClosure = async (
  input: Parameters<ContainedTurnWorkspacePort["close"]>[0],
  context: ContainedTurnWorkspaceContext,
): Promise<{ readonly receiptRef: string } | undefined> => {
  const { custodyRoots, roots } = context;
  await revalidateBoundRoots(custodyRoots);
  const name = assertWorkspaceRef(input.workspaceRef, roots.active.canonicalPath);
  if (workspaceName(input.operationId, input.scope) !== name) {
    throw new Error("contained turn workspace closure query scope or operation mismatch");
  }
  const recordName = `${name}.json`;
  const handles = await openBoundDirectories([
    roots.active, roots.cleanup, roots.closed, roots.frozen,
    roots.receipts, roots.seals, roots.creations,
  ]);
  const [active, cleanup, closed, frozen, receipts, seals, creations] = handles;
  try {
    const creation = parseWorkspaceCreationRecord(await readStableFileAt(
      creations, recordName, workspaceRecordBytes,
    ));
    if (
      creation.operationId !== input.operationId || creation.workspaceName !== name ||
      !sameScope(creation.scope, input.scope)
    ) {
      throw new Error("contained turn workspace closure query conflicts with creation binding");
    }
    const receiptBytes = await readOptionalWorkspaceFileAt(receipts, recordName);
    if (receiptBytes === undefined) {return undefined;}
    const sealBytes = await readOptionalWorkspaceFileAt(seals, recordName);
    if (sealBytes === undefined) {
      throw new Error("contained turn workspace closure receipt has no retained seal");
    }
    const existing = parseWorkspaceClosureRecord(receiptBytes);
    const expected = createWorkspaceClosureRecord(name, parseWorkspaceSealRecord(sealBytes));
    if (!sameWorkspaceClosureRecord(existing, expected) ||
      workspaceName(existing.operationId, existing.scope) !== name) {
      throw new Error("contained turn workspace closure query identity mismatch");
    }
    if (context.nativeWorkspace === undefined) {
      await assertReceiptCustody({
        active, cleanup, closed, frozen, name, rootIdentity: creation.rootIdentity,
      });
    } else if (!sameWorkspaceClosureRecord(await context.nativeWorkspace.queryClosed(), existing)) {
      throw new Error("contained turn native closed observation conflicts with genuine closure");
    }
    return Object.freeze({ receiptRef: existing.receiptRef });
  } finally {await closeWorkspaceHandles(handles);}
};

const prepareClosedWorkspaceCustody = async (input: {
  readonly active: StableFilesystemHandle;
  readonly cleanup: StableFilesystemHandle;
  readonly closed: StableFilesystemHandle;
  readonly closingBytes: Buffer | undefined;
  readonly faults: ContainedTurnWorkspaceContext["options"]["testFaults"];
  readonly frozen: StableFilesystemHandle;
  readonly name: string;
  readonly seal: ReturnType<typeof parseWorkspaceSealRecord>;
}): Promise<void> => {
  const activeExists = await directoryExistsAt(input.active, input.name);
  const frozenExists = await directoryExistsAt(input.frozen, input.name);
  const cleanupExists = await directoryExistsAt(input.cleanup, input.name);
  const closedExists = await directoryExistsAt(input.closed, input.name);
  if (activeExists || [frozenExists, cleanupExists, closedExists].filter(Boolean).length > 1) {
    throw new Error("contained turn workspace has conflicting closure custody");
  }
  if (frozenExists) {
    const frozenWorkspace = await openDirectoryEntry(input.frozen, input.name);
    try {
      const identity = await inspectFileHandle(frozenWorkspace);
      if (
        identity.dev.toString() !== input.seal.rootIdentity.dev ||
        identity.ino.toString() !== input.seal.rootIdentity.ino
      ) {
        throw new Error("contained turn frozen workspace identity changed after sealing");
      }
    } finally {await frozenWorkspace.close();}
    requireDirectoryPublication(await moveDirectoryNoReplace({
      checkpoint: "workspace.close.freeze-to-cleanup",
      destinationDirectory: input.cleanup,
      destinationName: input.name,
      expectedSourceIdentity: {
        dev: BigInt(input.seal.rootIdentity.dev), ino: BigInt(input.seal.rootIdentity.ino),
      },
      faults: input.faults,
      sourceDirectory: input.frozen,
      sourceName: input.name,
    }), "workspace cleanup transition");
    await input.faults?.checkpoint("workspace.close.frozen-moved");
  } else if (!cleanupExists && !closedExists && input.closingBytes === undefined) {
    throw new Error("contained turn frozen workspace disappeared before closure");
  }
};

const readBoundClosureSeal = async (
  seals: StableFilesystemHandle, recordName: string, name: string,
  input: Parameters<ContainedTurnWorkspacePort["close"]>[0],
  creation: ReturnType<typeof parseWorkspaceCreationRecord>,
) => {
  const sealBytes = await readOptionalWorkspaceFileAt(seals, recordName);
  if (sealBytes === undefined) {throw new Error("contained turn workspace has no frozen artifact seal");}
  const seal = parseWorkspaceSealRecord(sealBytes);
  if (
      seal.workspaceName !== name || workspaceName(seal.operationId, seal.scope) !== name ||
      seal.operationId !== input.operationId || !sameScope(seal.scope, input.scope)
  ) {
      throw new Error("contained turn workspace seal identity mismatch");
  }
  if (
      seal.rootIdentity.dev !== creation.rootIdentity.dev ||
      seal.rootIdentity.ino !== creation.rootIdentity.ino
  ) {
      throw new Error("contained turn workspace seal conflicts with creation root identity");
  }
  return seal;
};

export const closeContainedTurnWorkspace = async (
  input: Parameters<ContainedTurnWorkspacePort["close"]>[0],
  context: ContainedTurnWorkspaceContext,
): Promise<{ readonly receiptRef: string }> => {
  const { custodyRoots, options, roots } = context;
  await revalidateBoundRoots(custodyRoots);
  const name = assertWorkspaceRef(input.workspaceRef, roots.active.canonicalPath);
  if (workspaceName(input.operationId, input.scope) !== name) {
    throw new Error("contained turn workspace close scope or operation mismatch");
  }
  const recordName = `${name}.json`;
  const handles = await openBoundDirectories([
    roots.active, roots.cleanup, roots.closed, roots.closing,
    roots.frozen, roots.receipts, roots.seals, roots.creations, roots.staging,
  ]);
  const [active, cleanup, closed, closing, frozen, receipts, seals, creations, metadataStaging] = handles;
  try {
    const creation = parseWorkspaceCreationRecord(await readStableFileAt(
      creations, recordName, workspaceRecordBytes,
    ));
    if (
      creation.operationId !== input.operationId || creation.workspaceName !== name ||
      !sameScope(creation.scope, input.scope)
    ) {
      throw new Error("contained turn workspace close conflicts with creation binding");
    }
    if (await readOptionalWorkspaceFileAt(receipts, recordName) !== undefined) {
      if (context.nativeWorkspace === undefined) {
        await assertReceiptCustody({ active, cleanup, closed, frozen, name, rootIdentity: creation.rootIdentity });
      } else {
        const observed = await context.nativeWorkspace.queryClosed();
        const recorded = parseWorkspaceClosureRecord(await readStableFileAt(
          receipts, recordName, workspaceRecordBytes,
        ));
        if (!sameWorkspaceClosureRecord(observed, recorded)) {
          throw new Error("contained turn native closed observation conflicts with genuine closure");
        }
      }
    }
    const replayed = await replayClosedWorkspace({ closing, name, receiptName: recordName, receipts, seals });
    if (replayed !== undefined) {return replayed;}
    const seal = await readBoundClosureSeal(seals, recordName, name, input, creation);
    const expectedClosure = createWorkspaceClosureRecord(name, seal);
    const closingBytes = await readOptionalWorkspaceFileAt(closing, recordName);
    if (closingBytes !== undefined && !sameWorkspaceClosureRecord(
      parseWorkspaceClosureRecord(closingBytes), expectedClosure,
    )) {
      throw new Error("contained turn workspace closing record conflicts with its frozen seal");
    }
    if (context.nativeWorkspace === undefined) {
      await prepareClosedWorkspaceCustody({
        active, cleanup, closed, closingBytes, faults: options.testFaults, frozen, name, seal,
      });
    } else {await context.nativeWorkspace.cleanup();}
    const closureBytes = encodeWorkspaceClosureRecord(expectedClosure);
    if (closingBytes === undefined) {
      await writeImmutableFileAt({
        bytes: closureBytes,
        faults: prefixedWorkspaceFaults(options.testFaults, "workspace.close"),
        finalDirectory: closing,
        finalName: recordName,
        stagingDirectory: metadataStaging,
        temporaryKind: "metadata",
      });
    }
    if (context.nativeWorkspace !== undefined) {
      await context.nativeWorkspace.close();
      await options.testFaults?.checkpoint("workspace.close.retained");
    } else if (await directoryExistsAt(cleanup, name)) {
      await assertDirectoryIdentityAt(cleanup, name, seal.rootIdentity);
      requireDirectoryPublication(await moveDirectoryNoReplace({
        checkpoint: "workspace.close.cleanup-to-closed",
        destinationDirectory: closed,
        destinationName: name,
        expectedSourceIdentity: {
          dev: BigInt(seal.rootIdentity.dev), ino: BigInt(seal.rootIdentity.ino),
        },
        faults: options.testFaults,
        sourceDirectory: cleanup,
        sourceName: name,
      }), "workspace retained closure");
      await options.testFaults?.checkpoint("workspace.close.retained");
    }
    if (context.nativeWorkspace === undefined) {
      await assertDirectoryIdentityAt(closed, name, seal.rootIdentity);
    }
    await writeImmutableFileAt({
      bytes: closureBytes,
      faults: prefixedWorkspaceFaults(options.testFaults, "workspace.receipt"),
      finalDirectory: receipts,
      finalName: recordName,
      stagingDirectory: metadataStaging,
      temporaryKind: "metadata",
    });
    await context.nativeWorkspace?.acknowledgeClosure();
    await unlinkOptionalAt(closing, recordName);
    return { receiptRef: expectedClosure.receiptRef };
  } finally {await closeWorkspaceHandles(handles);}
};
