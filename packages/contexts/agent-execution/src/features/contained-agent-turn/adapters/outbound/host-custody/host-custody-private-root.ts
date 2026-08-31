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

export const quarantinePrivateRoot = (live: LiveCustody): boolean => {
  if (live.privateRootClosure.status === "deleted") {return true;}
  const authority = live.launchAuthority;
  const expected = live.privatePaths?.root;
  if (authority === undefined || expected === undefined) {return false;}
  const before = fstatSync(authority.privateRootDescriptor.parentDescriptor, { bigint: true });
  if (!sameDirectoryIdentity(before, expected)) {return false;}
  const quarantinePath = `${expected.path}.quarantine-${sha256(live.custodyRef)}`;
  try {
    if (live.privateRootClosure.status !== "quarantined") {
      renameSync(expected.path, quarantinePath);
    }
    const moved = lstatSync(quarantinePath, { bigint: true });
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
    const descriptorPath = `/proc/self/fd/${authority.privateRootDescriptor.parentDescriptor}`;
    for (const entry of readdirSync(descriptorPath)) {
      rmSync(`${descriptorPath}/${entry}`, { force: true, recursive: true });
    }
    if (readdirSync(descriptorPath).length !== 0) {return false;}
    rmdirSync(quarantinePath);
    live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "deleted" });
    return true;
  } catch {
    if (live.privateRootClosure.status !== "quarantined") {
      live.privateRootClosure = Object.freeze({ ...live.privateRootClosure, status: "unproven" });
    }
    return false;
  }
};
