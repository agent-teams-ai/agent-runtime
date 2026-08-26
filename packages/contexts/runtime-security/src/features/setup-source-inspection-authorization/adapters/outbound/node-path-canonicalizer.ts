import { dirname, isAbsolute, join, parse } from "node:path";
import { realpath } from "node:fs/promises";

import type { PathCanonicalizer } from "../../application/ports/outbound/path-canonicalizer.js";

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";

export const createNodePathCanonicalizer = (): PathCanonicalizer => ({
  async canonicalize(absolutePath, options) {
    if (!isAbsolute(absolutePath)) {
      throw new TypeError("Only absolute paths can be canonicalized");
    }
    options?.signal?.throwIfAborted();
    try {
      return { absolutePath: await realpath(absolutePath), exists: true };
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
