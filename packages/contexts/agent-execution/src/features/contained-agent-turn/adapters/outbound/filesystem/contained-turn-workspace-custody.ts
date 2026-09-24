import { join } from "node:path";

import {
  assertSameFilesystemMount,
  bindContainedTurnRoot,
  ensurePrivateDirectory,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";

export interface ContainedTurnWorkspaceRoots {
  readonly active: BoundContainedTurnRoot;
  readonly cleanup: BoundContainedTurnRoot;
  readonly closed: BoundContainedTurnRoot;
  readonly closing: BoundContainedTurnRoot;
  readonly creations: BoundContainedTurnRoot;
  readonly frozen: BoundContainedTurnRoot;
  readonly materializing: BoundContainedTurnRoot;
  readonly quarantine: BoundContainedTurnRoot;
  readonly receipts: BoundContainedTurnRoot;
  readonly seals: BoundContainedTurnRoot;
  readonly staging: BoundContainedTurnRoot;
  readonly stagingQuarantine: BoundContainedTurnRoot;
}

export const bindContainedTurnWorkspaceRoots = async (
  custodyRoot: BoundContainedTurnRoot,
): Promise<ContainedTurnWorkspaceRoots> => {
  const paths = Object.freeze({
    active: join(custodyRoot.canonicalPath, "active"),
    cleanup: join(custodyRoot.canonicalPath, "cleanup"),
    closed: join(custodyRoot.canonicalPath, "closed"),
    closing: join(custodyRoot.canonicalPath, "closing"),
    creations: join(custodyRoot.canonicalPath, "creations"),
    frozen: join(custodyRoot.canonicalPath, "frozen"),
    materializing: join(custodyRoot.canonicalPath, "materializing"),
    quarantine: join(custodyRoot.canonicalPath, "quarantine"),
    receipts: join(custodyRoot.canonicalPath, "receipts"),
    seals: join(custodyRoot.canonicalPath, "seals"),
    staging: join(custodyRoot.canonicalPath, "staging"),
    stagingQuarantine: join(custodyRoot.canonicalPath, "staging-quarantine"),
  });
  for (const path of Object.values(paths)) {await ensurePrivateDirectory(path);}
  const entries: [string, BoundContainedTurnRoot][] = [];
  for (const [key, path] of Object.entries(paths)) {
    const root = await bindContainedTurnRoot(path, { private: true });
    assertSameFilesystemMount(custodyRoot, root);
    entries.push([key, root]);
  }
  const bound: Record<string, BoundContainedTurnRoot> = Object.fromEntries(entries);
  const root = (key: keyof ContainedTurnWorkspaceRoots): BoundContainedTurnRoot => {
    const value = bound[key];
    if (value === undefined) {throw new TypeError(`missing contained turn workspace root: ${key}`);}
    return value;
  };
  return Object.freeze({
    active: root("active"), cleanup: root("cleanup"), closed: root("closed"), closing: root("closing"),
    creations: root("creations"), frozen: root("frozen"), materializing: root("materializing"),
    quarantine: root("quarantine"), receipts: root("receipts"), seals: root("seals"),
    staging: root("staging"), stagingQuarantine: root("stagingQuarantine"),
  } satisfies ContainedTurnWorkspaceRoots);
};
