import {lstat, realpath} from "node:fs/promises";
import type {BigIntStats} from "node:fs";
import {dirname, isAbsolute, parse, resolve as resolvePath} from "node:path";
import {createHash} from "node:crypto";
import {openStablePath} from "@agent-teams/filesystem-custody/composition";
import type {HostCustodyLaunchPlan} from "./custodied-provider-process.js";
import type {ExecutableObservation} from "./host-custody-launch.js";
const observationFromStats = (digest: string, stats: BigIntStats): ExecutableObservation => ({
  ctimeNs: stats.ctimeNs,
  dev: stats.dev,
  digest,
  ino: stats.ino,
  mode: stats.mode,
  mtimeNs: stats.mtimeNs,
  nlink: stats.nlink,
  size: stats.size,
});

const assertExecutableMode = (observation: BigIntStats): void => {
  if (
    !observation.isFile() ||
    observation.nlink !== 1n ||
    (observation.mode & 0o111n) === 0n ||
    (observation.mode & 0o022n) !== 0n
  ) {
    throw new Error("Host Custody executable must be a single-link, non-group/world-writable regular executable");
  }
};

export const assertCanonicalAncestors = async (path: string): Promise<void> => {
  if (!isAbsolute(path) || resolvePath(path) !== path) {
    throw new Error("Host Custody path must be a normalized absolute path");
  }
  const root = parse(path).root;
  const ancestors: string[] = [];
  for (let cursor = dirname(path);; cursor = dirname(cursor)) {
    ancestors.push(cursor);
    if (cursor === root) {break;}
  }
  for (const ancestor of ancestors.toReversed()) {
    const [canonical, observation] = await Promise.all([realpath(ancestor), lstat(ancestor, { bigint: true })]);
    if (canonical !== ancestor || !observation.isDirectory() || observation.isSymbolicLink()) {
      throw new Error("Host Custody path has a non-canonical or symbolic-link ancestor");
    }
  }
};

export const verifyExecutable = async (plan: HostCustodyLaunchPlan): Promise<ExecutableObservation> => {
  if (!isAbsolute(plan.executablePath) || resolvePath(plan.executablePath) !== plan.executablePath) {
    throw new Error("Host Custody executable must be a normalized absolute path");
  }
  const canonicalPath = await realpath(plan.executablePath);
  if (canonicalPath !== plan.executablePath) {
    throw new Error("Host Custody executable path must be canonical");
  }
  await assertCanonicalAncestors(canonicalPath);
  const pathStats = await lstat(canonicalPath, { bigint: true });
  assertExecutableMode(pathStats);
  return openStablePath(
    canonicalPath,
    canonicalPath,
    async opened => {
      assertExecutableMode(opened.stats);
      const digest = createHash("sha256").update(await opened.handle.readFile()).digest("hex");
      if (digest !== plan.executableSha256) {
        throw new Error("Host Custody executable digest mismatch");
      }
      return observationFromStats(digest, opened.stats);
    },
  );
};

