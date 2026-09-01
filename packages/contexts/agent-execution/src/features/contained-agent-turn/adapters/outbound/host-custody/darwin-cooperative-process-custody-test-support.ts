import {
  createCooperativeProcessGroupAuthorityFactory,
  type PosixProcessGroupObserver,
} from "./host-custody-posix-process-group.js";
import { createDarwinProcessIdentityObserver } from "./host-custody-process-tree.js";
import {
  NodeProviderProcessCustodyCore,
  type NodeProviderProcessCustodyOptions,
} from "./node-provider-process-custody-core.js";

export interface DarwinCooperativeProcessCustodyTestOptions
  extends Omit<NodeProviderProcessCustodyOptions, "residueAuthorityFactory"> {
  readonly processGroupObserver?: PosixProcessGroupObserver;
}

/** Private relative-import seam for synthetic Linux tests; never exported by composition or the package. */
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
