import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";

import type {
  ConfigurationSourceRead,
  ConfigurationSourceReader,
} from "../../application/ports/outbound/configuration-source-reader.js";

const classifyError = (error: unknown): ConfigurationSourceRead => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { kind: "missing" };
  }
  return { kind: "unreadable" };
};

const readBounded = async (
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<ConfigurationSourceRead> => {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    return { kind: "too-large" };
  }
  return { bytes: buffer.subarray(0, offset), kind: "read" };
};

export const createNodeConfigurationSourceReader = (
  maximumBytes = 128 * 1024,
): ConfigurationSourceReader => ({
  async read(absolutePath, expectedCanonicalPath, options) {
    options?.signal?.throwIfAborted();
    try {
      const canonicalPath = await realpath(absolutePath);
      if (canonicalPath !== expectedCanonicalPath) {
        return { kind: "unreadable" };
      }
      const handle = await open(
        canonicalPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const beforeRead = await handle.stat();
        if (!beforeRead.isFile()) {
          return { kind: "unreadable" };
        }
        if (beforeRead.size > maximumBytes) {
          return { kind: "too-large" };
        }
        const read = await readBounded(handle, maximumBytes, options?.signal);
        if (read.kind !== "read") {
          return read;
        }
        options?.signal?.throwIfAborted();
        const afterRead = await handle.stat();
        if (
          beforeRead.dev !== afterRead.dev ||
          beforeRead.ino !== afterRead.ino ||
          beforeRead.size !== afterRead.size ||
          beforeRead.mtimeMs !== afterRead.mtimeMs
        ) {
          return { kind: "unreadable" };
        }
        return read;
      } finally {
        await handle.close();
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      return classifyError(error);
    }
  },
});
