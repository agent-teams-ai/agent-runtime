import { constants } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { open, realpath } from "node:fs/promises";

import type { PathCanonicalizer } from "../../application/ports/outbound/path-canonicalizer.js";

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";

const authorizationFileIdentity = (stats: {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}): string => `${stats.dev}:${stats.ino}:${stats.ctimeNs}:${stats.size}`;

export const createNodePathCanonicalizer = (): PathCanonicalizer => ({
  async canonicalize(absolutePath, options) {
    if (!isAbsolute(absolutePath)) {
      throw new TypeError("Only absolute paths can be canonicalized");
    }
    options?.signal?.throwIfAborted();
    try {
      const canonicalPath = await realpath(absolutePath);
      const handle = await open(
        canonicalPath,
        constants.O_RDONLY |
          constants.O_NONBLOCK |
          (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = await handle.stat({ bigint: true });
        options?.signal?.throwIfAborted();
        if ((await realpath(absolutePath)) !== canonicalPath) {
          throw new Error("Path changed while it was being authorized");
        }
        return {
          absolutePath: canonicalPath,
          exists: true,
          fileIdentity: authorizationFileIdentity(opened),
          isFile: opened.isFile(),
          linkCount: Number(opened.nlink),
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
        throw error;
      }
    }

    const missingSegments: string[] = [];
    let cursor = absolutePath;
    const filesystemRoot = parse(absolutePath).root;
    while (cursor !== filesystemRoot) {
      missingSegments.unshift(cursor.slice(dirname(cursor).length + 1));
      cursor = dirname(cursor);
      options?.signal?.throwIfAborted();
      try {
        const ancestor = await realpath(cursor);
        return {
          absolutePath: join(ancestor, ...missingSegments),
          exists: false,
        };
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
          throw error;
        }
      }
    }
    throw new Error("No existing ancestor could be canonicalized");
  },
});
