import { createCooperativeProcessGroupAuthorityFactory } from "./host-custody-posix-process-group.js";
import { createDarwinProcessIdentityObserver } from "./host-custody-process-tree.js";
import {
  NodeProviderProcessCustodyCore,
  type NodeProviderProcessCustodyOptions,
} from "./node-provider-process-custody-core.js";

export type DarwinCooperativeProcessCustodyOptions = Omit<
  NodeProviderProcessCustodyOptions, "processIdentityObserver" | "residueAuthorityFactory"
>;

/** Darwin-only cooperative custody. A descendant may escape by creating a new session. */
export class DarwinCooperativeProcessCustody extends NodeProviderProcessCustodyCore {
  public constructor(options: DarwinCooperativeProcessCustodyOptions) {
    const residueAuthorityFactory = createCooperativeProcessGroupAuthorityFactory();
    super({
      ...options,
      processIdentityObserver: createDarwinProcessIdentityObserver(),
      residueAuthorityFactory,
    }, Object.freeze({
      containmentProfile: "cooperative-darwin-posix-process-group",
      platform: process.platform,
      residueAuthorityFactory,
    }));
  }
}
