import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";

export const isMissingFilesystemEntry = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const fsyncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const assertPrivateDirectory = async (path: string): Promise<void> => {
  const [observation, canonical] = await Promise.all([lstat(path, { bigint: true }), realpath(path)]);
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : observation.uid;
  if (
    !observation.isDirectory() || observation.isSymbolicLink() || canonical !== path ||
    observation.uid !== currentUid || (observation.mode & 0o077n) !== 0n
  ) {
    throw new Error("contained turn filesystem custody directory is not private and stable");
  }
};

export const ensurePrivateDirectory = async (path: string): Promise<string> => {
  await mkdir(path, { mode: 0o700, recursive: true });
  const canonical = await realpath(path);
  await assertPrivateDirectory(canonical);
  return canonical;
};
