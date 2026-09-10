import { createHash } from "node:crypto";
import type { ContainedTurnWorkspaceTree, ContainedTurnWorkspaceTreeLimits } from "./contained-turn-workspace-tree.js";
import { darwinAttemptOwnerStates, consumeDarwinNativeWorkspaceSelection } from "../host-custody/darwin-attempt-workspace-entrypoint.js";
import type { DarwinNativeWorkspaceSelection } from "../host-custody/darwin-attempt-workspace-entrypoint.js";
import { createWorkspaceClosureRecord } from "./contained-turn-workspace-state.js";
import type {
  ContainedTurnWorkspaceCreationRecord, ContainedTurnWorkspaceSealRecord,
  ContainedTurnWorkspaceClosureRecord,
} from "./contained-turn-workspace-state.ts";

type Bridge = ReturnType<typeof consumeDarwinNativeWorkspaceSelection>;
/** Private backend beneath the existing workspace owner. That owner retains
 * its creation/seal/closure records and receipt authority. Root composition
 * binds these callbacks to that selected instance, never a caller record API. */
export interface DarwinNativeRetainedWorkspaceOwners {
  readonly creation: () => Promise<ContainedTurnWorkspaceCreationRecord>;
  readonly seal: () => Promise<ContainedTurnWorkspaceSealRecord>;
  readonly closure: () => Promise<ContainedTurnWorkspaceClosureRecord>;
  readonly artifactResult: () => Promise<Readonly<Pick<ContainedTurnWorkspaceSealRecord,
    "operationId" | "scope" | "treeDigest" | "manifestDigest">>>;
}
function createDarwinAttemptWorkspaceBackend(bridge: Bridge, selected: DarwinNativeRetainedWorkspaceOwners) {
  const records = Object.freeze({ creation: selected.creation, seal: selected.seal,
    closure: selected.closure, artifactResult: selected.artifactResult });
  let materialized: ContainedTurnWorkspaceTree | undefined;
  let creationCommitted = false;
  const identity = async (): Promise<ContainedTurnWorkspaceCreationRecord> => {
    const creation = await records.creation();
    const native = bridge.binding();
    const manifest = bridge.capturedManifest();
    const operation = createHash("sha256").update(creation.operationId).digest();
    const scope = createHash("sha256").update(creation.scope.tenantId).update(Buffer.alloc(1)).update(creation.scope.projectId).digest();
    if (!operation.equals(manifest.subarray(48, 80)) || !scope.equals(manifest.subarray(80, 112))) {
      throw new Error("workspace creation does not match root operation/scope reservation");
    }
    if (creation.schemaVersion !== 1 || creation.rootIdentity.dev !== native.workspaceDev ||
        creation.rootIdentity.ino !== native.workspaceIno ||
        !materialized || creation.materializationDigest !== materialized.treeDigest) {throw new Error("native workspace is not the original creation inode");}
    return creation;
  };
  const seal = async (): Promise<ContainedTurnWorkspaceSealRecord> => {
    const creation = await identity();
    const sealed = await records.seal();
    if (sealed.schemaVersion !== 2 || sealed.operationId !== creation.operationId ||
        sealed.workspaceName !== creation.workspaceName || sealed.scope.projectId !== creation.scope.projectId ||
        sealed.scope.tenantId !== creation.scope.tenantId || sealed.rootIdentity.dev !== creation.rootIdentity.dev ||
        sealed.rootIdentity.ino !== creation.rootIdentity.ino) {throw new Error("workspace seal belongs to another retained root");}
    return sealed;
  };
  const closure = async (): Promise<ContainedTurnWorkspaceClosureRecord> => {
    const sealed = await seal();
    const closed = await records.closure();
    if (closed.schemaVersion !== 3 || closed.operationId !== sealed.operationId || closed.workspaceName !== sealed.workspaceName ||
        closed.scope.projectId !== sealed.scope.projectId || closed.scope.tenantId !== sealed.scope.tenantId ||
        closed.treeDigest !== sealed.treeDigest || closed.manifestDigest !== sealed.manifestDigest ||
        closed.receiptRef !== createWorkspaceClosureRecord(sealed.workspaceName, sealed).receiptRef) {
      throw new Error("workspace closure does not match the original seal");
    }
    return closed;
  };
  return Object.freeze({
    async materializeComplete(source: ContainedTurnWorkspaceTree, limits: ContainedTurnWorkspaceTreeLimits): Promise<ContainedTurnWorkspaceTree> {
      const result: ContainedTurnWorkspaceTree = await bridge.materializeComplete(source, limits);
      materialized = result; return result;
    },
    async commitCreation(): Promise<void> {
      if (creationCommitted) {throw new Error("native creation acknowledgement already consumed");}
      creationCommitted = true;
      const creation = await identity();
      await bridge.commitCreation(creation.materializationDigest, creation.operationId, creation.scope);
    },
    async freeze() {
      await identity();
      const native = await bridge.freezeWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.frozen) {throw new Error("native workspace was not frozen");}
      return bridge.readCompleteTree();
    },
    async cleanup(): Promise<void> {
      const sealed = await seal();
      const published = await records.artifactResult();
      if (published.operationId !== sealed.operationId || published.scope.projectId !== sealed.scope.projectId ||
          published.scope.tenantId !== sealed.scope.tenantId || published.treeDigest !== sealed.treeDigest ||
          published.manifestDigest !== sealed.manifestDigest) {throw new Error("native artifact/result publication mismatch");}
      await bridge.settleArtifactResult();
      const native = await bridge.cleanupWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.cleanup) {throw new Error("native workspace cleanup move is unknown");}
    },
    async close(): Promise<void> {
      await seal();
      const native = await bridge.closeWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.closed) {throw new Error("native workspace close move is unknown");}
      // The existing owner publishes its ordinary closure record after this
      // original-inode move, before invoking acknowledgeClosure below.
    },
    async acknowledgeClosure(): Promise<void> {
      await closure(); await bridge.settleWorkspace();
    },
    async quarantine(): Promise<void> {
      bridge.lost(); throw new Error("native quarantine disposition is indeterminate; retained custody requires reconciliation");
    },
    async queryClosed(): Promise<ContainedTurnWorkspaceClosureRecord> {
      const closed = await closure();
      const observed = await bridge.queryClosedWorkspace();
      if (observed.treeDigest !== closed.treeDigest) {throw new Error("queried native closed tree differs from retained seal");}
      return closed;
    },
    async readClosed(): Promise<ContainedTurnWorkspaceClosureRecord> {
      const known = bridge.retainedClosed();
      if (!known) {throw new Error("no successfully closed native owner to replay");}
      const closed = await closure();
      const observed = await bridge.readClosedWorkspace();
      const readback = observed.event;
      if (observed.tree.treeDigest !== closed.treeDigest) {throw new Error("closed native tree differs from retained seal");}
      if (readback.binding !== known.binding || readback.launch !== known.launch ||
          readback.workspaceDev !== known.workspaceDev || readback.workspaceIno !== known.workspaceIno ||
          !readback.payload.equals(known.payload)) {throw new Error("closed native record/inode readback mismatch");}
      return closed;
    },
  });
}

