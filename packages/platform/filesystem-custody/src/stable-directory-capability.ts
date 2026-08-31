import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_FDINFO_BYTES = 16 * 1_024;

export interface StableDirectoryMutationCapability {
  readonly descriptorRoot: "/proc/self/fd";
  readonly kind: "supported";
  readonly platform: "linux";
  readonly version: 1;
}

export interface UnsupportedStableDirectoryMutationCapability {
  readonly kind: "unsupported";
  readonly platform: NodeJS.Platform;
  readonly reason: string;
  readonly version: 1;
}

export type StableDirectoryMutationCapabilityDisposition =
  | StableDirectoryMutationCapability
  | UnsupportedStableDirectoryMutationCapability;

export const resolveStableDirectoryMutationCapability = (input: Readonly<{
  hasDirectoryOpen: boolean;
  hasNoFollowOpen: boolean;
  platform: NodeJS.Platform;
}>): StableDirectoryMutationCapabilityDisposition => {
    if (
      input.platform === "linux" && input.hasDirectoryOpen && input.hasNoFollowOpen
    ) {
      return Object.freeze({
        descriptorRoot: "/proc/self/fd",
        kind: "supported",
        platform: "linux",
        version: 1,
      });
    }
    return Object.freeze({
      kind: "unsupported",
      platform: input.platform,
      reason: "identity-stable descriptor-relative directory mutation is unavailable through current Node APIs",
      version: 1,
    });
  };

export const stableDirectoryMutationCapability =
  (): StableDirectoryMutationCapabilityDisposition =>
    resolveStableDirectoryMutationCapability({
      hasDirectoryOpen: typeof constants.O_DIRECTORY === "number",
      hasNoFollowOpen: typeof constants.O_NOFOLLOW === "number",
      platform: process.platform,
    });

export const readStableDirectoryMountIdentity = async (fd: number): Promise<string> => {
  const capability = stableDirectoryMutationCapability();
  if (capability.kind === "unsupported") {
    throw new Error("stable directory mount identity is unsupported on this platform");
  }
  if (!Number.isSafeInteger(fd) || fd < 0) {
    throw new TypeError("stable directory descriptor is invalid");
  }
  let handle;
  try {
    handle = await open(`/proc/self/fdinfo/${fd}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.allocUnsafe(MAX_FDINFO_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FDINFO_BYTES) {
      throw new Error("stable directory mount identity exceeded its bounded record");
    }
    const matches = [...buffer.subarray(0, bytesRead).toString("utf8").matchAll(/^mnt_id:\s*(\d+)$/gmu)];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
      throw new Error("stable directory mount identity is unavailable");
    }
    return matches[0][1];
  } catch (error) {
    if (error instanceof TypeError || error instanceof Error && error.message.startsWith("stable directory")) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- cause can expose a proc descriptor path
    throw new Error("stable directory mount identity is unavailable");
  } finally {
    await handle?.close();
  }
};

export const assertSameStableDirectoryMountIdentity = (
  parentMountId: string,
  childMountId: string,
): void => {
  if (!/^\d+$/u.test(parentMountId) || !/^\d+$/u.test(childMountId)) {
    throw new TypeError("stable directory mount identity is invalid");
  }
  if (parentMountId !== childMountId) {
    throw new Error("stable directory traversal crossed a mount boundary");
  }
};
