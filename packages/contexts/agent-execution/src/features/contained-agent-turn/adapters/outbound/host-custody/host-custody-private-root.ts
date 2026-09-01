import {
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

const quarantinePath = (live: LiveCustody): string | undefined => {
  const expected = live.privatePaths?.root;
  return expected === undefined ? undefined : `${expected.path}.quarantine-${sha256(live.custodyRef)}`;
};

export const quarantinePrivateRootForReconciliation = (live: LiveCustody): boolean => {
  if (live.privateRootClosure.status === "deleted" || live.privateRootClosure.status === "unproven") {return false;}
  const authority = live.launchAuthority;
  const expected = live.privatePaths?.root;
  if (authority === undefined || expected === undefined) {return false;}
  const before = fstatSync(authority.privateRootDescriptor.parentDescriptor, { bigint: true });
  if (!sameDirectoryIdentity(before, expected)) {return false;}
  const retainedPath = quarantinePath(live);
  if (retainedPath === undefined) {return false;}
  try {
    if (live.privateRootClosure.status !== "quarantined") {
      renameSync(expected.path, retainedPath);
    }
    const moved = lstatSync(retainedPath, { bigint: true });
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
