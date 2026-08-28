import {
  PathCustodyError,
  openStablePath,
  type OpenedStablePath,
} from "@agent-teams/filesystem-custody";
import { lstat, realpath } from "node:fs/promises";

import type {
  ExecutableFileObservation,
  ExecutableFileObserver,
} from "../../application/ports/outbound/executable-file-observation.js";

const classifyError = (error: unknown): ExecutableFileObservation => {
  if (error instanceof PathCustodyError) {
    return { kind: "unstable" };
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { kind: "missing" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { kind: "denied" };
  }
  if (code === "ELOOP") {
    return { kind: "invalid" };
  }
  return { kind: "unreadable" };
};

const authorizationFileIdentity = (stats: {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}): string => `${stats.dev}:${stats.ino}:${stats.ctimeNs}:${stats.size}`;

export const isSupportedExecutableAliasKind = (stats: {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}): boolean => stats.isFile() || stats.isSymbolicLink();

const observeAuthorizedExecutable = async (
  openedPath: OpenedStablePath,
  authorizedFileIdentity: string,
): Promise<ExecutableFileObservation> => {
  const opened = openedPath.stats;
  if (!opened.isFile() || (opened.mode & 0o111n) === 0n) {
    return { kind: "invalid" };
  }
  if (
    opened.nlink > 1n ||
    authorizationFileIdentity(opened) !== authorizedFileIdentity
  ) {
    return { kind: "unstable" };
  }
  return { identity: `${opened.dev}:${opened.ino}`, kind: "found" };
};

export const createNodeExecutableFileObserver = (): ExecutableFileObserver => ({
  async observe(
    absolutePath,
    expectedCanonicalPath,
    authorizedFileIdentity,
    custodyRoot,
    options,
  ) {
    options?.signal?.throwIfAborted();
    try {
      const alias = await lstat(absolutePath);
      if (!isSupportedExecutableAliasKind(alias)) {
        return { kind: "invalid" };
      }
      if ((await realpath(absolutePath)) !== expectedCanonicalPath) {
        return { kind: "unstable" };
      }
      if (!(await lstat(expectedCanonicalPath)).isFile()) {
        return { kind: "invalid" };
      }
      if (authorizedFileIdentity === undefined) {
        return { kind: "unstable" };
      }
      return await openStablePath(
        absolutePath,
        expectedCanonicalPath,
        async opened =>
          observeAuthorizedExecutable(opened, authorizedFileIdentity),
        {
          custodyBoundary: custodyRoot,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      options?.signal?.throwIfAborted();
      return classifyError(error);
    }
  },
});
