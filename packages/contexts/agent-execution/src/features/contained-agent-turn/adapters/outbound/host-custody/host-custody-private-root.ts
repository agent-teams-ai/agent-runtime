import {
  closeSync,
  constants,
  openSync,
  realpathSync,
  fstatSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  type BigIntStats,
} from "node:fs";

import { canonicalJson, sha256 } from "./host-custody-launch.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

const sameDirectoryIdentity = (
  actual: BigIntStats,
  expected: NonNullable<LiveCustody["privatePaths"]>["root"],
): boolean => actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino &&
  actual.mode === expected.mode && actual.uid === expected.uid;

// Cleanup authority proves only the captured directory identity, never process start.
// A refused launch may have closed all launch descriptors before returning.
export const retainPrivateRootCleanupAuthority = (live: LiveCustody): number | undefined => {
  const launched = live.launchAuthority?.privateRootDescriptor.parentDescriptor;
  if (launched !== undefined) {return launched;}
  if (live.privateRootCleanupAuthority !== undefined) {return live.privateRootCleanupAuthority.descriptor;}
  const expected = live.privatePaths?.root;
  if (live.spawnStatus !== "never-started" || expected === undefined) {return;}
  let descriptor: number | undefined;
  try {
    if (realpathSync(expected.path) !== expected.path) {return;}
    descriptor = openSync(expected.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const observed = fstatSync(descriptor, { bigint: true });
    // Before retention, recycled inode numbers are not authority. Once pinned,
    // child changes may legitimately change ctime without changing identity.
    if (!sameDirectoryIdentity(observed, expected) || observed.ctimeNs !== expected.ctimeNs) {return;}
    const retained = descriptor;
    let closed = false;
    live.privateRootCleanupAuthority = Object.freeze({
      descriptor: retained,
      close() {
        if (closed) {return;}
        closeSync(retained);
        closed = true;
      },
    });
    descriptor = undefined;
    return retained;
  } catch {return undefined;}
  finally {if (descriptor !== undefined) {closeSync(descriptor);}}
};

const retainedRootDescriptor = (live: LiveCustody): number | undefined =>
  live.launchAuthority?.privateRootDescriptor.parentDescriptor ?? live.privateRootCleanupAuthority?.descriptor;

const quarantinePath = (live: LiveCustody): string | undefined => {
  const expected = live.privatePaths?.root;
  return expected === undefined ? undefined : `${expected.path}.quarantine-${sha256(live.custodyRef)}`;
};

export const quarantinePrivateRootForReconciliation = (live: LiveCustody): boolean => {
  if (live.privateRootClosure.status === "deleted") {return false;}
  if (live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group") {
    // Node exposes no descriptor-relative, no-replace rename authority on Darwin,
    // and a same-UID process could replace the retained pathname after a rename.
    // Keep both the captured descriptor and its directory entry intact for an
    // external reconciler instead of turning pathname observations into custody.
    live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "unproven" });
    return false;
  }
  const descriptor = retainedRootDescriptor(live);
  const expected = live.privatePaths?.root;
  if (descriptor === undefined || expected === undefined) {return false;}
  try {
    if (!sameDirectoryIdentity(fstatSync(descriptor, { bigint: true }), expected)) {return false;}
  } catch {return false;}
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
  const descriptor = retainedRootDescriptor(live);
  const retainedPath = quarantinePath(live);
  if (descriptor === undefined || retainedPath === undefined) {return false;}
  try {
    const descriptorPath = live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group"
      ? retainedPath
      : `/proc/self/fd/${descriptor}`;
    for (const entry of readdirSync(descriptorPath)) {
      rmSync(`${descriptorPath}/${entry}`, { force: true, recursive: true });
    }
    if (readdirSync(descriptorPath).length !== 0) {return false;}
    rmdirSync(retainedPath);
    live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "deleted" });
    return true;
  } catch {return false;}
};
