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

const retainedAuthorities = new Map<string, RetainedAuthority>();

const sameScope = (left: ContainedTurnScope, right: ContainedTurnScope): boolean =>
  left.projectId === right.projectId && left.tenantId === right.tenantId;

export const retainWorkspaceCapability = async (input: {
  readonly canonicalPath: string;
  readonly name: string;
  readonly operationId: string;
  readonly parent: FileHandle;
  readonly scope: ContainedTurnScope;
  readonly workspaceRef: string;
}): Promise<ContainedTurnWorkspaceLaunchAuthority> => {
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
  const authorityRef = `urn:agent-runtime:workspace-launch-authority:${randomUUID()}`;
  retainedAuthorities.set(authorityRef, Object.freeze({
    canonicalPath: input.canonicalPath, handle, identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
    mountId, name: input.name, operationId: input.operationId, parent,
    scope: Object.freeze({ ...input.scope }), workspaceRef: input.workspaceRef,
  }));
  return Object.freeze({ authorityRef, kind: "workspace_launch_authority" as const, version: 1 as const });
};

/** Composition-private consumption seam. The raw target exists only during this callback. */
export const consumeWorkspaceLaunchAuthority = async <Result>(input: {
  readonly authority: ContainedTurnWorkspaceLaunchAuthority;
  readonly operationId: string;
  readonly scope: ContainedTurnScope;
  readonly workspaceRef: string;
}, consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>): Promise<Result> => {
  const retained = retainedAuthorities.get(input.authority.authorityRef);
  if (retained === undefined) {throw new Error("contained turn workspace launch authority is stale or already consumed");}
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
    outcome = Object.freeze({ ok: true, value: await consume(Object.freeze({
      canonicalPath: retained.canonicalPath,
      descriptorPath: descriptorChildPath(retained.handle),
      identity: Object.freeze({ ...retained.identity, mountId: retained.mountId }),
    })) });
  } catch (error) {outcome = Object.freeze({ error, ok: false });}
  let closeFailure: unknown;
  try {await retained.handle.close();} catch (error) {closeFailure = error;}
  try {await retained.parent.close();} catch (error) {closeFailure ??= error;}
  if (!outcome.ok) {
    if (closeFailure !== undefined) {
      throw new AggregateError([outcome.error, closeFailure], "workspace authority consumption and closure failed");
    }
    throw outcome.error;
  }
  if (closeFailure !== undefined) {throw closeFailure;}
  return outcome.value;
};
