import {
  createCooperativeProcessGroupAuthorityFactory,
  type PosixProcessGroupObserver,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-posix-process-group.js";
import { createDarwinProcessIdentityObserver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-process-tree.js";
import {
  NodeProviderProcessCustodyCore,
  type NodeProviderProcessCustodyOptions,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-core.js";

export interface DarwinCooperativeProcessCustodyTestOptions
  extends Omit<NodeProviderProcessCustodyOptions, "residueAuthorityFactory"> {
  readonly processGroupObserver?: PosixProcessGroupObserver;
}

/** Test-owned seam for synthetic Linux coverage of the Darwin cooperative profile; never shipped in the package. */
export const createDarwinCooperativeProcessCustodyTestSupport = (
  options: DarwinCooperativeProcessCustodyTestOptions,
): NodeProviderProcessCustodyCore => {
  const { processGroupObserver, ...custodyOptions } = options;
  const residueAuthorityFactory = createCooperativeProcessGroupAuthorityFactory(processGroupObserver);
  return new NodeProviderProcessCustodyCore({
    ...custodyOptions,
    processIdentityObserver: options.processIdentityObserver ?? createDarwinProcessIdentityObserver(),
    residueAuthorityFactory,
  }, Object.freeze({
    containmentProfile: "cooperative-darwin-posix-process-group",
    platform: "darwin",
    residueAuthorityFactory,
  }));
};
