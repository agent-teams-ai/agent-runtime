import {lstat, open, realpath} from "node:fs/promises";
import {constants} from "node:fs";
import {withStableDirectoryProcessLock} from "@agent-teams/filesystem-custody/composition";
import type {HostOwnership} from "../../application/ports/outbound/interactive-host-ports.js";

/** Existing descriptor lock on the trusted canonical private root. No PID recovery or lease backend. */
export function createDirectoryHostOwnership(privateRoot: string): HostOwnership {
  return {acquire: async () => {
    const canonical = await realpath(privateRoot);
    if (canonical !== privateRoot || process.getuid === undefined) {throw new Error("interactive_host_private_root_invalid");}
    const before = await lstat(privateRoot, {bigint: true});
    if (!before.isDirectory() || Number(before.mode & 0o777n) !== 0o700 || before.uid !== BigInt(process.getuid())) {
      throw new Error("interactive_host_private_root_invalid");
    }
    const directory = await open(privateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const acquired = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const holding = (async () => {
      try {
        const opened = await directory.stat({bigint: true});
        const after = await lstat(privateRoot, {bigint: true});
        if ([opened, after].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.mode !== before.mode || stat.uid !== before.uid)) {
          throw new Error("interactive_host_private_root_changed");
        }
        await withStableDirectoryProcessLock(directory, async () => {
          acquired.resolve(); await finished.promise;
        }, {onContention: () => {throw new Error("interactive_host_already_owned");}});
      } finally {await directory.close();}
    })();
    void holding.catch(acquired.reject);
    await acquired.promise;
    let released: Promise<void> | undefined;
    return {release: () => released ??= (async () => {finished.resolve(); await holding;})()};
  }};
}
