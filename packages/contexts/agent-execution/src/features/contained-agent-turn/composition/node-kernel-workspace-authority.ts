import {
  isNodeContainedTurnNativeWorkspaceOwner,
  withNodeContainedTurnNativeWorkspaceSelection,
  type NodeContainedTurnWorkspaceOwner,
} from "../adapters/outbound/filesystem/node-contained-turn-workspace-owner.js";
import {
  withNativeHostCustodyWorkspaceAuthority,
  retireNativeHostCustodyWorkspaceAuthority,
  type ContainedTurnKernelWorkspaceOwner,
  type NativeHostCustodyWorkspaceAuthority,
} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";

/** Fixed private wiring: the actual workspace owner authenticates the requested
 * operation/attempt/workspace before exposing its namespace-issued selection.
 * Host authenticates that selection's observation and issues its own grant. */
export const nodeKernelWorkspaceAuthority = (
  owner: NodeContainedTurnWorkspaceOwner,
): ContainedTurnKernelWorkspaceOwner => {
  if (!isNodeContainedTurnNativeWorkspaceOwner(owner)) {return owner;}
  return Object.freeze({
    async withLaunchAuthority<Result>(
      ids: Parameters<ContainedTurnKernelWorkspaceOwner["withLaunchAuthority"]>[0],
      consume: (authority: NativeHostCustodyWorkspaceAuthority) => Promise<Result>,
    ): Promise<Result> {
      const captured = Object.freeze({...ids});
      let called = false;
      let closed = false;
      let authority: NativeHostCustodyWorkspaceAuthority | undefined;
      let scoped: Promise<Result> | undefined;
      try {
        return await withNodeContainedTurnNativeWorkspaceSelection(owner, captured, selection => {
          if (called || closed) {throw new TypeError("Native workspace selection callback already consumed");}
          called = true;
          scoped = withNativeHostCustodyWorkspaceAuthority(selection, captured, value => {
            if (closed) {throw new TypeError("Native workspace selection callback has expired");}
            authority = value;
            return consume(value);
          });
          return scoped;
        });
      } catch (error) {
        closed = true;
        if (authority !== undefined) {retireNativeHostCustodyWorkspaceAuthority(authority);}
        // KernelOpenAttempts must fence acquisition before draining preparation.
        void scoped?.catch(() => {});
        throw error;
      } finally {closed = true;}
    },
  });
};
