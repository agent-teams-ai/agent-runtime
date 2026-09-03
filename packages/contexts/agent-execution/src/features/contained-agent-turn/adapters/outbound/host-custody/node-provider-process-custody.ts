import { assertDescriptorBoundLinuxProfile } from "./host-custody-launch.js";
import { unsupportedOperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";
import {
  NodeProviderProcessCustodyCore,
  type NodeProviderProcessCustodyOptions,
} from "./node-provider-process-custody-core.js";

export type { NodeProviderProcessCustodyOptions } from "./node-provider-process-custody-core.js";

/** Strict descriptor-bound Linux/cgroup-v2 custody. Its evidence contract is unchanged. */
export class NodeProviderProcessCustody extends NodeProviderProcessCustodyCore {
  public constructor(options: NodeProviderProcessCustodyOptions) {
    assertDescriptorBoundLinuxProfile();
    super(options, Object.freeze({
      containmentProfile: "strict-linux-cgroup-v2",
      platform: process.platform,
      residueAuthorityFactory: unsupportedOperationResidueAuthorityFactory,
    }));
  }
}
