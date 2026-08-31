import { createHash } from "node:crypto";

import {
  decodeContainedTurnArtifactManifest,
  type ContainedTurnArtifactManifest,
} from "./contained-turn-artifact-manifest.js";
import {
  bindContainedTurnDirectoryEntry,
  assertSameFilesystemMount,
  openBoundDirectory,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import {
  readStableFileAt,
  writeImmutableFileAt,
  type ContainedTurnFilesystemFaults,
} from "./contained-turn-durable-file.js";
import type { ContainedTurnWorkspaceTreeLimits } from "./contained-turn-workspace-tree.js";
import { closeContainedTurnArtifactHandles } from "./contained-turn-artifact-custody.js";
import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";

const DIGEST = /^[a-f\d]{64}$/u;

export interface ContainedTurnArtifactStoreRoots {
  readonly blobs: BoundContainedTurnRoot;
  readonly manifests: BoundContainedTurnRoot;
  readonly staging: BoundContainedTurnRoot;
  readonly stagingQuarantine: BoundContainedTurnRoot;
}

export interface VerifiedStoredArtifact {
  readonly blobs: ReadonlyMap<string, Buffer>;
  readonly manifest: ContainedTurnArtifactManifest;
}

export interface ContainedTurnArtifactStore {
  readonly contentDigest: (domain: "blob" | "manifest", bytes: Uint8Array) => string;
  readonly verifyArtifact: (manifestDigest: string) => Promise<VerifiedStoredArtifact>;
  readonly writeContentAddressed: (
    domain: "blob" | "manifest",
    digest: string,
    bytes: Buffer,
  ) => Promise<void>;
}

const prefixFaults = (
  faults: ContainedTurnFilesystemFaults | undefined,
  prefix: string,
): ContainedTurnFilesystemFaults | undefined => faults === undefined ? undefined : Object.freeze({
  checkpoint: (point: string) => faults.checkpoint(`${prefix}.${point}`),
  ...(faults.openFile === undefined ? {} : { openFile: faults.openFile }),
  ...(faults.writeFile === undefined ? {} : { writeFile: faults.writeFile }),
});

export const createContainedTurnArtifactStore = (input: {
  readonly faults?: ContainedTurnFilesystemFaults | undefined;
  readonly limits: ContainedTurnWorkspaceTreeLimits;
  readonly roots: ContainedTurnArtifactStoreRoots;
  readonly testDigest?: ((domain: "blob" | "manifest", bytes: Uint8Array) => string) | undefined;
}): ContainedTurnArtifactStore => {
  const contentDigest = (domain: "blob" | "manifest", bytes: Uint8Array): string => {
    const value = input.testDigest === undefined
      ? createHash("sha256").update(bytes).digest("hex")
      : input.testDigest(domain, bytes);
    if (!DIGEST.test(value)) {
      throw new Error("contained turn artifact digest dependency returned an invalid digest");
    }
    return value;
  };

  const shardRoot = async (
    category: "blobs" | "manifests",
    digest: string,
    create: boolean,
  ): Promise<BoundContainedTurnRoot> => {
    const categoryRoot = category === "blobs" ? input.roots.blobs : input.roots.manifests;
    const shard = await bindContainedTurnDirectoryEntry(categoryRoot, digest.slice(0, 2), {
      create,
      private: true,
    });
    assertSameFilesystemMount(categoryRoot, shard);
    return shard;
  };

  const writeContentAddressed = async (
    domain: "blob" | "manifest",
    digest: string,
    bytes: Buffer,
  ): Promise<void> => {
    const finalRoot = await shardRoot(domain === "blob" ? "blobs" : "manifests", digest, true);
    const [finalDirectory, stagingDirectory] = await openBoundDirectories([
      finalRoot, input.roots.staging,
    ]);
    try {
      await writeImmutableFileAt({
        bytes,
        faults: prefixFaults(input.faults, `artifact.${domain}`),
        finalDirectory,
        finalName: digest,
        stagingDirectory,
        temporaryKind: "cas",
      });
    } finally {
      await closeContainedTurnArtifactHandles([finalDirectory, stagingDirectory]);
    }
  };

  const readContentAddressed = async (
    domain: "blob" | "manifest",
    digest: string,
    maxBytes: number,
  ): Promise<Buffer> => {
    const root = await shardRoot(domain === "blob" ? "blobs" : "manifests", digest, false);
    const handle = await openBoundDirectory(root);
    try {return await readStableFileAt(handle, digest, maxBytes);} finally {await handle.close();}
  };

  const verifyArtifact = async (manifestDigest: string): Promise<VerifiedStoredArtifact> => {
    const manifestBytes = await readContentAddressed(
      "manifest",
      manifestDigest,
      input.limits.maxTotalBytes,
    );
    if (contentDigest("manifest", manifestBytes) !== manifestDigest) {
      throw new Error("contained turn artifact manifest digest does not match its reference");
    }
    const manifest = decodeContainedTurnArtifactManifest(manifestBytes);
    if (manifest.entries.length > input.limits.maxEntries) {
      throw new Error("contained turn artifact manifest exceeded its entry limit");
    }
    let totalBytes = manifestBytes.length;
    const blobs = new Map<string, Buffer>();
    const projected = [...manifest.entries.filter(entry => entry.kind === "file"), ...manifest.output];
    for (const item of projected) {
      const depth = "path" in item ? item.path.split("/").length - 1 : 0;
      if (depth > input.limits.maxDepth || item.size > input.limits.maxFileBytes) {
        throw new Error("contained turn artifact manifest exceeded its path or file limit");
      }
      totalBytes += item.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > input.limits.maxTotalBytes) {
        throw new Error("contained turn artifact manifest exceeded its operation byte limit");
      }
      const existing = blobs.get(item.digest);
      if (existing !== undefined) {
        if (existing.length !== item.size) {
          throw new Error("contained turn artifact digest has conflicting sizes");
        }
        continue;
      }
      const bytes = await readContentAddressed("blob", item.digest, item.size);
      if (bytes.length !== item.size || contentDigest("blob", bytes) !== item.digest) {
        throw new Error("contained turn artifact blob does not match its manifest");
      }
      blobs.set(item.digest, bytes);
    }
    for (const entry of manifest.entries) {
      if (entry.kind === "directory" && entry.path.split("/").length > input.limits.maxDepth) {
        throw new Error("contained turn artifact directory exceeded its depth limit");
      }
    }
    return Object.freeze({ blobs, manifest });
  };

  return Object.freeze({ contentDigest, verifyArtifact, writeContentAddressed });
};
