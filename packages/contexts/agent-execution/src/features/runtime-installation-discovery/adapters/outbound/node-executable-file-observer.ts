import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";

import type {
  ExecutableFileObservation,
  ExecutableFileObserver,
} from "../../application/ports/outbound/executable-file-observation.js";

const classifyError = (error: unknown): ExecutableFileObservation => {
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

const observeAuthorizedExecutable = async (
  canonicalPath: string,
  authorizedFileIdentity: string,
  signal?: AbortSignal,
): Promise<ExecutableFileObservation> => {
  const beforeOpen = await stat(canonicalPath);
  if (!beforeOpen.isFile() || (beforeOpen.mode & 0o111) === 0) {
    return { kind: "invalid" };
  }
  signal?.throwIfAborted();
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      opened.nlink > 1 ||
      `${opened.dev}:${opened.ino}` !== authorizedFileIdentity ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino ||
      opened.size !== beforeOpen.size ||
      opened.mtimeMs !== beforeOpen.mtimeMs
    ) {
      return { kind: "unstable" };
    }
    return { identity: `${opened.dev}:${opened.ino}`, kind: "found" };
  } finally {
    await handle.close();
  }
};

export const createNodeExecutableFileObserver = (): ExecutableFileObserver => ({
  async observe(absolutePath, expectedCanonicalPath, authorizedFileIdentity, options) {
    options?.signal?.throwIfAborted();
    try {
      const alias = await lstat(absolutePath);
      if (!alias.isFile() && !alias.isSymbolicLink()) {
        return { kind: "invalid" };
      }

      const canonicalPath = await realpath(absolutePath);
      if (canonicalPath !== expectedCanonicalPath) {
        return { kind: "unstable" };
      }
      if (authorizedFileIdentity === undefined) {
        return { kind: "unstable" };
      }
      return await observeAuthorizedExecutable(
        canonicalPath,
        authorizedFileIdentity,
        options?.signal,
      );
    } catch (error) {
      options?.signal?.throwIfAborted();
      return classifyError(error);
    }
  },
});
