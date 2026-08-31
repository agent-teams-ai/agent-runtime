import { createHash } from "node:crypto";

import type { ContainedTurnScope } from "../../../contracts/contained-agent-turn.js";
import type { BoundContainedTurnRoot } from "./contained-turn-filesystem-custody.js";
import {
  isMissingFilesystemEntry,
} from "./contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import { readStableFileAt } from "./contained-turn-durable-file.js";
import type { VerifiedStoredArtifact } from "./contained-turn-artifact-store.js";
import { closeContainedTurnArtifactHandles } from "./contained-turn-artifact-custody.js";
import { parseWorkspaceSealRecord } from "./contained-turn-workspace-state.js";
import { parseResultPublicationRecord } from "./contained-turn-result-publication.js";

const RECORD_BYTES = 64 * 1_024;

export interface ContainedTurnArtifactLookupBinding {
  readonly operationId: string;
  readonly resultRef: string;
  readonly scope: ContainedTurnScope;
}

export const containedTurnResultRefs = (manifestDigest: string) => Object.freeze({
  manifestReceiptRef: `urn:agent-runtime:artifact-manifest-sealed:${manifestDigest}`,
  manifestRef: `urn:agent-runtime:artifact-manifest:${manifestDigest}`,
  resultReceiptRef: `urn:agent-runtime:result-published:${manifestDigest}`,
  resultRef: `urn:agent-runtime:contained-turn-result:${manifestDigest}`,
});

export const scopedArtifactWorkspaceName = (
  operationId: string,
  scope: ContainedTurnScope,
): string => `operation-${createHash("sha256").update(JSON.stringify([
  scope.tenantId, scope.projectId, operationId,
])).digest("hex")}`;

export const verifyContainedTurnArtifactLookup = async (input: {
  readonly lookup: ContainedTurnArtifactLookupBinding;
  readonly manifestDigest: string;
  readonly resultPublications: BoundContainedTurnRoot;
  readonly verifyArtifact: (digest: string) => Promise<VerifiedStoredArtifact>;
  readonly workspaceSeals: BoundContainedTurnRoot;
}): Promise<VerifiedStoredArtifact> => {
  const publicationName = `${scopedArtifactWorkspaceName(
    input.lookup.operationId,
    input.lookup.scope,
  )}.json`;
  const [results, seals] = await openBoundDirectories([
    input.resultPublications, input.workspaceSeals,
  ]);
  let publication;
  let seal;
  try {
    try {
      publication = parseResultPublicationRecord(await readStableFileAt(
        results, publicationName, RECORD_BYTES,
      ));
      seal = parseWorkspaceSealRecord(await readStableFileAt(seals, publicationName, RECORD_BYTES));
    } catch (error) {
      if (isMissingFilesystemEntry(error)) {
        throw new Error(
          "contained turn artifact scope or operation mismatch, or publication or seal is missing",
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    await closeContainedTurnArtifactHandles([results, seals]);
  }
  const verified = await input.verifyArtifact(input.manifestDigest);
  const expectedRefs = containedTurnResultRefs(input.manifestDigest);
  const expectedWorkspaceName = scopedArtifactWorkspaceName(
    input.lookup.operationId,
    input.lookup.scope,
  );
  if (
    publication.manifestDigest !== input.manifestDigest ||
    publication.resultRef !== input.lookup.resultRef ||
    publication.workspaceName !== expectedWorkspaceName ||
    publication.operationId !== input.lookup.operationId ||
    publication.scope.tenantId !== input.lookup.scope.tenantId ||
    publication.scope.projectId !== input.lookup.scope.projectId ||
    publication.treeDigest !== verified.manifest.treeDigest ||
    publication.manifestReceiptRef !== expectedRefs.manifestReceiptRef ||
    publication.resultReceiptRef !== expectedRefs.resultReceiptRef ||
    seal.manifestDigest !== input.manifestDigest || seal.treeDigest !== publication.treeDigest ||
    seal.operationId !== input.lookup.operationId ||
    seal.workspaceName !== publication.workspaceName ||
    seal.scope.tenantId !== input.lookup.scope.tenantId ||
    seal.scope.projectId !== input.lookup.scope.projectId ||
    verified.manifest.operationId !== input.lookup.operationId ||
    verified.manifest.tenantId !== input.lookup.scope.tenantId ||
    verified.manifest.projectId !== input.lookup.scope.projectId
  ) {
    throw new Error("contained turn artifact lookup scope or operation mismatch");
  }
  return verified;
};
