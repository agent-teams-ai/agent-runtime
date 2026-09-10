import { darwinAttemptOwnerStates } from "../host-custody/darwin-attempt-owner-protocol.ts";
import type { bindDarwinAttemptOwnerBridge } from "../host-custody/darwin-attempt-owner-bridge.ts";
import { createWorkspaceClosureRecord } from "./contained-turn-workspace-state.ts";
import type {
  ContainedTurnWorkspaceCreationRecord, ContainedTurnWorkspaceSealRecord,
  ContainedTurnWorkspaceClosureRecord,
} from "./contained-turn-workspace-state.ts";

type Bridge = ReturnType<typeof bindDarwinAttemptOwnerBridge>;
/** Private backend beneath the existing workspace owner. That owner retains
 * its creation/seal/closure records and receipt authority. Root composition
 * binds these callbacks to that selected instance, never a caller record API. */
interface RetainedWorkspaceRecords {
  readonly creation: () => Promise<ContainedTurnWorkspaceCreationRecord>;
  readonly seal: () => Promise<ContainedTurnWorkspaceSealRecord>;
  readonly closure: () => Promise<ContainedTurnWorkspaceClosureRecord>;
  /** Separately captured, read-only native operation for this known successful
   * closed owner. It must revalidate the original journal and inode; no START,
   * allocation, active-root recovery, path argument or directory FD is exposed. */
  readonly readClosed: () => Promise<Readonly<{ binding: string; launch: string; dev: string; ino: string; record: Uint8Array }>>;
}
export function createDarwinAttemptWorkspaceBackend(bridge: Bridge, selected: RetainedWorkspaceRecords) {
  const records = Object.freeze({ creation: selected.creation, seal: selected.seal,
    closure: selected.closure, readClosed: selected.readClosed });
  const identity = async (): Promise<ContainedTurnWorkspaceCreationRecord> => {
    const creation = await records.creation();
    const native = bridge.binding();
    if (creation.schemaVersion !== 1 || creation.rootIdentity.dev !== native.workspaceDev ||
        creation.rootIdentity.ino !== native.workspaceIno) {throw new Error("native workspace is not the original creation inode");}
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
    async freeze() {
      await identity();
      const native = await bridge.freezeWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.frozen) {throw new Error("native workspace was not frozen");}
      // Only admission-fixed immutable regular-file bytes and metadata reach
      // the artifact owner; no arbitrary reader or copied workspace substitute.
      const first = await bridge.readArtifactSlot(0);
      const second = await bridge.readArtifactSlot(1);
      return Object.freeze([first, second]);
    },
    async cleanup(): Promise<void> {
      await seal();
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
    async readClosed(): Promise<ContainedTurnWorkspaceClosureRecord> {
      const known = bridge.retainedClosed();
      if (!known) {throw new Error("no successfully closed native owner to replay");}
      const closed = await closure();
      const readback = await records.readClosed();
      if (readback.binding !== known.binding || readback.launch !== known.launch ||
          readback.dev !== known.workspaceDev || readback.ino !== known.workspaceIno ||
          !Buffer.from(readback.record).equals(known.payload)) {throw new Error("closed native record/inode readback mismatch");}
      return closed;
    },
  });
}
