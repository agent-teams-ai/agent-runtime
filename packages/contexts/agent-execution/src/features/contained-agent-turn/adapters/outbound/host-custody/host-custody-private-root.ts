import {
  fstatSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  type BigIntStats,
} from "node:fs";
import { basename, relative, sep } from "node:path";

import { canonicalJson, sha256 } from "./host-custody-launch.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

const sameDirectoryIdentity = (
  actual: BigIntStats,
  expected: NonNullable<LiveCustody["privatePaths"]>["root"],
): boolean => actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino &&
  actual.mode === expected.mode && actual.uid === expected.uid;

const quarantinePath = (live: LiveCustody): string | undefined => {
  const expected = live.privatePaths?.root;
  return expected === undefined ? undefined : `${expected.path}.quarantine-${sha256(live.custodyRef)}`;
};

export const quarantinePrivateRootForReconciliation = (live: LiveCustody): boolean => {
  if (live.privateRootClosure.status === "deleted") {return false;}
  const authority = live.launchAuthority;
  const expected = live.privatePaths?.root;
  if (authority === undefined || expected === undefined) {return false;}
  const before = fstatSync(authority.privateRootDescriptor.parentDescriptor, { bigint: true });
  if (!sameDirectoryIdentity(before, expected)) {return false;}
  const retainedPath = quarantinePath(live);
  if (retainedPath === undefined) {return false;}
  try {
    let moved: BigIntStats | undefined;
    if (live.privateRootClosure.status === "quarantined" || live.privateRootClosure.status === "unproven") {
      try {moved = lstatSync(retainedPath, { bigint: true });} catch {}
    }
    if (moved === undefined) {
      const current = lstatSync(expected.path, { bigint: true });
      if (!sameDirectoryIdentity(current, expected)) {return false;}
      renameSync(expected.path, retainedPath);
      moved = lstatSync(retainedPath, { bigint: true });
    }
    if (!sameDirectoryIdentity(moved, expected)) {
      live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "unproven" });
      return false;
    }
    live.privateRootClosure = Object.freeze({
      identitySha256: sha256(canonicalJson([
        moved.dev.toString(), moved.ino.toString(), moved.mode.toString(), moved.uid.toString(),
      ])),
      status: "quarantined",
    });
    return true;
  } catch {
    if (live.privateRootClosure.status !== "quarantined") {
      live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "unproven" });
    }
    return false;
  }
};

export const quarantinePrivateRoot = (live: LiveCustody): boolean => {
  if (live.privateRootClosure.status === "deleted") {return true;}
  if (!quarantinePrivateRootForReconciliation(live)) {return false;}
  const authority = live.launchAuthority;
  const retainedPath = quarantinePath(live);
  if (authority === undefined || retainedPath === undefined) {return false;}
  try {
    const descriptorPath = live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group"
      ? retainedPath
      : `/proc/self/fd/${authority.privateRootDescriptor.parentDescriptor}`;
    for (const entry of readdirSync(descriptorPath)) {
      rmSync(`${descriptorPath}/${entry}`, { force: true, recursive: true });
    }
    if (readdirSync(descriptorPath).length !== 0) {return false;}
    rmdirSync(retainedPath);
    live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "deleted" });
    return true;
  } catch {return false;}
};

interface ExpectedPrivateNode {
  readonly children: Map<string, ExpectedPrivateNode>;
  expected?: NonNullable<LiveCustody["privatePaths"]>["root"];
}

const expectedPrivateTree = (live: LiveCustody): ExpectedPrivateNode | undefined => {
  const privatePaths = live.privatePaths;
  if (privatePaths === undefined) {return;}
  const root: ExpectedPrivateNode = { children: new Map() };
  for (const expected of Object.values(privatePaths.byEnvironmentKey)) {
    const parts = relative(privatePaths.root.path, expected.path).split(sep);
    if (parts.length === 0 || parts.some(part => part.length === 0 || part === "..")) {return;}
    let cursor = root;
    for (const part of parts) {
      const child = cursor.children.get(part) ?? { children: new Map() };
      cursor.children.set(part, child);
      cursor = child;
    }
    cursor.expected = expected;
  }
  return root;
};

const removeVerifiedEmptyTree = (path: string, node: ExpectedPrivateNode): boolean => {
  const entries = readdirSync(path).toSorted();
  if (entries.length !== node.children.size || entries.some(entry => !node.children.has(entry))) {return false;}
  for (const entry of entries) {
    const child = node.children.get(entry);
    if (child === undefined) {return false;}
    const childPath = `${path}/${entry}`;
    const observation = lstatSync(childPath, { bigint: true });
    if (child.expected !== undefined && !sameDirectoryIdentity(observation, child.expected) ||
        child.expected === undefined && !observation.isDirectory()) {
      return false;
    }
    if (!removeVerifiedEmptyTree(childPath, child)) {return false;}
    rmdirSync(childPath);
  }
  return true;
};

/** Deletes only a freshly revalidated, never-used private tree after complete no-start proof. */
export const deletePrivateRootAfterProvedNoStart = (live: LiveCustody): boolean => {
  if (live.privateRootClosure.status === "deleted") {return true;}
  const expected = live.privatePaths?.root;
  const tree = expectedPrivateTree(live);
  if (expected === undefined || tree === undefined || basename(expected.path).length === 0) {return false;}
  try {
    const actual = lstatSync(expected.path, { bigint: true });
    if (!sameDirectoryIdentity(actual, expected) || !removeVerifiedEmptyTree(expected.path, tree)) {return false;}
    rmdirSync(expected.path);
    live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "deleted" });
    return true;
  } catch {
    live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "unproven" });
    return false;
  }
};
