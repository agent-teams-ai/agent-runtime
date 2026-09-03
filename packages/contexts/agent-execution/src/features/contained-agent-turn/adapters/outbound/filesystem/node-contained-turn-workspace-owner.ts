import type { ContainedTurnKernelWorkspacePort } from
  "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnOperationId,
  ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import {
  createWorkspaceCapabilityRetention,
  type ResolvedWorkspaceLaunchAuthority,
} from "./contained-turn-workspace-capability.js";
import {
  createNodeContainedTurnWorkspaceOwnerBackend,
  type NodeContainedTurnWorkspaceOptions,
} from "./node-contained-turn-workspace.js";

const OWNER_DISPOSAL_COMPLETION_BOUND_MS = 1_000;

export interface NodeContainedTurnWorkspaceOwner {
  readonly dispose: () => Promise<void>;
  readonly withLaunchAuthority: <Result>(
    input: Readonly<{
      attemptId: ContainedTurnAttemptId;
      operationId: ContainedTurnOperationId;
      workspaceId: ContainedTurnWorkspaceId;
    }>,
    consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>,
  ) => Promise<Result>;
  readonly workspace: ContainedTurnKernelWorkspacePort;
}

export const createNodeContainedTurnWorkspaceOwner = async (
  options: NodeContainedTurnWorkspaceOptions,
): Promise<NodeContainedTurnWorkspaceOwner> => {
  const retention = createWorkspaceCapabilityRetention();
  let backend: Awaited<ReturnType<typeof createNodeContainedTurnWorkspaceOwnerBackend>>;
  try {
    backend = await createNodeContainedTurnWorkspaceOwnerBackend(options, retention);
  } catch (error) {
    await retention.dispose();
    throw error;
  }

  let disposed = false;
  let disposal: Promise<void> | undefined;
  const ownedOperations = new Map<ContainedTurnOperationId, ContainedTurnWorkspaceId>();
  const ownedWorkspaces = new Map<ContainedTurnWorkspaceId, ContainedTurnOperationId>();
  const consumedAttempts = new Set<ContainedTurnAttemptId>();
  const consumedWorkspaces = new Set<ContainedTurnWorkspaceId>();
  const activeLaunches = new Set<Promise<unknown>>();
  const kernelWorkspace = backend.workspace as ContainedTurnKernelWorkspacePort;

  const assertOpen = (): void => {
    if (disposed) {throw new Error("contained turn workspace owner is disposed");}
  };

  const workspace: ContainedTurnKernelWorkspacePort = Object.freeze({
    close: (input: Parameters<ContainedTurnKernelWorkspacePort["close"]>[0]) => {
      assertOpen();
      return kernelWorkspace.close(input);
    },
    create: async (input: Parameters<ContainedTurnKernelWorkspacePort["create"]>[0]) => {
      assertOpen();
      const created = await kernelWorkspace.create(input);
      assertOpen();
      const workspaceId = created.workspaceId;
      const operationId = input.operationId;
      const existingWorkspace = ownedOperations.get(operationId);
      const existingOperation = ownedWorkspaces.get(workspaceId);
      if (
        (existingWorkspace !== undefined && existingWorkspace !== workspaceId) ||
        (existingOperation !== undefined && existingOperation !== operationId)
      ) {
        throw new Error("contained turn workspace owner creation identity conflicts with prior facts");
      }
      ownedOperations.set(operationId, workspaceId);
      ownedWorkspaces.set(workspaceId, operationId);
      return Object.freeze({ workspaceId });
    },
    ensureClosed: (input: Parameters<ContainedTurnKernelWorkspacePort["ensureClosed"]>[0]) => {
      assertOpen();
      return kernelWorkspace.ensureClosed(input);
    },
    quarantine: (input: Parameters<ContainedTurnKernelWorkspacePort["quarantine"]>[0]) => {
      assertOpen();
      return kernelWorkspace.quarantine(input);
    },
    queryClosure: (input: Parameters<ContainedTurnKernelWorkspacePort["queryClosure"]>[0]) => {
      assertOpen();
      return kernelWorkspace.queryClosure(input);
    },
  });

  const withLaunchAuthority = async <Result>(
    input: Readonly<{
      attemptId: ContainedTurnAttemptId;
      operationId: ContainedTurnOperationId;
      workspaceId: ContainedTurnWorkspaceId;
    }>,
    consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>,
  ): Promise<Result> => {
    assertOpen();
    if (
      ownedOperations.get(input.operationId) !== input.workspaceId ||
      ownedWorkspaces.get(input.workspaceId) !== input.operationId
    ) {
      throw new Error("contained turn workspace launch identity is not owned by this owner");
    }
    if (consumedAttempts.has(input.attemptId) || consumedWorkspaces.has(input.workspaceId)) {
      throw new Error("contained turn workspace launch authority is stale or already consumed");
    }
    consumedAttempts.add(input.attemptId);
    consumedWorkspaces.add(input.workspaceId);

    const launch = (async (): Promise<Result> => {
      const resolved = await backend.resolveLaunchAuthority(input);
      return retention.consume({
        authority: resolved.authority,
        operationId: resolved.operationId,
        scope: resolved.scope,
        workspaceRef: resolved.workspaceRef,
      }, consume);
    })();
    activeLaunches.add(launch);
    try {
      return await launch;
    } finally {
      activeLaunches.delete(launch);
    }
  };

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) {return disposal;}
    disposed = true;
    const launches = [...activeLaunches];
    disposal = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completed = launches.length === 0 || await Promise.race([
        Promise.allSettled(launches).then(() => true),
        new Promise<false>(resolve => {
          timeout = setTimeout(() => resolve(false), OWNER_DISPOSAL_COMPLETION_BOUND_MS);
        }),
      ]);
      if (timeout !== undefined) {clearTimeout(timeout);}
      await retention.dispose();
      if (!completed) {
        throw new Error(
          "contained turn workspace owner disposal incomplete: active launch authority did not settle",
        );
      }
    })();
    return disposal;
  };

  return Object.freeze({ dispose, withLaunchAuthority, workspace });
};
