import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ContainedTurnFilesystemArtifactPort as ContainedTurnArtifactPort } from "./contained-turn-filesystem-port.js";
import {
  computeContainedTurnArtifactTreeDigest,
  encodeContainedTurnArtifactManifest,
  MAX_CONTAINED_TURN_ARTIFACT_OUTPUT_RECORDS,
  type ContainedTurnArtifactEntry,
  type ContainedTurnArtifactOutputRecord,
} from "./contained-turn-artifact-manifest.js";
import type { VerifiedStoredArtifact } from "./contained-turn-artifact-store.js";
import {
  closeContainedTurnArtifactHandles,
} from "./contained-turn-artifact-custody.js";
import {
  inspectFileHandle,
  isMissingFilesystemEntry,
  openDirectoryEntry,
  revalidateBoundRoots,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import {
  readStableFileAt,
  writeImmutableFileAt,
  type ContainedTurnFilesystemFaults,
} from "./contained-turn-durable-file.js";
import {
  moveDirectoryNoReplace,
  requireDirectoryPublication,
} from "./contained-turn-directory-publication.js";
import {
  encodeResultPublicationRecord,
  parseResultPublicationRecord,
  type ContainedTurnResultPublicationRecord,
} from "./contained-turn-result-publication.js";
import {
  containedTurnResultRefs,
  scopedArtifactWorkspaceName,
} from "./contained-turn-artifact-verification.js";
import {
  encodeWorkspaceSealRecord,
  parseWorkspaceClosureRecord,
  parseWorkspaceCreationRecord,
  parseWorkspaceSealRecord,
  type ContainedTurnWorkspaceSealRecord,
} from "./contained-turn-workspace-state.js";
import {
  scanContainedTurnWorkspace,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

const WORKSPACE_NAME = /^operation-[a-f\d]{64}$/u;
const RECORD_BYTES = 64 * 1_024;
type ArtifactSealInput = Parameters<ContainedTurnArtifactPort["seal"]>[0];

export interface ContainedTurnArtifactSealingContext {
  readonly contentDigest: (domain: "blob" | "manifest", bytes: Uint8Array) => string;
  readonly custodyRoots: readonly BoundContainedTurnRoot[];
  readonly limits: ContainedTurnWorkspaceTreeLimits;
  readonly resultPublications: BoundContainedTurnRoot;
  readonly testFaults?: ContainedTurnFilesystemFaults | undefined;
  readonly verifyArtifact: (digest: string) => Promise<VerifiedStoredArtifact>;
  readonly workspaceRoots: Readonly<Record<
    "active" | "creations" | "frozen" | "receipts" | "seals" | "staging",
    BoundContainedTurnRoot
  >>;
  readonly writeContentAddressed: (
    domain: "blob" | "manifest", digest: string, bytes: Buffer,
  ) => Promise<void>;
}

interface ProjectedOutput {
  readonly items: readonly Readonly<{
    bytes: Buffer;
    record: ContainedTurnArtifactOutputRecord;
  }>[];
  readonly records: readonly ContainedTurnArtifactOutputRecord[];
  readonly totalBytes: number;
}

interface SealDirectories {
  readonly active: FileHandle;
  readonly creations: FileHandle;
  readonly frozen: FileHandle;
  readonly handles: readonly FileHandle[];
  readonly metadataStaging: FileHandle;
  readonly receipts: FileHandle;
  readonly results: FileHandle;
  readonly seals: FileHandle;
}

const prefixedFaults = (
  faults: ContainedTurnFilesystemFaults | undefined,
  prefix: string,
): ContainedTurnFilesystemFaults | undefined => faults === undefined ? undefined : Object.freeze({
  checkpoint: (point: string) => faults.checkpoint(`${prefix}.${point}`),
});

const directoryExistsAt = async (parent: FileHandle, name: string): Promise<boolean> => {
  try {
    const child = await openDirectoryEntry(parent, name);
    await child.close();
    return true;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) {return false;}
    throw error;
  }
};

const readOptionalFileAt = async (
  parent: FileHandle, name: string, maxBytes: number,
): Promise<Buffer | undefined> => {
  try {return await readStableFileAt(parent, name, maxBytes);} catch (error) {
    if (isMissingFilesystemEntry(error)) {return undefined;}
    throw error;
  }
};

const assertWorkspaceRef = (workspaceRef: string, activeRoot: string): string => {
  if (
    !isAbsolute(workspaceRef) || resolve(workspaceRef) !== workspaceRef ||
    dirname(workspaceRef) !== activeRoot
  ) {
    throw new Error("contained turn artifact workspace reference is outside active custody");
  }
  const name = basename(workspaceRef);
  if (!WORKSPACE_NAME.test(name)) {
    throw new Error("contained turn artifact workspace reference has an invalid identity");
  }
  return name;
};

const projectOutput = (
  output: ArtifactSealInput["output"],
  limits: ContainedTurnWorkspaceTreeLimits,
  contentDigest: ContainedTurnArtifactSealingContext["contentDigest"],
): ProjectedOutput => {
  if (output.length > MAX_CONTAINED_TURN_ARTIFACT_OUTPUT_RECORDS) {
    throw new Error("contained turn artifact output exceeded its record limit");
  }
  const kinds = new Set(["assistant", "diagnostic", "progress"]);
  const items: { bytes: Buffer; record: ContainedTurnArtifactOutputRecord }[] = [];
  let totalBytes = 0;
  for (const [index, chunk] of output.entries()) {
    if (chunk.cursor !== index || !kinds.has(chunk.kind)) {
      throw new Error("contained turn artifact output projection is invalid");
    }
    const bytes = Buffer.from(chunk.text, "utf8");
    totalBytes += bytes.length;
    if (
      bytes.length > limits.maxFileBytes || !Number.isSafeInteger(totalBytes) ||
      totalBytes > limits.maxTotalBytes
    ) {
      throw new Error("contained turn artifact output exceeded its operation byte limit");
    }
    const record = Object.freeze({
      cursor: chunk.cursor,
      digest: contentDigest("blob", bytes),
      kind: chunk.kind,
      size: bytes.length,
    });
    items.push(Object.freeze({ bytes, record }));
  }
  return Object.freeze({
    items: Object.freeze(items),
    records: Object.freeze(items.map(item => item.record)),
    totalBytes,
  });
};

const assertOperationWorkspaceIdentity = (
  operationId: string, scope: ArtifactSealInput["scope"], name: string,
): void => {
  if (
    operationId.length === 0 || operationId.includes("\u0000") ||
    operationId !== operationId.normalize("NFC") || Buffer.byteLength(operationId, "utf8") > 1_024
  ) {
    throw new Error("contained turn artifact operation identity is invalid");
  }
  if (name !== scopedArtifactWorkspaceName(operationId, scope)) {
    throw new Error("contained turn artifact workspace belongs to another operation");
  }
};

const assertFrozenSealIdentity = async (
  frozen: FileHandle, name: string, seal: ContainedTurnWorkspaceSealRecord,
): Promise<void> => {
  if (!await directoryExistsAt(frozen, name)) {return;}
  const workspace = await openDirectoryEntry(frozen, name);
  try {
    const identity = await inspectFileHandle(workspace);
    if (identity.dev.toString() !== seal.rootIdentity.dev ||
      identity.ino.toString() !== seal.rootIdentity.ino) {
      throw new Error("contained turn frozen workspace identity conflicts with its seal");
    }
  } finally {await workspace.close();}
};

const assertDirectoryIdentityAt = async (
  parent: FileHandle, name: string, expected: Readonly<{ dev: string; ino: string }>,
): Promise<void> => {
  const directory = await openDirectoryEntry(parent, name);
  try {
    const identity = await inspectFileHandle(directory);
    if (identity.dev.toString() !== expected.dev || identity.ino.toString() !== expected.ino) {
      throw new Error("contained turn workspace directory identity was replaced");
    }
  } finally {await directory.close();}
};

const replayStateConflicts = (input: {
  readonly closure: ReturnType<typeof parseWorkspaceClosureRecord> | undefined;
  readonly manifestDigest: string | undefined;
  readonly name: string;
  readonly operationId: string;
  readonly seal: ContainedTurnWorkspaceSealRecord | undefined;
}): boolean => input.manifestDigest === undefined ||
  (input.seal !== undefined &&
    (input.seal.workspaceName !== input.name || input.seal.operationId !== input.operationId)) ||
  (input.closure !== undefined &&
    (input.closure.workspaceName !== input.name || input.closure.operationId !== input.operationId)) ||
  (input.seal !== undefined && input.closure !== undefined &&
    input.seal.manifestDigest !== input.closure.manifestDigest);

const replayManifestConflicts = (input: {
  readonly closure: ReturnType<typeof parseWorkspaceClosureRecord> | undefined;
  readonly operationId: string;
  readonly output: readonly ContainedTurnArtifactOutputRecord[];
  readonly scope: ArtifactSealInput["scope"];
  readonly seal: ContainedTurnWorkspaceSealRecord | undefined;
  readonly verified: VerifiedStoredArtifact;
}): boolean => input.verified.manifest.operationId !== input.operationId ||
  input.verified.manifest.tenantId !== input.scope.tenantId ||
  input.verified.manifest.projectId !== input.scope.projectId ||
  input.verified.manifest.treeDigest !== (input.seal?.treeDigest ?? input.closure?.treeDigest) ||
  JSON.stringify(input.verified.manifest.output) !== JSON.stringify(input.output);

const assertReplayScope = (
  seal: ContainedTurnWorkspaceSealRecord,
  closure: ReturnType<typeof parseWorkspaceClosureRecord> | undefined,
  scope: ArtifactSealInput["scope"],
): void => {
  if (
    seal.scope.tenantId !== scope.tenantId || seal.scope.projectId !== scope.projectId ||
    (closure !== undefined && (closure.scope.tenantId !== scope.tenantId ||
      closure.scope.projectId !== scope.projectId))
  ) {
    throw new Error("contained turn artifact replay scope conflicts with workspace state");
  }
};

const assertResultPublication = (input: {
  readonly manifestDigest: string;
  readonly name: string;
  readonly operationId: string;
  readonly publication: ContainedTurnResultPublicationRecord;
  readonly scope: ArtifactSealInput["scope"];
  readonly treeDigest: string;
}): ReturnType<typeof containedTurnResultRefs> => {
  const refs = containedTurnResultRefs(input.manifestDigest);
  const publication = input.publication;
  if (
    publication.manifestDigest !== input.manifestDigest ||
    publication.operationId !== input.operationId || publication.workspaceName !== input.name ||
    publication.treeDigest !== input.treeDigest ||
    publication.scope.tenantId !== input.scope.tenantId ||
    publication.scope.projectId !== input.scope.projectId ||
    publication.manifestReceiptRef !== refs.manifestReceiptRef ||
    publication.resultReceiptRef !== refs.resultReceiptRef || publication.resultRef !== refs.resultRef
  ) {
    throw new Error("contained turn result publication conflicts with retained seal evidence");
  }
  return refs;
};

const replaySealedArtifact = async (input: {
  readonly directories: SealDirectories;
  readonly name: string;
  readonly operationId: string;
  readonly output: readonly ContainedTurnArtifactOutputRecord[];
  readonly receiptName: string;
  readonly scope: ArtifactSealInput["scope"];
  readonly verifyArtifact: ContainedTurnArtifactSealingContext["verifyArtifact"];
}): Promise<ReturnType<typeof containedTurnResultRefs> | undefined> => {
  const { directories, name, operationId, output, receiptName, scope, verifyArtifact } = input;
  const sealBytes = await readOptionalFileAt(directories.seals, receiptName, RECORD_BYTES);
  const receiptBytes = await readOptionalFileAt(directories.receipts, receiptName, RECORD_BYTES);
  const publicationBytes = await readOptionalFileAt(directories.results, receiptName, RECORD_BYTES);
  if (sealBytes === undefined && receiptBytes === undefined && publicationBytes === undefined) {
    return undefined;
  }
  const seal = sealBytes === undefined ? undefined : parseWorkspaceSealRecord(sealBytes);
  const closure = receiptBytes === undefined ? undefined : parseWorkspaceClosureRecord(receiptBytes);
  if (seal === undefined) {throw new Error("contained turn artifact publication has no retained seal");}
  assertReplayScope(seal, closure, scope);
  const manifestDigest = seal.manifestDigest;
  if (replayStateConflicts({ closure, manifestDigest, name, operationId, seal })) {
    throw new Error("contained turn artifact replay state conflicts with its workspace");
  }
  if (manifestDigest === undefined) {throw new Error("contained turn replay manifest is missing");}
  const verified = await verifyArtifact(manifestDigest);
  if (replayManifestConflicts({ closure, operationId, output, scope, seal, verified })) {
    throw new Error("contained turn artifact replay manifest conflicts with workspace state");
  }
  if (await directoryExistsAt(directories.active, name)) {
    throw new Error("contained turn sealed workspace reappeared in active custody");
  }
  await assertFrozenSealIdentity(directories.frozen, name, seal);
  if (publicationBytes === undefined) {return undefined;}
  return assertResultPublication({
    manifestDigest,
    name,
    operationId,
    publication: parseResultPublicationRecord(publicationBytes),
    scope,
    treeDigest: verified.manifest.treeDigest,
  });
};

const openSealDirectories = async (
  context: ContainedTurnArtifactSealingContext,
): Promise<SealDirectories> => {
  const roots = context.workspaceRoots;
  const handles = await openBoundDirectories([
    roots.active, roots.creations, roots.frozen, roots.receipts,
    context.resultPublications, roots.seals, roots.staging,
  ]);
  const [active, creations, frozen, receipts, results, seals, metadataStaging] = handles;
  return { active, creations, frozen, handles, metadataStaging, receipts, results, seals };
};

const freezeWorkspace = async (input: {
  readonly context: ContainedTurnArtifactSealingContext;
  readonly creation: ReturnType<typeof parseWorkspaceCreationRecord>;
  readonly directories: SealDirectories;
  readonly name: string;
}): Promise<void> => {
  const { context, creation, directories, name } = input;
  const activeExists = await directoryExistsAt(directories.active, name);
  const frozenExists = await directoryExistsAt(directories.frozen, name);
  if (activeExists === frozenExists) {
    throw new Error("contained turn workspace has missing or conflicting artifact custody");
  }
  if (!activeExists) {return;}
  await assertDirectoryIdentityAt(directories.active, name, creation.rootIdentity);
  requireDirectoryPublication(await moveDirectoryNoReplace({
    checkpoint: "artifact.seal.freeze",
    destinationDirectory: directories.frozen,
    destinationName: name,
    expectedSourceIdentity: {
      dev: BigInt(creation.rootIdentity.dev), ino: BigInt(creation.rootIdentity.ino),
    },
    faults: context.testFaults,
    sourceDirectory: directories.active,
    sourceName: name,
  }), "artifact freeze publication");
  await context.testFaults?.checkpoint("artifact.seal.workspace-frozen");
};

const createManifest = async (input: {
  readonly context: ContainedTurnArtifactSealingContext;
  readonly name: string;
  readonly projectedOutput: ProjectedOutput;
  readonly request: ArtifactSealInput;
}): Promise<Readonly<{
  manifestBytes: Buffer;
  tree: Awaited<ReturnType<typeof scanContainedTurnWorkspace>>;
  treeDigest: string;
}>> => {
  const { context, name, projectedOutput, request } = input;
  const tree = await scanContainedTurnWorkspace(
    join(context.workspaceRoots.frozen.canonicalPath, name), context.limits, {
      checkpoint: point => context.testFaults?.checkpoint([
        "artifact.scan", point.phase, point.kind ?? "entry", encodeURIComponent(point.relativePath),
      ].join(".")),
      contentDigest: bytes => context.contentDigest("blob", bytes),
    },
  );
  const entries: ContainedTurnArtifactEntry[] = tree.entries.map(entry => entry.kind === "directory"
    ? Object.freeze({ kind: entry.kind, mode: entry.mode, path: entry.relativePath })
    : Object.freeze({
        digest: entry.digest, kind: entry.kind, mode: entry.mode,
        path: entry.relativePath, size: entry.size,
      }));
  const treeDigest = computeContainedTurnArtifactTreeDigest(entries);
  if (treeDigest !== tree.treeDigest) {
    throw new Error("contained turn workspace and manifest tree identities diverged");
  }
  const manifestBytes = encodeContainedTurnArtifactManifest(Object.freeze({
    schemaVersion: 3 as const,
    operationId: request.operationId,
    projectId: request.scope.projectId,
    tenantId: request.scope.tenantId,
    entries: Object.freeze(entries),
    output: projectedOutput.records,
    treeDigest,
  }));
  const treeBytes = tree.files.reduce((total, file) => total + file.size, 0);
  const totalBytes = treeBytes + projectedOutput.totalBytes + manifestBytes.length;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > context.limits.maxTotalBytes) {
    throw new Error("contained turn artifact manifest exceeded its operation byte limit");
  }
  return Object.freeze({ manifestBytes, tree, treeDigest });
};

