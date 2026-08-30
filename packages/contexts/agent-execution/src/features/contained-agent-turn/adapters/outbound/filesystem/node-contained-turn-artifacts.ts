import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { openStablePath } from "@agent-teams/filesystem-custody";

import type { ContainedTurnArtifactPort } from "../legacy/legacy-contained-turn-ports.js";
import type { ContainedTurnKernelArtifactPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import {
  ensurePrivateDirectory,
  fsyncDirectory,
  isMissingFilesystemEntry,
} from "./contained-turn-filesystem-custody.js";
import {
  DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  scanContainedTurnWorkspace,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

export interface NodeContainedTurnArtifactOptions {
  readonly limits?: ContainedTurnWorkspaceTreeLimits;
  readonly root: string;
}

type ClosureInput = Parameters<ContainedTurnKernelArtifactPort["ensureSealed"]>[0];

const closureKey = (input: Pick<ClosureInput, "operationId" | "requestDigest">) =>
  createHash("sha256").update(`${input.operationId}\0${input.requestDigest}`).digest("hex");

const isAlreadyPresent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const verifyBlob = async (path: string, root: string, expected: Buffer): Promise<void> => {
  const actual = await openStablePath(
    path,
    path,
    opened => opened.handle.readFile(),
    { custodyBoundary: { absolutePath: root, canonicalPath: root } },
  );
  if (!actual.equals(expected)) {throw new Error("contained turn content-addressed artifact mismatch");}
};

const writeContentAddressed = async (
  root: string,
  category: "blobs" | "closures" | "manifests",
  digest: string,
  bytes: Buffer,
): Promise<string> => {
  const categoryRoot = join(root, category);
  const shardRoot = join(categoryRoot, digest.slice(0, 2));
  await ensurePrivateDirectory(shardRoot);
  const finalPath = join(shardRoot, digest);
  const temporaryPath = join(shardRoot, `.${digest}.${randomUUID()}.tmp`);
  const temporary = await open(temporaryPath, "wx", 0o600);
  try {
    await temporary.writeFile(bytes);
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    if (!isAlreadyPresent(error)) {throw error;}
    await verifyBlob(finalPath, root, bytes);
  } finally {
    await unlink(temporaryPath);
  }
  await fsyncDirectory(shardRoot);
  await verifyBlob(finalPath, root, bytes);
  return finalPath;
};

export const createNodeContainedTurnArtifacts = async (
  options: NodeContainedTurnArtifactOptions,
): Promise<ContainedTurnArtifactPort & Pick<ContainedTurnKernelArtifactPort, "ensureSealed" | "querySeal">> => {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root) {
    throw new TypeError("contained turn artifact root must be a normalized absolute path");
  }
  const limits = options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS;
  const artifactRoot = await ensurePrivateDirectory(options.root);
  await Promise.all([
    ensurePrivateDirectory(join(artifactRoot, "blobs")),
    ensurePrivateDirectory(join(artifactRoot, "closures")),
    ensurePrivateDirectory(join(artifactRoot, "manifests")),
  ]);

  const closurePath = (input: Pick<ClosureInput, "operationId" | "requestDigest">) => {
    const key = closureKey(input);
    return join(artifactRoot, "closures", key.slice(0, 2), key);
  };
  const readClosure = async (input: ClosureInput) => {
    try {
      const bytes = await openStablePath(
        closurePath(input), closurePath(input), opened => opened.handle.readFile(),
        { custodyBoundary: { absolutePath: artifactRoot, canonicalPath: artifactRoot } },
      );
      const record = JSON.parse(bytes.toString("utf8")) as { artifactManifestRef: string; resultRef: string };
      if (typeof record.artifactManifestRef !== "string" || typeof record.resultRef !== "string") {
        throw new TypeError("contained turn artifact closure record is malformed");
      }
      return Object.freeze({
        kind: "proved" as const,
        proof: Object.freeze({
          artifactProof: Object.freeze({
            binding: Object.freeze({
              artifactManifestRef: record.artifactManifestRef,
              authorityVectorDigest: input.authorityVectorDigest,
              operationId: input.operationId,
              workspaceId: input.workspaceId,
            }),
            kind: "artifact_manifest_seal" as const,
            proofId: containedTurnIdentity("proof", `proof:artifact-seal:${input.requestDigest}`),
          }),
          resultProof: Object.freeze({
            binding: Object.freeze({
              authorityVectorDigest: input.authorityVectorDigest,
              operationId: input.operationId,
              resultRef: record.resultRef,
            }),
            kind: "result_publication" as const,
            proofId: containedTurnIdentity("proof", `proof:result-publication:${input.requestDigest}`),
          }),
        }),
        requestDigest: input.requestDigest,
        requestId: input.requestId,
      });
    } catch (error) {
      if (!isMissingFilesystemEntry(error)) {throw error;}
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:artifact-seal-missing:${digestContainedTurnCanonicalValue({ operationId: input.operationId, requestDigest: input.requestDigest })}`),
        kind: "indeterminate" as const,
      });
    }
  };
  const adapter: ContainedTurnArtifactPort & Pick<ContainedTurnKernelArtifactPort, "ensureSealed" | "querySeal"> = {
    async ensureSealed(input) {
      const observed = await readClosure(input);
      if (observed.kind === "proved") {return observed;}
      const workspaceRef = input.workspaceId.startsWith("workspace:")
        ? input.workspaceId.slice("workspace:".length)
        : input.workspaceId;
      const sealed = await adapter.seal({ operationId: input.operationId, output: input.output, workspaceRef });
      const record = Buffer.from(JSON.stringify({
        artifactManifestRef: sealed.manifestRef,
        resultRef: sealed.resultRef,
      }), "utf8");
      await writeContentAddressed(artifactRoot, "closures", closureKey(input), record);
      return readClosure(input);
    },
    querySeal: readClosure,
    async seal(input) {
      const tree = await scanContainedTurnWorkspace(input.workspaceRef, limits);
      for (const file of tree.files) {
        await writeContentAddressed(artifactRoot, "blobs", file.digest, file.bytes);
      }
      const output = [];
      for (const chunk of input.output) {
        const bytes = Buffer.from(chunk.text, "utf8");
        const digest = createHash("sha256").update(bytes).digest("hex");
        await writeContentAddressed(artifactRoot, "blobs", digest, bytes);
        output.push(Object.freeze({ cursor: chunk.cursor, digest, kind: chunk.kind, size: bytes.length }));
      }
      const manifest = Object.freeze({
        files: Object.freeze(tree.files.map(file => Object.freeze({
          digest: file.digest,
          mode: file.mode,
          path: file.relativePath,
          size: file.size,
        }))),
        operationId: input.operationId,
        output: Object.freeze(output),
        schemaVersion: 1,
        treeDigest: tree.treeDigest,
      });
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
      await writeContentAddressed(artifactRoot, "manifests", manifestDigest, manifestBytes);
      return Object.freeze({
        manifestReceiptRef: `urn:agent-runtime:artifact-manifest-sealed:${manifestDigest}`,
        manifestRef: `urn:agent-runtime:artifact-manifest:${manifestDigest}`,
        resultReceiptRef: `urn:agent-runtime:result-published:${manifestDigest}`,
        resultRef: `urn:agent-runtime:contained-turn-result:${manifestDigest}`,
      });
    },
  };
  return Object.freeze(adapter);
};
