import type { FileHandle } from "node:fs/promises";
import { loadStableFilesystemNativeExports } from "../native/stable-filesystem-native-artifact.js";

interface NativeProcessLockBinding {
  tryLockDirectory(directory: number): boolean;
  unlockDirectory(directory: number): void;
}

let nativeBinding: NativeProcessLockBinding | undefined;

const waitForRetry = (): Promise<void> => new Promise(resolve => {setTimeout(resolve, 10);});

const isNativeProcessLockBinding = (candidate: unknown): candidate is NativeProcessLockBinding =>
  typeof candidate === "object" && candidate !== null &&
  "tryLockDirectory" in candidate && typeof candidate.tryLockDirectory === "function" &&
  "unlockDirectory" in candidate && typeof candidate.unlockDirectory === "function";

const loadNativeBinding = (): NativeProcessLockBinding => {
  if (nativeBinding !== undefined) {return nativeBinding;}
  let candidate: unknown;
  try {
    candidate = loadStableFilesystemNativeExports();
  } catch {
    throw new Error("the qualified stable directory process lock binding is unavailable");
  }
  if (!isNativeProcessLockBinding(candidate)) {
    throw new Error("the qualified stable directory process lock binding is invalid");
  }
  nativeBinding = candidate;
  return nativeBinding;
};

/** Process serialization on a retained directory descriptor only. This does not
 * qualify descriptor-relative mutation, publication, or provider containment.
 * Each concurrent call must own a separately opened descriptor (a distinct open
 * file description): sharing a FileHandle or duplicating its descriptor does not
 * serialize flock acquisition. Retain the handle until this call settles; neither
 * callback may close it. Closing it before finally unlocks can throw EBADF and
 * mask the operation result or error. */
export const withStableDirectoryProcessLock = async <Result>(
  directory: Pick<FileHandle, "fd">,
  operation: () => Promise<Result>,
  options: Readonly<{ onContention?: (() => Promise<void> | void) | undefined }> = {},
): Promise<Result> => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("stable directory process locks are supported only on Linux and Darwin");
  }
  const binding = loadNativeBinding();
  let contentionReported = false;
  while (!binding.tryLockDirectory(directory.fd)) {
    if (!contentionReported) {
      contentionReported = true;
      await options.onContention?.();
    }
    await waitForRetry();
  }
  try {
    return await operation();
  } finally {
    binding.unlockDirectory(directory.fd);
  }
};
