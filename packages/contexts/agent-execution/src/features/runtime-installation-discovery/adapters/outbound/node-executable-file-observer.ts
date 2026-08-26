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

export const createNodeExecutableFileObserver = (): ExecutableFileObserver => ({
  async observe(absolutePath, expectedCanonicalPath, options) {
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
      const beforeOpen = await stat(canonicalPath);
      if (!beforeOpen.isFile() || (beforeOpen.mode & 0o111) === 0) {
        return { kind: "invalid" };
      }

      options?.signal?.throwIfAborted();
      const handle = await open(
        canonicalPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== beforeOpen.dev ||
          opened.ino !== beforeOpen.ino ||
          opened.size !== beforeOpen.size ||
          opened.mtimeMs !== beforeOpen.mtimeMs
        ) {
          return { kind: "unstable" };
        }
        return {
          identity: `${opened.dev}:${opened.ino}`,
          kind: "found",
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      return classifyError(error);
    }
  },
});