const publishManifestContent = async (input: {
  readonly context: ContainedTurnArtifactSealingContext;
  readonly manifestBytes: Buffer;
  readonly projectedOutput: ProjectedOutput;
  readonly tree: Awaited<ReturnType<typeof scanContainedTurnWorkspace>>;
}): Promise<string> => {
  for (const file of input.tree.files) {
    await input.context.writeContentAddressed("blob", file.digest, file.bytes);
  }
  for (const item of input.projectedOutput.items) {
    await input.context.writeContentAddressed("blob", item.record.digest, item.bytes);
  }
  const manifestDigest = input.context.contentDigest("manifest", input.manifestBytes);
  await input.context.writeContentAddressed("manifest", manifestDigest, input.manifestBytes);
  return manifestDigest;
};

const recordSealAndResult = async (input: {
  readonly context: ContainedTurnArtifactSealingContext;
  readonly directories: SealDirectories;
  readonly manifestDigest: string;
  readonly name: string;
  readonly recordName: string;
  readonly request: ArtifactSealInput;
  readonly rootIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  readonly treeDigest: string;
}): Promise<ReturnType<typeof containedTurnResultRefs>> => {
  const { context, directories, manifestDigest, name, recordName, request,
    rootIdentity, treeDigest } = input;
  const seal: ContainedTurnWorkspaceSealRecord = Object.freeze({
    manifestDigest,
    operationId: request.operationId,
    rootIdentity: Object.freeze({ dev: rootIdentity.dev.toString(), ino: rootIdentity.ino.toString() }),
    schemaVersion: 2,
    scope: request.scope,
    treeDigest,
    workspaceName: name,
  });
  await writeImmutableFileAt({
    bytes: encodeWorkspaceSealRecord(seal),
    faults: prefixedFaults(context.testFaults, "artifact.seal-record"),
    finalDirectory: directories.seals,
    finalName: recordName,
    stagingDirectory: directories.metadataStaging,
    temporaryKind: "metadata",
  });
  await context.testFaults?.checkpoint("artifact.seal.recorded");
  const refs = containedTurnResultRefs(manifestDigest);
  const publication: ContainedTurnResultPublicationRecord = Object.freeze({
    manifestDigest,
    manifestReceiptRef: refs.manifestReceiptRef,
    operationId: request.operationId,
    resultReceiptRef: refs.resultReceiptRef,
    resultRef: refs.resultRef,
    schemaVersion: 1,
    scope: request.scope,
    treeDigest,
    workspaceName: name,
  });
  await writeImmutableFileAt({
    bytes: encodeResultPublicationRecord(publication),
    faults: prefixedFaults(context.testFaults, "artifact.result-record"),
    finalDirectory: directories.results,
    finalName: recordName,
    stagingDirectory: directories.metadataStaging,
    temporaryKind: "metadata",
  });
  await context.testFaults?.checkpoint("artifact.result.recorded");
  return refs;
};

