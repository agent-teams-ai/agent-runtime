import { openStablePath } from "@agent-teams/filesystem-custody";
import { realpath, type FileHandle } from "node:fs/promises";

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

const authorizationFileIdentity = (stats: {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}): string => `${stats.dev}:${stats.ino}:${stats.ctimeNs}:${stats.size}`;

const readBounded = async (
  handle: FileHandle,
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

const readStableAuthorizedFile = async (
  handle: FileHandle,
  authorizedFileIdentity: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<ConfigurationSourceRead> => {
  const beforeRead = await handle.stat({ bigint: true });
  if (!beforeRead.isFile()) {
    return { kind: "unreadable" };
  }
  if (authorizationFileIdentity(beforeRead) !== authorizedFileIdentity) {
    return { kind: "unreadable" };
  }
  if (beforeRead.size > BigInt(maximumBytes)) {
    return { kind: "too-large" };
  }
  const read = await readBounded(handle, maximumBytes, signal);
  if (read.kind !== "read") {
    return read;
  }
  signal?.throwIfAborted();
  const afterRead = await handle.stat({ bigint: true });
  if (
    beforeRead.dev !== afterRead.dev ||
    beforeRead.ino !== afterRead.ino ||
    beforeRead.size !== afterRead.size ||
    beforeRead.mtimeNs !== afterRead.mtimeNs ||
    beforeRead.ctimeNs !== afterRead.ctimeNs
  ) {
    return { kind: "unreadable" };
  }
  return read;
};

export const createNodeConfigurationSourceReader = (
  maximumBytes = 128 * 1024,
): ConfigurationSourceReader => ({
  async read(
    absolutePath,
    expectedCanonicalPath,
    authorizedFileIdentity,
    custodyRoot,
    options,
  ) {
    options?.signal?.throwIfAborted();
    try {
      if ((await realpath(absolutePath)) !== expectedCanonicalPath) {
        return { kind: "unreadable" };
      }
      if (authorizedFileIdentity === undefined) {
        return { kind: "unreadable" };
      }
      return await openStablePath(
        absolutePath,
        expectedCanonicalPath,
        async opened =>
          readStableAuthorizedFile(
            opened.handle,
            authorizedFileIdentity,
            maximumBytes,
            options?.signal,
          ),
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
