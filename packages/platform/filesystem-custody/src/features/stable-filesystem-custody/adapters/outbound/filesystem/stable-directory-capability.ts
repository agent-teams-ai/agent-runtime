import type {
  StableCustodyPlatform,
  StableDirectoryMutationCapabilityDisposition,
} from "../../../contracts/stable-filesystem-custody.js";

// A drift between the contract union and the runtime's own platform union would
// otherwise surface as a silently widened or narrowed published declaration.
type Equals<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type CustodyPlatformUnionMatchesRuntime = Expect<Equals<NodeJS.Platform, StableCustodyPlatform>>;
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { hasDarwinHostDescriptors, nativeHostMount, type StableFilesystemHandle } from "./host-descriptor.js";

const MAX_FDINFO_BYTES = 16 * 1_024;

export const resolveStableDirectoryMutationCapability = (input: Readonly<{
  hasNativeHostDescriptors?: boolean;
  hasDirectoryOpen: boolean;
  hasNoFollowOpen: boolean;
  platform: StableCustodyPlatform;
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
    if (input.platform === "darwin" && input.hasNativeHostDescriptors === true) {
      return Object.freeze({ kind: "supported", platform: "darwin", version: 1 });
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
      hasNativeHostDescriptors: hasDarwinHostDescriptors(),
      hasDirectoryOpen: typeof constants.O_DIRECTORY === "number",
      hasNoFollowOpen: typeof constants.O_NOFOLLOW === "number",
      platform: process.platform,
    });

export const readStableDirectoryMountIdentity = async (descriptor: number | StableFilesystemHandle): Promise<string> => {
  const capability = stableDirectoryMutationCapability();
  if (capability.kind === "unsupported") {
    throw new Error("stable directory mount identity is unsupported on this platform");
  }
  if (capability.platform === "darwin") {
    if (typeof descriptor === "number") {throw new TypeError("Darwin mount observation requires an owned handle");}
    return nativeHostMount(descriptor);
  }
  const fd = typeof descriptor === "number" ? descriptor : descriptor.fd;
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
    throw new Error("stable directory mount identity is unavailable", { cause: error });
  } finally {
    await handle?.close();
  }
};

export const assertSameStableDirectoryMountIdentity = (
  parentMountId: string,
  childMountId: string,
): void => {
  if (!/^(?:\d+|darwin:[a-f0-9]{8}:[a-f0-9]{8}:(?:[a-f0-9]{2})+)$/u.test(parentMountId) ||
      !/^(?:\d+|darwin:[a-f0-9]{8}:[a-f0-9]{8}:(?:[a-f0-9]{2})+)$/u.test(childMountId)) {
    throw new TypeError("stable directory mount identity is invalid");
  }
  if (parentMountId !== childMountId) {
    throw new Error("stable directory traversal crossed a mount boundary");
  }
};
