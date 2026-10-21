import {assemblyFor} from "@get-modular/assembly";
import {createScope} from "@get-modular/resources";
import {createDirectoryHostOwnership, type InteractiveHostPorts, type HostOwnership,
  type InteractiveSessionHost, type InteractiveHostCapabilities} from "../features/interactive-session-runtime/internal.js";
import {AgentRuntimeHostCreationError} from "./agent-runtime-host-creation-error.js";
import {composeInteractiveSessionHost} from "./interactive-session-host.root.js";

export interface InteractiveSessionHostOptions extends InteractiveHostPorts {
  /** Canonical trusted private directory for this Host scope; it must already exist with mode 0700. */
  readonly privateRoot: string;
}
export async function createInteractiveSessionHost(options: InteractiveSessionHostOptions): Promise<InteractiveSessionHost> {
  return constructInteractiveSessionHost(options, createDirectoryHostOwnership(options.privateRoot));
}
/** Package-private qualification seam; the public factory always selects real descriptor custody. */
export async function constructInteractiveSessionHost(ports: InteractiveHostPorts, ownership: HostOwnership): Promise<InteractiveSessionHost> {
  const captured: InteractiveHostPorts = {
    context: {...ports.context, scope: Object.freeze({...ports.context.scope}), limits: Object.freeze({...ports.context.limits}),
      clock: {now: ports.context.clock.now.bind(ports.context.clock)}},
    store: {create: ports.store.create.bind(ports.store), read: ports.store.read.bind(ports.store), compareAndSwap: ports.store.compareAndSwap.bind(ports.store)},
    provider: {open: ports.provider.open.bind(ports.provider)}, authority: {authorize: ports.authority.authorize.bind(ports.authority)},
    custody: {close: ports.custody.close.bind(ports.custody)},
  };
  const lifetime = createScope({name: "interactive-session-host"});
  const close = async (): Promise<void> => {
    const report = await lifetime.control.close();
    if (!report.complete) {throw new Error("interactive_host_cleanup_incomplete");}
  };
  const prepared = await composeInteractiveSessionHost(assemblyFor<InteractiveHostCapabilities>());
  if (prepared.status !== "prepared") {throw new Error("interactive_host_composition_invalid");}
  const outcome = await prepared.prepared.run({scope: lifetime.resources, inputs: {
    store: {"agent-runtime/interactive-host/store": captured.store},
    provider: {"agent-runtime/interactive-host/provider": captured.provider},
    authority: {"agent-runtime/interactive-host/authority": captured.authority},
    custody: {"agent-runtime/interactive-host/custody": captured.custody},
    context: {"agent-runtime/interactive-host/context": captured.context},
    ownership: {"agent-runtime/interactive-host/ownership": ownership},
  }});
  if (outcome.status !== "succeeded") {
    const failure = new AgentRuntimeHostCreationError("factory_failed", "run", {cause: outcome});
    try {await close();} catch (cleanupError) {throw failure.withCleanupFailure(cleanupError, close);}
    throw failure;
  }
  return Object.freeze({bindAccess: outcome.roots.host.bindAccess, control: outcome.roots.host.control, dispose: close});
}
