import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {claimResolvedWorkspaceAuthority, type ResolvedWorkspaceLaunchAuthority} from "./contained-turn-workspace-capability.js";
import {inspectFileHandle, readFilesystemMountIdentity, sameFilesystemIdentity} from "./contained-turn-filesystem-custody.js";

/** Private owner; the daemon must still receive its canonical source pathname,
 * never this process's descriptor path. Retention does not exclude Host writers. */
export const retainLaunchWorkspace = async (authority: ResolvedWorkspaceLaunchAuthority, operationId: string, workspaceRef: string) => {
  claimResolvedWorkspaceAuthority(authority, operationId, workspaceRef);
  const identity = Object.freeze({...authority.identity});
  const handle = await open(authority.descriptorPath, constants.O_RDONLY | constants.O_DIRECTORY);
  let closed = false;
  let closure: Promise<void> | undefined;
  const verify = async () => {
    if (closed) {throw new Error("Retained workspace closed");}
    const facts = await inspectFileHandle(handle);
    if (!facts.isDirectory || facts.nlink === 0n || !sameFilesystemIdentity(facts, identity) ||
      await readFilesystemMountIdentity(handle) !== identity.mountId) {throw new Error("Retained workspace identity changed");}
    if (closed) {throw new Error("Retained workspace closed");}
    return identity;
  };
  try {await verify();} catch (error) {await handle.close(); throw error;}
  let reads: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    revalidate() {
      const read = reads.then(verify);
      reads = read.catch(() => {});
      return read;
    },
    close() {
      closed = true;
      return closure ??= reads.then(() => handle.close());
    },
  });
};
export type RetainedLaunchWorkspace = Awaited<ReturnType<typeof retainLaunchWorkspace>>;
