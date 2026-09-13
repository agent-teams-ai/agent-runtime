import {mkdtemp, rename, rm, chmod} from "node:fs/promises";
import {join} from "node:path";
import type {OrdinaryArtifactsPort} from "../../../application/ordinary-ports.js";
import {ORDINARY_PROFILE, type OrdinaryReceiptOf} from "../../../domain/ordinary-model.js";
import {directory, digest, readStable, writeSynced, syncDirectory} from "./ordinary-files.js";

export interface NodeOrdinaryArtifactsOptions {readonly artifactRoot: string; readonly sourceRevision: string}
/** Reopens canonical bytes and verifies both content addresses, including the persisted operation binding. */
export async function readNodeOrdinaryArtifact(options: NodeOrdinaryArtifactsOptions, receipt: OrdinaryReceiptOf<"artifact_published">): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/.test(receipt.artifactDigest)) {throw new Error("ordinary_artifact_address");}
  await directory(options.artifactRoot, true);
  const root = join(options.artifactRoot, receipt.artifactDigest);
  await directory(root, true);
  if (receipt.artifactManifestRef !== join(root, "manifest.json") || receipt.resultRef !== join(root, "result.txt")) {throw new Error("ordinary_artifact_path_binding");}
  const manifestBytes = await readStable(receipt.artifactManifestRef);
  if (digest(manifestBytes) !== receipt.artifactDigest) {throw new Error("ordinary_manifest_corrupt");}
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!manifest || typeof manifest !== "object" || !("sourceDigest" in manifest) || typeof manifest.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceDigest) || !("inventoryDigest" in manifest) || typeof manifest.inventoryDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.inventoryDigest)) {throw new Error("ordinary_manifest_source_binding");}
  const bytes = await readStable(receipt.resultRef);
  const expected = manifestFor(options.sourceRevision, {...receipt, sourceDigest: manifest.sourceDigest, inventoryDigest: manifest.inventoryDigest}, digest(bytes), bytes.length);
  if (JSON.stringify(manifest) !== JSON.stringify(expected) || bytes.length !== receipt.byteLength || digest(bytes) !== receipt.snapshotDigest) {throw new Error("ordinary_artifact_corrupt_or_binding");}
  return Uint8Array.from(bytes);
}
function manifestFor(sourceRevision: string, receipt: Pick<OrdinaryReceiptOf<"artifact_published">, "operationId" | "attemptId" | "executionProfile" | "capabilityManifestRevision" | "workspaceId"> & {readonly sourceDigest: string; readonly inventoryDigest: string}, resultDigest: string, byteLength: number) {
  return {schemaVersion: 1, effectClass: ORDINARY_PROFILE.effectClass, operationId: receipt.operationId, attemptId: receipt.attemptId, executionProfile: receipt.executionProfile, capabilityManifestRevision: receipt.capabilityManifestRevision, workspaceId: receipt.workspaceId, sourceRevision, sourceDigest: receipt.sourceDigest, inventoryDigest: receipt.inventoryDigest, trust: "cooperative-same-user", result: {path: "result.txt", sha256: resultDigest, byteLength}};
}
export function createNodeOrdinaryArtifacts(options: NodeOrdinaryArtifactsOptions): OrdinaryArtifactsPort {
  return {async publish(operation, snapshot) {
    await directory(options.artifactRoot, true);
    if (!options.sourceRevision) {throw new Error("ordinary_source_revision_missing");}
    const {receipt} = snapshot;
    if (operation.effectClass !== ORDINARY_PROFILE.effectClass || receipt.operationId !== operation.operationId || receipt.attemptId !== operation.attemptId || receipt.executionProfile !== operation.executionProfile || receipt.capabilityManifestRevision !== operation.capabilityManifestRevision || !receipt.stable) {throw new Error("ordinary_snapshot_binding");}
    const bytes = Uint8Array.from(snapshot.resultBytes), hash = digest(bytes);
    if (hash !== receipt.snapshotDigest) {throw new Error("ordinary_snapshot_corrupt");}
    const manifest = JSON.stringify(manifestFor(options.sourceRevision, receipt, hash, bytes.length));
    const artifactDigest = digest(manifest), target = join(options.artifactRoot, artifactDigest);
    const staging = await mkdtemp(join(options.artifactRoot, ".staging-"));
    await writeSynced(join(staging, "result.txt"), bytes, 0o400);
    await writeSynced(join(staging, "manifest.json"), manifest, 0o400);
    await syncDirectory(staging);
    // Darwin requires a writable source directory for rename, even within one parent.
    try { await rename(staging, target); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY" || error.code === "EACCES"))) {throw error;}
      // Darwin can also report EACCES for an existing sealed destination.
      // Only reconcile a real private directory; readback below still verifies its bytes.
      try {await directory(target, true);} catch {throw error;}
      await rm(staging, {recursive: true});
    }
    await directory(target, true);
    await chmod(target, 0o500);
    await syncDirectory(target);
    await syncDirectory(options.artifactRoot);
    const published: OrdinaryReceiptOf<"artifact_published"> = {operationId: operation.operationId, attemptId: operation.attemptId, executionProfile: operation.executionProfile, capabilityManifestRevision: operation.capabilityManifestRevision, kind: "artifact_published", workspaceId: receipt.workspaceId, snapshotDigest: receipt.snapshotDigest, artifactDigest, artifactManifestRef: join(target, "manifest.json"), resultRef: join(target, "result.txt"), byteLength: bytes.length};
    await readNodeOrdinaryArtifact(options, published);
    return published;
  }};
}
