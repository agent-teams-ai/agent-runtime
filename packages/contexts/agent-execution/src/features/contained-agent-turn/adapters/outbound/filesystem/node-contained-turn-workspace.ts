import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody";

import type { ContainedTurnKernelWorkspacePort } from "../../../application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnIdentity,
  type ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnFilesystemWorkspacePort as ContainedTurnWorkspacePort } from "./contained-turn-filesystem-port.js";
import {
  bindContainedTurnRootSet,
  guardContainedTurnFilesystemOperation,
  isMissingFilesystemEntry,
  revalidateBoundRoots,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import { readDirectoryNamesBounded } from "./contained-turn-filesystem-reads.js";
import {
  readStableFileAt,
  quarantineAmbiguousStagingDirectory,
  writeImmutableFileAt,
  type ContainedTurnFilesystemFaults,
} from "./contained-turn-durable-file.js";
import {
  DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  scanContainedTurnWorkspace,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";
import {
  parseWorkspaceCreationRecord,
} from "./contained-turn-workspace-state.js";
import {
  bindContainedTurnWorkspaceRoots,
} from "./contained-turn-workspace-custody.js";
import {
  closeContainedTurnWorkspace,
  queryContainedTurnWorkspaceClosure,
} from "./contained-turn-workspace-closure.js";
import {
  assertDirectoryIdentityAt,
  assertWorkspaceRef,
  closeWorkspaceHandles as closeHandles,
  directoryExistsAt,
  readOptionalWorkspaceFileAt as readOptionalFileAt,
  sameScope,
  workspaceName,
  workspaceRecordBytes as RECORD_BYTES,
  type ContainedTurnWorkspaceContext as WorkspaceContext,
} from "./contained-turn-workspace-io.js";
import { moveDirectoryNoReplace, requireDirectoryPublication } from "./contained-turn-directory-publication.js";
import { retainWorkspaceCapability } from "./contained-turn-workspace-capability.js";
import { createContainedTurnWorkspace } from "./contained-turn-workspace-creation.js";
import {
  encodeKernelClosureRecord,
  kernelClosureEvidenceId,
  kernelClosureProofId,
  kernelClosureRecordName,
  parseKernelClosureRecord,
  sameKernelClosureRequest,
  type KernelWorkspaceClosureRecord,
} from "./contained-turn-kernel-closure-record.js";

export interface NodeContainedTurnWorkspaceOptions {
  readonly canonicalProjectRoot: string;
  readonly disposableRoot: string;
  readonly limits?: ContainedTurnWorkspaceTreeLimits;
  readonly root: string;
  readonly testFaults?: ContainedTurnFilesystemFaults;
}

export type NodeContainedTurnWorkspace =
  ContainedTurnWorkspacePort & ContainedTurnKernelWorkspacePort;

const kernelWorkspaceName = (workspaceId: ContainedTurnWorkspaceId): string => {
  const match = /^workspace:(operation-[a-f\d]{64})$/u.exec(workspaceId);
  if (match?.[1] === undefined) {
    throw new Error("contained turn kernel workspace identity is not an opaque custody identity");
  }
  return match[1];
};

const kernelWorkspaceId = (name: string): ContainedTurnWorkspaceId =>
  containedTurnIdentity("workspace", `workspace:${name}`);

const resolveKernelWorkspace = async (
  input: Readonly<{ operationId: string; workspaceId: ContainedTurnWorkspaceId }>,
  context: WorkspaceContext,
) => {
  await revalidateBoundRoots(context.custodyRoots);
  const name = kernelWorkspaceName(input.workspaceId);
  const [creations] = await openBoundDirectories([context.roots.creations]);
  try {
    const creation = parseWorkspaceCreationRecord(await readStableFileAt(
      creations, `${name}.json`, RECORD_BYTES,
    ));
    if (
      creation.operationId !== input.operationId || creation.workspaceName !== name ||
      workspaceName(creation.operationId, creation.scope) !== name
    ) {
      throw new Error("contained turn kernel workspace identity conflicts with owner creation facts");
    }
    return Object.freeze({
      name,
      operationId: creation.operationId,
      scope: creation.scope,
      workspaceRef: join(context.roots.active.canonicalPath, name),
    });
  } finally {await closeHandles([creations]);}
};

const verifyWorkspace = async (
  input: Parameters<ContainedTurnWorkspacePort["verify"]>[0],
  context: WorkspaceContext,
): Promise<Awaited<ReturnType<ContainedTurnWorkspacePort["verify"]>>> => {
  await revalidateBoundRoots(context.custodyRoots);
  const name = assertWorkspaceRef(input.workspaceRef, context.roots.active.canonicalPath);
  if (workspaceName(input.operationId, input.scope) !== name) {
    throw new Error("contained turn workspace lookup scope or operation mismatch");
  }
  const [active, creations] = await openBoundDirectories([
    context.roots.active, context.roots.creations,
  ]);
  try {
    const record = parseWorkspaceCreationRecord(await readStableFileAt(
      creations,
      `${name}.json`,
      RECORD_BYTES,
    ));
    if (record.operationId !== input.operationId || !sameScope(record.scope, input.scope)) {
      throw new Error("contained turn workspace creation binding conflicts with lookup");
    }
    await assertDirectoryIdentityAt(active, name, record.rootIdentity);
    const tree = await scanContainedTurnWorkspace(
      input.workspaceRef,
      context.options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
    );
    if (tree.treeDigest !== record.materializationDigest) {
      throw new Error("contained turn workspace changed before dispatch lookup");
    }
    return await retainWorkspaceCapability({
      canonicalPath: input.workspaceRef,
      name,
      operationId: input.operationId,
      parent: active,
      scope: input.scope,
      workspaceRef: input.workspaceRef,
    });
  } finally {await closeHandles([active, creations]);}
};

const quarantineWorkspace = async (
  input: Parameters<ContainedTurnWorkspacePort["quarantine"]>[0],
  context: WorkspaceContext,
): Promise<void> => {
  const { custodyRoots, roots } = context;
  await revalidateBoundRoots(custodyRoots);
  const name = assertWorkspaceRef(input.workspaceRef, roots.active.canonicalPath);
  if (workspaceName(input.operationId, input.scope) !== name) {
    throw new Error("contained turn workspace quarantine scope or operation mismatch");
  }
  const suffix = createHash("sha256").update(input.evidenceRef).digest("hex");
  const quarantineName = `${name}-${suffix}`;
  const handles = await openBoundDirectories([
    roots.active, roots.cleanup, roots.frozen, roots.quarantine,
    roots.receipts, roots.creations,
  ]);
  const [active, cleanup, frozen, quarantine, receipts, creations] = handles;
  try {
    const creation = parseWorkspaceCreationRecord(await readStableFileAt(
      creations,
      `${name}.json`,
      RECORD_BYTES,
    ));
    if (creation.operationId !== input.operationId || !sameScope(creation.scope, input.scope)) {
      throw new Error("contained turn workspace quarantine conflicts with creation binding");
    }
    if (await readOptionalFileAt(receipts, `${name}.json`) !== undefined) {
      throw new Error("contained turn closed workspace cannot be quarantined");
    }
    const present: FileHandle[] = [];
    for (const source of [active, frozen, cleanup]) {
      if (await directoryExistsAt(source, name)) {present.push(source);}
    }
    if (present.length > 1) {
      throw new Error("contained turn workspace quarantine custody is conflicting");
    }
    const source = present[0];
    if (source !== undefined) {
      if (await directoryExistsAt(quarantine, quarantineName)) {
        throw new Error("contained turn workspace has conflicting active and quarantined custody");
      }
      await assertDirectoryIdentityAt(source, name, creation.rootIdentity);
      requireDirectoryPublication(await moveDirectoryNoReplace({
        checkpoint: "workspace.quarantine",
        destinationDirectory: quarantine,
        destinationName: quarantineName,
        expectedSourceIdentity: {
          dev: BigInt(creation.rootIdentity.dev),
          ino: BigInt(creation.rootIdentity.ino),
        },
        faults: context.options.testFaults,
        sourceDirectory: source,
        sourceName: name,
      }), "workspace quarantine");
      return;
    }
    const existing = (await readDirectoryNamesBounded(quarantine, 4_096))
      .filter(candidate => candidate.startsWith(`${name}-`));
    if (existing.length !== 1 || existing[0] !== quarantineName) {
      throw new Error("contained turn workspace quarantine outcome is ambiguous");
    }
    await assertDirectoryIdentityAt(quarantine, quarantineName, creation.rootIdentity);
  } finally {await closeHandles(handles);}
};

export const createNodeContainedTurnWorkspace = async (
  options: NodeContainedTurnWorkspaceOptions,
): Promise<NodeContainedTurnWorkspace> => guardContainedTurnFilesystemOperation(
  "workspace_initialize",
  async () => {
  const bound = await bindContainedTurnRootSet({
    canonicalProjectRoot: options.canonicalProjectRoot,
    disposableRoot: options.disposableRoot,
    ownedRoots: { workspace: options.root },
  });
  const roots = await bindContainedTurnWorkspaceRoots(bound.ownedRoots.workspace);
  const [staging, stagingQuarantine] = await openBoundDirectories([
    roots.staging, roots.stagingQuarantine,
  ]);
  try {
    await withStableDirectoryProcessLock(
      staging,
      async () => quarantineAmbiguousStagingDirectory(staging, stagingQuarantine, 128),
      { onContention: () => options.testFaults?.checkpoint(
        "workspace.staging-startup.exclusion-waiting",
      ) },
    );
  } finally {await closeHandles([staging, stagingQuarantine]);}
  const context = Object.freeze({
    custodyRoots: Object.freeze([
      bound.canonicalProjectRoot,
      bound.disposableRoot,
      bound.ownedRoots.workspace,
    ]),
    options,
    roots,
  });
  const inflightCreations = new Map<string, Promise<{ readonly workspaceRef: string }>>();
  const createIdempotently = async (
    input: Parameters<ContainedTurnWorkspacePort["create"]>[0],
  ): Promise<{ readonly workspaceId: ContainedTurnWorkspaceId; readonly workspaceRef: string }> => {
    const key = workspaceName(input.operationId, input.scope);
    const existing = inflightCreations.get(key);
    if (existing !== undefined) {
      const created = await existing;
      return Object.freeze({ ...created, workspaceId: kernelWorkspaceId(key) });
    }
    const pending = createContainedTurnWorkspace(input, context);
    inflightCreations.set(key, pending);
    try {
      return Object.freeze({ ...(await pending), workspaceId: kernelWorkspaceId(key) });
    } finally {
      if (inflightCreations.get(key) === pending) {inflightCreations.delete(key);}
    }
  };

  const readKernelBinding = async (
    input: Parameters<ContainedTurnKernelWorkspacePort["queryClosure"]>[0],
  ): Promise<KernelWorkspaceClosureRecord | undefined> => {
    const [receipts] = await openBoundDirectories([roots.receipts]);
    try {
      let bytes: Buffer;
      try {
        bytes = await readStableFileAt(
          receipts, kernelClosureRecordName("workspace_closure", input.requestDigest), RECORD_BYTES,
        );
      } catch (error) {
        if (isMissingFilesystemEntry(error)) {return undefined;}
        throw error;
      }
      const record = parseKernelClosureRecord(bytes);
      if (record.kind !== "workspace_closure") {
        throw new Error("contained turn workspace kernel closure record has the wrong kind");
      }
      return record;
    } finally {await closeHandles([receipts]);}
  };

  const queryKernelClosure = async (
    input: Parameters<ContainedTurnKernelWorkspacePort["queryClosure"]>[0],
  ): ReturnType<ContainedTurnKernelWorkspacePort["queryClosure"]> => {
    const resolved = await resolveKernelWorkspace(input, context);
    const actual = await queryContainedTurnWorkspaceClosure(resolved, context);
    const record = await readKernelBinding(input);
    if (actual === undefined || record === undefined) {
      return Object.freeze({
        evidenceId: kernelClosureEvidenceId({
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          source: actual === undefined ? "workspace_receipt_missing" : "workspace_binding_missing",
        }),
        kind: "indeterminate" as const,
      });
    }
    if (!sameKernelClosureRequest(record, input) || record.receiptRef !== actual.receiptRef) {
      return Object.freeze({
        evidenceId: kernelClosureEvidenceId({
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          source: "workspace_binding_conflict",
        }),
        kind: "identity_conflict" as const,
      });
    }
    return Object.freeze({
      kind: "proved" as const,
      proof: Object.freeze({
        binding: Object.freeze({
          authorityVectorDigest: record.authorityVectorDigest,
          operationId: record.operationId,
          workspaceId: record.workspaceId,
        }),
        kind: "workspace_closure" as const,
        proofId: kernelClosureProofId(record, "workspace_closure"),
      }),
      requestDigest: record.requestDigest,
      requestId: record.requestId,
    });
  };

  const ensureKernelClosed = async (
    input: Parameters<ContainedTurnKernelWorkspacePort["ensureClosed"]>[0],
  ): ReturnType<ContainedTurnKernelWorkspacePort["ensureClosed"]> => {
    const observed = await queryKernelClosure(input);
    if (observed.kind !== "indeterminate") {return observed;}
    const resolved = await resolveKernelWorkspace(input, context);
    const actual = await closeContainedTurnWorkspace(resolved, context);
    const record: KernelWorkspaceClosureRecord = Object.freeze({
      authorityVectorDigest: input.authorityVectorDigest,
      kind: "workspace_closure",
      operationId: input.operationId,
      receiptRef: actual.receiptRef,
      requestDigest: input.requestDigest,
      requestId: input.requestId,
      schemaVersion: 1,
      workspaceId: input.workspaceId,
    });
    const [receipts, staging] = await openBoundDirectories([roots.receipts, roots.staging]);
    try {
      await writeImmutableFileAt({
        bytes: encodeKernelClosureRecord(record),
        faults: options.testFaults,
        finalDirectory: receipts,
        finalName: kernelClosureRecordName(record.kind, record.requestDigest),
        stagingDirectory: staging,
        temporaryKind: "metadata",
      });
    } finally {await closeHandles([receipts, staging]);}
    return queryKernelClosure(input);
  };

  const legacyClose = (input: Parameters<ContainedTurnWorkspacePort["close"]>[0]) =>
    guardContainedTurnFilesystemOperation(
      "workspace_close", () => closeContainedTurnWorkspace(input, context), options.testFaults !== undefined,
    );
  function close(input: Parameters<ContainedTurnWorkspacePort["close"]>[0]): ReturnType<ContainedTurnWorkspacePort["close"]>;
  function close(input: Parameters<ContainedTurnKernelWorkspacePort["close"]>[0]): ReturnType<ContainedTurnKernelWorkspacePort["close"]>;
  function close(
    input: Parameters<ContainedTurnWorkspacePort["close"]>[0] |
      Parameters<ContainedTurnKernelWorkspacePort["close"]>[0],
  ): ReturnType<ContainedTurnWorkspacePort["close"]> | ReturnType<ContainedTurnKernelWorkspacePort["close"]> {
    if ("scope" in input) {return legacyClose(input);}
    return Promise.resolve(Object.freeze({
      evidenceId: kernelClosureEvidenceId({
        operationId: input.operationId,
        source: "unstaged_workspace_close",
      }),
      kind: "indeterminate" as const,
    }));
  }

  function quarantine(input: Parameters<ContainedTurnWorkspacePort["quarantine"]>[0]): ReturnType<ContainedTurnWorkspacePort["quarantine"]>;
  function quarantine(input: Parameters<ContainedTurnKernelWorkspacePort["quarantine"]>[0]): ReturnType<ContainedTurnKernelWorkspacePort["quarantine"]>;
  async function quarantine(
    input: Parameters<ContainedTurnWorkspacePort["quarantine"]>[0] |
      Parameters<ContainedTurnKernelWorkspacePort["quarantine"]>[0],
  ): Promise<void> {
    const durable = "scope" in input ? input : Object.freeze({
      evidenceRef: input.evidenceId,
      ...(await resolveKernelWorkspace(input, context)),
    });
    await guardContainedTurnFilesystemOperation(
      "workspace_quarantine", () => quarantineWorkspace(durable, context),
      options.testFaults !== undefined,
    );
  }

  const adapter: NodeContainedTurnWorkspace = {
    close,
    create: input => guardContainedTurnFilesystemOperation(
      "workspace_create", () => createIdempotently(input), options.testFaults !== undefined,
    ),
    ensureClosed: input => guardContainedTurnFilesystemOperation(
      "workspace_ensure_closed", () => ensureKernelClosed(input), options.testFaults !== undefined,
    ),
    quarantine,
    queryClosure: input => guardContainedTurnFilesystemOperation(
      "workspace_query_closure", () => queryKernelClosure(input), options.testFaults !== undefined,
    ),
    verify: input => guardContainedTurnFilesystemOperation(
      "workspace_verify", () => verifyWorkspace(input, context), options.testFaults !== undefined,
    ),
  };
  return Object.freeze(adapter);
  },
  options.testFaults !== undefined,
);
