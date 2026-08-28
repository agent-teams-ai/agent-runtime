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

export interface EffectiveIdentity {
  readonly gid: number;
  readonly groups: readonly number[];
  readonly uid: number;
}

export interface NodeExecutableFileObserverDependencies {
  readonly effectiveIdentity?: EffectiveIdentity;
}

const currentEffectiveIdentity = (): EffectiveIdentity | undefined => {
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  return uid === undefined || gid === undefined
    ? undefined
    : { gid, groups: process.getgroups?.() ?? [], uid };
};

export const isExecutableByEffectiveIdentity = (
  stats: {
    readonly gid: bigint;
    readonly mode: bigint;
    readonly uid: bigint;
  },
  identity: EffectiveIdentity | undefined,
): boolean => {
  if (identity === undefined) {
    return (stats.mode & 0o111n) !== 0n;
  }
  if (identity.uid === 0) {
    return (stats.mode & 0o111n) !== 0n;
  }
  if (BigInt(identity.uid) === stats.uid) {
    return (stats.mode & 0o100n) !== 0n;
  }
  const groups = new Set([identity.gid, ...identity.groups]);
  if (groups.has(Number(stats.gid))) {
    return (stats.mode & 0o010n) !== 0n;
  }
  return (stats.mode & 0o001n) !== 0n;
};

export const isSupportedExecutableAliasKind = (stats: {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}): boolean => stats.isFile() || stats.isSymbolicLink();

const observeAuthorizedExecutable = async (
  openedPath: OpenedStablePath,
  authorizedFileIdentity: string,
  effectiveIdentity: EffectiveIdentity | undefined,
): Promise<ExecutableFileObservation> => {
  const opened = openedPath.stats;
  if (
    !opened.isFile() ||
    !isExecutableByEffectiveIdentity(opened, effectiveIdentity)
  ) {
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

export const createNodeExecutableFileObserver = (
  dependencies: NodeExecutableFileObserverDependencies = {},
): ExecutableFileObserver => {
  const effectiveIdentity =
    dependencies.effectiveIdentity ?? currentEffectiveIdentity();
  return {
    async observe(request) {
      request.signal?.throwIfAborted();
      try {
        const alias = await lstat(request.absolutePath);
        if (!isSupportedExecutableAliasKind(alias)) {
          return { kind: "invalid" };
        }
        if (
          (await realpath(request.absolutePath)) !==
          request.expectedCanonicalPath
        ) {
          return { kind: "unstable" };
        }
        if (!(await lstat(request.expectedCanonicalPath)).isFile()) {
          return { kind: "invalid" };
        }
        const authorizedFileIdentity = request.authorizedFileIdentity;
        if (authorizedFileIdentity === undefined) {
          return { kind: "unstable" };
        }
        return await openStablePath(
          request.absolutePath,
          request.expectedCanonicalPath,
          async opened =>
            observeAuthorizedExecutable(
              opened,
              authorizedFileIdentity,
              effectiveIdentity,
            ),
          {
            custodyBoundary: request.custodyBoundary,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
      } catch (error) {
        request.signal?.throwIfAborted();
        return classifyError(error);
      }
    },
  };
};