export const sealContainedTurnArtifact = async (
  request: ArtifactSealInput,
  context: ContainedTurnArtifactSealingContext,
): ReturnType<ContainedTurnArtifactPort["seal"]> => {
  await revalidateBoundRoots(context.custodyRoots);
  const name = assertWorkspaceRef(request.workspaceRef, context.workspaceRoots.active.canonicalPath);
  assertOperationWorkspaceIdentity(request.operationId, request.scope, name);
  const projectedOutput = projectOutput(request.output, context.limits, context.contentDigest);
  const recordName = `${name}.json`;
  const directories = await openSealDirectories(context);
  try {
    const creation = parseWorkspaceCreationRecord(await readStableFileAt(
      directories.creations, recordName, RECORD_BYTES,
    ));
    if (
      creation.operationId !== request.operationId || creation.workspaceName !== name ||
      creation.scope.tenantId !== request.scope.tenantId ||
      creation.scope.projectId !== request.scope.projectId
    ) {
      throw new Error("contained turn artifact seal conflicts with workspace creation binding");
    }
    const replayed = await replaySealedArtifact({
      directories, name, operationId: request.operationId, output: projectedOutput.records,
      receiptName: recordName, scope: request.scope, verifyArtifact: context.verifyArtifact,
    });
    if (replayed !== undefined) {return replayed;}
    await freezeWorkspace({ context, creation, directories, name });
    const manifest = await createManifest({ context, name, projectedOutput, request });
    const manifestDigest = await publishManifestContent({
      context, manifestBytes: manifest.manifestBytes, projectedOutput, tree: manifest.tree,
    });
    const verified = await context.verifyArtifact(manifestDigest);
    if (verified.manifest.operationId !== request.operationId ||
      verified.manifest.treeDigest !== manifest.treeDigest) {
      throw new Error("contained turn published artifact verification failed");
    }
    return await recordSealAndResult({
      context, directories, manifestDigest, name, recordName, request,
      rootIdentity: manifest.tree.rootIdentity, treeDigest: manifest.treeDigest,
    });
  } finally {await closeContainedTurnArtifactHandles(directories.handles);}
};
