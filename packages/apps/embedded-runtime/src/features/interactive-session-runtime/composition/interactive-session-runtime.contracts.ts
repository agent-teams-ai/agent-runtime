import {defineContract, type CapabilitiesOf, type Contract} from "@get-modular/assembly";
import type {HostOwnership} from "../application/ports/outbound/interactive-host-ports.js";
import type {InteractiveSessionDependencies} from "@agent-teams/agent-execution/composition";
import type {InteractiveSessionHost} from "../contracts/interactive-session-host.js";

export interface InteractiveHostContext {
  readonly scope: InteractiveSessionDependencies["scope"];
  readonly clock: InteractiveSessionDependencies["clock"];
  readonly limits: InteractiveSessionDependencies["limits"];
  readonly interactionTimeoutMs: number;
  readonly newOperationId: InteractiveSessionDependencies["newOperationId"];
  readonly withinDeadline: InteractiveSessionDependencies["withinDeadline"];
  readonly checkpoints?: InteractiveSessionDependencies["checkpoints"];
}
export interface InteractiveHostPorts {
  readonly context: InteractiveHostContext;
  readonly store: InteractiveSessionDependencies["store"];
  readonly provider: InteractiveSessionDependencies["drivers"];
  readonly authority: {readonly authorize: InteractiveSessionDependencies["authorize"]};
  readonly custody: InteractiveSessionDependencies["custody"];
}

export const Store = defineContract<InteractiveHostPorts["store"]>()({id: "agent-runtime/interactive-host/store", revision: 1});
export const Provider = defineContract<InteractiveHostPorts["provider"]>()({id: "agent-runtime/interactive-host/provider", revision: 1});
export const Authority = defineContract<InteractiveHostPorts["authority"]>()({id: "agent-runtime/interactive-host/authority", revision: 1});
export const Custody: Contract<"agent-runtime/interactive-host/custody", InteractiveHostPorts["custody"], 1> = defineContract<InteractiveHostPorts["custody"]>()({id: "agent-runtime/interactive-host/custody", revision: 1});
export const Context = defineContract<InteractiveHostPorts["context"]>()({id: "agent-runtime/interactive-host/context", revision: 1});
export const Ownership = defineContract<HostOwnership>()({id: "agent-runtime/interactive-host/ownership", revision: 1});
export const Host = defineContract<InteractiveSessionHost>()({id: "agent-runtime/interactive-host/host", revision: 1});
export interface InteractiveHostCapabilities extends CapabilitiesOf<typeof Store | typeof Provider | typeof Authority | typeof Custody | typeof Context | typeof Ownership | typeof Host> {}
