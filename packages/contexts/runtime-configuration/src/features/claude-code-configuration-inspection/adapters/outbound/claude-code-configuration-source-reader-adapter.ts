import { openStablePath } from "@agent-teams/filesystem-custody";
import { realpath, type FileHandle } from "node:fs/promises";

import type {
  ClaudeCodeConfigurationSourceReader,
  ReadClaudeCodeConfigurationSourceResult,
} from "../../application/ports/outbound/claude-code-configuration-source-reader.js";

const classifyError = (error: unknown): ReadClaudeCodeConfigurationSourceResult => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { status: "missing" };
  }
  return { status: "unreadable" };
};

const authorizationFileIdentity = (stats: {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}): string => `${stats.dev}:${stats.ino}:${stats.ctimeNs}:${stats.size}`;

export const readClaudeCodeConfigurationSourceBytes = async (
  handle: FileHandle,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<ReadClaudeCodeConfigurationSourceResult> => {
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
    return { status: "too-large" };
  }
  return { bytes: buffer.subarray(0, offset), status: "read" };
};

const readStableAuthorizedFile = async (
  handle: FileHandle,
  authorizedFileIdentity: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<ReadClaudeCodeConfigurationSourceResult> => {
  const beforeRead = await handle.stat({ bigint: true });
  if (!beforeRead.isFile()) {
    return { status: "unreadable" };
  }
  if (authorizationFileIdentity(beforeRead) !== authorizedFileIdentity) {
    return { status: "unreadable" };
  }
  if (beforeRead.size > BigInt(maximumBytes)) {
    return { status: "too-large" };
  }
  const read = await readClaudeCodeConfigurationSourceBytes(
    handle,
    maximumBytes,
    signal,
  );
  if (read.status !== "read") {
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
    return { status: "unreadable" };
  }
  return read;
};

export const createClaudeCodeConfigurationSourceReaderAdapter =
  (): ClaudeCodeConfigurationSourceReader => ({
    async read(source, maximumBytes, options) {
      options?.signal?.throwIfAborted();
      try {
        if ((await realpath(source.absolutePath)) !== source.canonicalPath) {
          return { status: "unreadable" };
        }
        if (source.authorizedFileIdentity === undefined) {
          return { status: "unreadable" };
        }
        const authorizedFileIdentity = source.authorizedFileIdentity;
        return await openStablePath(
          source.absolutePath,
          source.canonicalPath,
          async opened =>
            readStableAuthorizedFile(
              opened.handle,
              authorizedFileIdentity,
              maximumBytes,
              options?.signal,
            ),
          {
            custodyBoundary: source.custodyRoot,
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
          },
        );
      } catch (error) {
        options?.signal?.throwIfAborted();
        return classifyError(error);
      }
    },
  });
