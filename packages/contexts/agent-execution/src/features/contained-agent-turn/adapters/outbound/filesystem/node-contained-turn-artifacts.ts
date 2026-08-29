import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { openStablePath } from "@agent-teams/filesystem-custody";

import type { ContainedTurnArtifactPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import {
  ensurePrivateDirectory,
  fsyncDirectory,
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
  category: "blobs" | "manifests",
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
): Promise<ContainedTurnArtifactPort> => {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root) {
    throw new TypeError("contained turn artifact root must be a normalized absolute path");
  }
  const limits = options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS;
  const artifactRoot = await ensurePrivateDirectory(options.root);
  await Promise.all([
    ensurePrivateDirectory(join(artifactRoot, "blobs")),
    ensurePrivateDirectory(join(artifactRoot, "manifests")),
  ]);

  const adapter: ContainedTurnArtifactPort = {
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
