import type { HostCustodyProcessIdentityObserver } from "./custodied-provider-process.js";
import {
  createCooperativeProcessGroupAuthorityFactory,
  type PosixProcessGroupObserver,
} from "./host-custody-posix-process-group.js";
import { createDarwinProcessIdentityObserver } from "./host-custody-process-tree.js";
import {
  NodeProviderProcessCustodyCore,
  type NodeProviderProcessCustodyOptions,
} from "./node-provider-process-custody-core.js";

export interface DarwinCooperativeProcessCustodyOptions
  extends Omit<NodeProviderProcessCustodyOptions, "processIdentityObserver" | "residueAuthorityFactory"> {
  /** Injectable adapter seam for synthetic refusal tests; defaults to the actual host. */
  readonly platform?: string;
  readonly processGroupObserver?: PosixProcessGroupObserver;
  readonly processIdentityObserver?: HostCustodyProcessIdentityObserver;
}

/** Darwin-only cooperative custody. A descendant may escape by creating a new session. */
export class DarwinCooperativeProcessCustody extends NodeProviderProcessCustodyCore {
  public constructor(options: DarwinCooperativeProcessCustodyOptions) {
    const residueAuthorityFactory = createCooperativeProcessGroupAuthorityFactory(options.processGroupObserver);
    super({
      ...options,
      processIdentityObserver: options.processIdentityObserver ?? createDarwinProcessIdentityObserver(),
      residueAuthorityFactory,
    }, Object.freeze({
      containmentProfile: "cooperative-darwin-posix-process-group",
      platform: options.platform ?? process.platform,
      residueAuthorityFactory,
    }));
  }
}
