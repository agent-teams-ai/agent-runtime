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

const publicationMatchesLookup = (input: {
  readonly expectedRefs: ReturnType<typeof containedTurnResultRefs>;
  readonly expectedWorkspaceName: string;
  readonly lookup: ContainedTurnArtifactLookupBinding;
  readonly manifestDigest: string;
  readonly publication: ReturnType<typeof parseResultPublicationRecord>;
  readonly verified: VerifiedStoredArtifact;
}): boolean => input.publication.manifestDigest === input.manifestDigest &&
  input.publication.resultRef === input.lookup.resultRef &&
  input.publication.workspaceName === input.expectedWorkspaceName &&
  input.publication.operationId === input.lookup.operationId &&
  input.publication.scope.tenantId === input.lookup.scope.tenantId &&
  input.publication.scope.projectId === input.lookup.scope.projectId &&
  input.publication.treeDigest === input.verified.manifest.treeDigest &&
  input.publication.manifestReceiptRef === input.expectedRefs.manifestReceiptRef &&
  input.publication.resultReceiptRef === input.expectedRefs.resultReceiptRef;

const sealAndManifestMatchLookup = (input: {
  readonly lookup: ContainedTurnArtifactLookupBinding;
  readonly manifestDigest: string;
  readonly publication: ReturnType<typeof parseResultPublicationRecord>;
  readonly seal: ReturnType<typeof parseWorkspaceSealRecord>;
  readonly verified: VerifiedStoredArtifact;
}): boolean => input.seal.manifestDigest === input.manifestDigest &&
  input.seal.treeDigest === input.publication.treeDigest &&
  input.seal.operationId === input.lookup.operationId &&
  input.seal.workspaceName === input.publication.workspaceName &&
  input.seal.scope.tenantId === input.lookup.scope.tenantId &&
  input.seal.scope.projectId === input.lookup.scope.projectId &&
  input.verified.manifest.operationId === input.lookup.operationId &&
  input.verified.manifest.tenantId === input.lookup.scope.tenantId &&
  input.verified.manifest.projectId === input.lookup.scope.projectId;

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
  if (!publicationMatchesLookup({
    expectedRefs, expectedWorkspaceName, lookup: input.lookup,
    manifestDigest: input.manifestDigest, publication, verified,
  }) || !sealAndManifestMatchLookup({
    lookup: input.lookup, manifestDigest: input.manifestDigest, publication, seal, verified,
  })) {
    throw new Error("contained turn artifact lookup scope or operation mismatch");
  }
  return verified;
};
