import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type ProfileCaptureErrorCode =
  | "CAPTURE_LIMIT_EXCEEDED"
  | "DUPLICATE_INODE"
  | "HARD_LINK_UNSUPPORTED"
  | "SOURCE_CHANGED"
  | "SYMLINK_UNSUPPORTED"
  | "UNSUPPORTED_FILE_TYPE";

export class ProfileCaptureError extends Error {
  public readonly code: ProfileCaptureErrorCode;

  public constructor(code: ProfileCaptureErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProfileCaptureError";
  }
}

export interface ProfileCaptureLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxFiles: number;
}

export interface CapturedProfileArtifact {
  readonly path: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly mode: number;
}

export interface CapturedProfileSource {
  readonly artifacts: readonly CapturedProfileArtifact[];
  readonly totalBytes: number;
}

export interface ProfileCaptureProbeHooks {
  readonly afterFileRead?: (absolutePath: string) => Promise<void>;
}

const defaultLimits: ProfileCaptureLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxFiles: 2_000,
};

const sameRevision = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const inodeKey = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;

const canonicalRelativePath = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/");

export const captureProfileSource = async (
  root: string,
  limits: ProfileCaptureLimits = defaultLimits,
  hooks: ProfileCaptureProbeHooks = {},
): Promise<CapturedProfileSource> => {
  const rootStat = await lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink()) {
    throw new ProfileCaptureError(
      "SYMLINK_UNSUPPORTED",
      "Profile source root cannot be a symlink",
    );
  }
  if (!rootStat.isDirectory()) {
    throw new ProfileCaptureError(
      "UNSUPPORTED_FILE_TYPE",
      "Profile source root must be a directory",
    );
  }

  const artifacts: CapturedProfileArtifact[] = [];
  const seenInodes = new Set<string>();
  let totalBytes = 0;

  const captureFile = async (absolutePath: string): Promise<void> => {
    const initialPathStat = await lstat(absolutePath, { bigint: true });
    if (initialPathStat.isSymbolicLink()) {
      throw new ProfileCaptureError(
        "SYMLINK_UNSUPPORTED",
        `Symlink is not capturable: ${canonicalRelativePath(root, absolutePath)}`,
      );
    }
    if (!initialPathStat.isFile()) {
      throw new ProfileCaptureError(
        "UNSUPPORTED_FILE_TYPE",
        `Only regular files are capturable: ${canonicalRelativePath(root, absolutePath)}`,
      );
    }
    if (initialPathStat.nlink !== 1n) {
      throw new ProfileCaptureError(
        "HARD_LINK_UNSUPPORTED",
        `Hard-linked source is ambiguous: ${canonicalRelativePath(root, absolutePath)}`,
      );
    }

    const handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat({ bigint: true });
      const key = inodeKey(before);
      if (seenInodes.has(key)) {
        throw new ProfileCaptureError(
          "DUPLICATE_INODE",
          `Duplicate inode in source tree: ${canonicalRelativePath(root, absolutePath)}`,
        );
      }
      seenInodes.add(key);
      if (before.size > BigInt(limits.maxBytes - totalBytes)) {
        throw new ProfileCaptureError(
          "CAPTURE_LIMIT_EXCEEDED",
          "Profile source exceeds the byte limit",
        );
      }

      const content = await handle.readFile();
      await hooks.afterFileRead?.(absolutePath);
      const after = await handle.stat({ bigint: true });
      const currentPathStat = await lstat(absolutePath, { bigint: true });
      if (!sameRevision(before, after) || !sameRevision(after, currentPathStat)) {
        throw new ProfileCaptureError(
          "SOURCE_CHANGED",
          `Profile source changed while captured: ${canonicalRelativePath(root, absolutePath)}`,
        );
      }

      totalBytes += content.byteLength;
      artifacts.push({
        path: canonicalRelativePath(root, absolutePath),
        byteLength: content.byteLength,
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        mode: Number(after.mode & 0o777n),
      });
    } finally {
      await handle.close();
    }
  };

  const walk = async (absolutePath: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new ProfileCaptureError(
        "CAPTURE_LIMIT_EXCEEDED",
        "Profile source exceeds the depth limit",
      );
    }
    const before = await lstat(absolutePath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new ProfileCaptureError(
        before.isSymbolicLink()
          ? "SYMLINK_UNSUPPORTED"
          : "UNSUPPORTED_FILE_TYPE",
        `Expected stable directory: ${canonicalRelativePath(root, absolutePath)}`,
      );
    }
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = join(absolutePath, child.name);
      if (child.isDirectory()) {
        await walk(childPath, depth + 1);
      } else {
        if (artifacts.length >= limits.maxFiles) {
          throw new ProfileCaptureError(
            "CAPTURE_LIMIT_EXCEEDED",
            "Profile source exceeds the file limit",
          );
        }
        await captureFile(childPath);
      }
    }
    const after = await lstat(absolutePath, { bigint: true });
    if (!sameRevision(before, after)) {
      throw new ProfileCaptureError(
        "SOURCE_CHANGED",
        `Profile directory changed while captured: ${canonicalRelativePath(root, absolutePath)}`,
      );
    }
  };

  await walk(root, 0);
  return { artifacts, totalBytes };
};
