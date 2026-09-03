import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

interface NativeProcessLockBinding {
  tryLockDirectory(directory: number): boolean;
  unlockDirectory(directory: number): void;
}

let nativeBinding: NativeProcessLockBinding | undefined;

const waitForRetry = (): Promise<void> => new Promise(resolve => {setTimeout(resolve, 10);});

const loadNativeBinding = (): NativeProcessLockBinding => {
  if (nativeBinding !== undefined) {return nativeBinding;}
  const loaded = { exports: {} } as NodeModule;
  try {
    process.dlopen(loaded, join(import.meta.dirname, "rename-no-replace.node"));
  } catch {
    throw new Error("the qualified stable directory process lock binding is unavailable");
  }
  const candidate = loaded.exports as Partial<NativeProcessLockBinding>;
  if (
    typeof candidate.tryLockDirectory !== "function" ||
    typeof candidate.unlockDirectory !== "function"
  ) {
    throw new Error("the qualified stable directory process lock binding is invalid");
  }
  nativeBinding = candidate as NativeProcessLockBinding;
  return nativeBinding;
};

export const withStableDirectoryProcessLock = async <Result>(
  directory: Pick<FileHandle, "fd">,
  operation: () => Promise<Result>,
  options: Readonly<{ onContention?: (() => Promise<void> | void) | undefined }> = {},
): Promise<Result> => {
  if (process.platform !== "linux") {
    throw new Error("stable directory process locks are qualified only on Linux");
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