export {
  captureRootDarwinAttemptWorkspace, withDarwinNativeWorkspaceSelection, revokeDarwinNativeWorkspaceSelection, readDarwinNativeLaunchObservation,
  inspectDarwinNativeLaunchObservation, assertDarwinNativeLaunchObservationCurrent,
  installDarwinNativeCodexMaterial, inspectDarwinNativeCodexMaterial, assertDarwinNativeCodexMaterialCurrent,
} from "../host-custody/contained-turn-kernel-custody-entrypoint.js";
export type {
  DarwinNativeWorkspaceSelection, DarwinNativeExecutionLease, NativePreparedAttemptBinding, RetainedNativeAttemptAuthority,
  DarwinNativeLaunchObservation, NativeDirectoryFact, DarwinNativeCodexMaterial, NativeFileFact,
} from "../host-custody/contained-turn-kernel-custody-entrypoint.js";

/** Called only inside the actual workspace owner constructor. */
export function selectDarwinAttemptWorkspaceBackend(
  selection: DarwinNativeWorkspaceSelection,
  retainedOwners: DarwinNativeRetainedWorkspaceOwners,
): ReturnType<typeof createDarwinAttemptWorkspaceBackend> {
  return createDarwinAttemptWorkspaceBackend(consumeDarwinNativeWorkspaceSelection(selection), retainedOwners);
}
