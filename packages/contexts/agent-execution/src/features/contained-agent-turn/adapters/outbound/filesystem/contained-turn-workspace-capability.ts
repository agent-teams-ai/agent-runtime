import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import type { ContainedTurnWorkspaceLaunchAuthority } from "./contained-turn-filesystem-port.js";
import type { ContainedTurnScope } from "../../../contracts/contained-agent-turn.js";
import {
  assertSameMountIdentity,
  descriptorChildPath,
  inspectFileHandle,
  openDirectoryEntry,
  readFilesystemMountIdentity,
  sameFilesystemIdentity,
} from "./contained-turn-filesystem-custody.js";

export interface ResolvedWorkspaceLaunchAuthority {
  readonly canonicalPath: string;
  readonly descriptorPath: string;
  readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint; readonly mountId: string }>;
}

interface RetainedAuthority {
  readonly canonicalPath: string;
  readonly handle: FileHandle;
  readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly mountId: string;
  readonly name: string;
  readonly operationId: string;
  readonly parent: FileHandle;
  readonly scope: ContainedTurnScope;
  readonly workspaceRef: string;
}

export interface RetainWorkspaceCapabilityInput {
  readonly canonicalPath: string;
  readonly name: string;
  readonly operationId: string;
  readonly parent: FileHandle;
  readonly scope: ContainedTurnScope;
  readonly workspaceRef: string;
}

export interface ConsumeWorkspaceLaunchAuthorityInput {
  readonly authority: ContainedTurnWorkspaceLaunchAuthority;
  readonly operationId: string;
  readonly scope: ContainedTurnScope;
  readonly workspaceRef: string;
}

/** Filesystem-private descriptor owner used by one outer composition owner. */
export interface WorkspaceCapabilityRetention {
  consume<Result>(
    input: ConsumeWorkspaceLaunchAuthorityInput,
    consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>,
  ): Promise<Result>;
  dispose(): Promise<void>;
  retain(input: RetainWorkspaceCapabilityInput): Promise<ContainedTurnWorkspaceLaunchAuthority>;
}

const sameScope = (left: ContainedTurnScope, right: ContainedTurnScope): boolean =>
  left.projectId === right.projectId && left.tenantId === right.tenantId;

const closeRetainedAuthority = async (retained: RetainedAuthority): Promise<void> => {
  const failures: unknown[] = [];
  try {await retained.handle.close();} catch (error) {failures.push(error);}
  try {await retained.parent.close();} catch (error) {failures.push(error);}
  if (failures.length === 1) {throw failures[0];}
  if (failures.length > 1) {
    throw new AggregateError(failures, "workspace authority descriptor closure failed");
  }
};

export const createWorkspaceCapabilityRetention = (): WorkspaceCapabilityRetention => {
  const retainedAuthorities = new Map<string, RetainedAuthority>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const retain = async (
    input: RetainWorkspaceCapabilityInput,
  ): Promise<ContainedTurnWorkspaceLaunchAuthority> => {
    if (disposed) {throw new Error("contained turn workspace capability owner is disposed");}
    const parent = await open(
      descriptorChildPath(input.parent),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await assertSameMountIdentity(input.parent, parent);
      const expectedParent = await inspectFileHandle(input.parent);
      const retainedParent = await inspectFileHandle(parent);
      if (!sameFilesystemIdentity(expectedParent, retainedParent)) {
        throw new Error("contained turn workspace capability parent identity changed");
      }
    } catch (error) {
      await parent.close();
      throw error;
    }
    let handle: FileHandle;
    try {handle = await openDirectoryEntry(parent, input.name);} catch (error) {
      await parent.close();
      throw error;
    }
    let identity: Awaited<ReturnType<typeof inspectFileHandle>>;
    let mountId: string;
    try {
      identity = await inspectFileHandle(handle);
      mountId = await readFilesystemMountIdentity(handle);
    } catch (error) {
      await handle.close();
      await parent.close();
      throw error;
    }
    if (disposed) {
      await closeRetainedAuthority(Object.freeze({
        canonicalPath: input.canonicalPath,
        handle,
        identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
        mountId,
        name: input.name,
        operationId: input.operationId,
        parent,
        scope: Object.freeze({ ...input.scope }),
        workspaceRef: input.workspaceRef,
      }));
      throw new Error("contained turn workspace capability owner is disposed");
    }
    const authorityRef = `urn:agent-runtime:workspace-launch-authority:${randomUUID()}`;
    retainedAuthorities.set(authorityRef, Object.freeze({
      canonicalPath: input.canonicalPath,
      handle,
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      mountId,
      name: input.name,
      operationId: input.operationId,
      parent,
      scope: Object.freeze({ ...input.scope }),
      workspaceRef: input.workspaceRef,
    }));
    return Object.freeze({
      authorityRef,
      kind: "workspace_launch_authority" as const,
      version: 1 as const,
    });
  };

  const consume = async <Result>(
    input: ConsumeWorkspaceLaunchAuthorityInput,
    callback: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>,
  ): Promise<Result> => {
    if (disposed) {throw new Error("contained turn workspace capability owner is disposed");}
    const retained = retainedAuthorities.get(input.authority.authorityRef);
    if (retained === undefined) {
      throw new Error("contained turn workspace launch authority is stale or already consumed");
    }
    if (
      retained.operationId !== input.operationId || retained.workspaceRef !== input.workspaceRef ||
      !sameScope(retained.scope, input.scope)
    ) {
      throw new Error("contained turn workspace launch authority scope mismatch");
    }
    retainedAuthorities.delete(input.authority.authorityRef);
    let outcome: Readonly<{ error: unknown; ok: false }> | Readonly<{ ok: true; value: Result }>;
    try {
      const current = await openDirectoryEntry(retained.parent, retained.name);
      try {
        const observation = await inspectFileHandle(current);
        const currentMount = await readFilesystemMountIdentity(current);
        if (!sameFilesystemIdentity(retained.identity, observation) || currentMount !== retained.mountId) {
          throw new Error("contained turn workspace launch authority is stale");
        }
      } finally {await current.close();}
      outcome = Object.freeze({
        ok: true,
        value: await callback(Object.freeze({
          canonicalPath: retained.canonicalPath,
          descriptorPath: descriptorChildPath(retained.handle),
          identity: Object.freeze({ ...retained.identity, mountId: retained.mountId }),
        })),
      });
    } catch (error) {outcome = Object.freeze({ error, ok: false });}
    let closeFailure: unknown;
    try {await closeRetainedAuthority(retained);} catch (error) {closeFailure = error;}
    if (!outcome.ok) {
      if (closeFailure !== undefined) {
        throw new AggregateError(
          [outcome.error, closeFailure],
          "workspace authority consumption and closure failed",
        );
      }
      throw outcome.error;
    }
    if (closeFailure !== undefined) {throw closeFailure;}
    return outcome.value;
  };

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) {return disposal;}
    disposed = true;
    const authorities = [...retainedAuthorities.values()];
    retainedAuthorities.clear();
    disposal = (async () => {
      const outcomes = await Promise.allSettled(authorities.map(closeRetainedAuthority));
      const failures = outcomes.flatMap(outcome =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      if (failures.length === 1) {throw failures[0];}
      if (failures.length > 1) {
        throw new AggregateError(failures, "workspace capability owner disposal failed");
      }
    })();
    return disposal;
  };

  return Object.freeze({ consume, dispose, retain });
};

// Compatibility-only global for existing private verify/consume callers. New
// production owner composition supplies an instance-scoped retention owner.
const legacyWorkspaceCapabilityRetention = createWorkspaceCapabilityRetention();

export const retainWorkspaceCapability = (
  input: RetainWorkspaceCapabilityInput,
): Promise<ContainedTurnWorkspaceLaunchAuthority> =>
  legacyWorkspaceCapabilityRetention.retain(input);

/** Legacy composition-private consumption seam. The raw target exists only during this callback. */
export const consumeWorkspaceLaunchAuthority = <Result>(
  input: ConsumeWorkspaceLaunchAuthorityInput,
  consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>,
): Promise<Result> => legacyWorkspaceCapabilityRetention.consume(input, consume);
