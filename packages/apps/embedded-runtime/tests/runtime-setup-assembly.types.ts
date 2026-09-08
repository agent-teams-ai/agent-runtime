import { assemblyFor } from "@get-modular/assembly";
import { defineModule } from "@get-modular/core";
import { createDefaultAgentRuntimeHost, type AgentRuntimeHost } from "../dist/composition.js";
// @ts-expect-error Internal attempt injection is not part of the package composition entrypoint.
import { createRuntimeSetupAttempt } from "../dist/composition.js";
void createRuntimeSetupAttempt;
import { bindRuntimeSetup, createRuntimeSetupFactories, runtimeSetupDeclarations,
  type RuntimeSetupCapabilities } from "../dist/composition/runtime-setup-assembly.js";

// Compiled by the registered runtime test; never executed as a bootstrap.
export async function consumerContract(): Promise<AgentRuntimeHost> {
  // @ts-expect-error The public default factory accepts no selection or factory injection.
  void createDefaultAgentRuntimeHost({ factories: createRuntimeSetupFactories(process.platform) });
  const pending: Promise<AgentRuntimeHost> = createDefaultAgentRuntimeHost();
  // @ts-expect-error The private composition entry must be awaited.
  const synchronous: AgentRuntimeHost = pending;
  void synchronous;
  const awaited: AgentRuntimeHost = await pending;
  const bindings = bindRuntimeSetup(createRuntimeSetupFactories(process.platform), (host) => {
    const captured: AgentRuntimeHost = host;
    void captured;
  });
  void bindings;
  return awaited;
}

const assembly = assemblyFor<RuntimeSetupCapabilities>();
const security = runtimeSetupDeclarations[0];
const incompatibleToken = defineModule({ ...security, provides: [{
  ...security.provides[0],
  compatibility: { family: "exact", familyVersion: 1, token: "agent-runtime/incompatible-v2" },
}] });
// @ts-expect-error Exact compatibility tokens are part of the consumer contract.
assembly.bindFactory(incompatibleToken, async () => { throw new Error("type-only fixture"); });
const unknownCapability = defineModule({ ...security, provides: [{
  ...security.provides[0], capabilityId: "agent-runtime/undeclared-capability",
}] });
// @ts-expect-error Only declared consumer capability IDs can be bound.
assembly.bindFactory(unknownCapability, async () => { throw new Error("type-only fixture"); });
assembly.bindFactory(runtimeSetupDeclarations[6], async (dependencies) => {
  // @ts-expect-error A root factory cannot request an undeclared slot.
  void dependencies.undeclaredSlot;
  const authorization: RuntimeSetupCapabilities["agent-runtime/codex-authorization"]["value"] = dependencies["authorize-setup-inspection"];
  void authorization;
  return { instance: undefined, capabilities: {} };
});
// @ts-expect-error Capability values retain their owner-local type.
const wrongValue: RuntimeSetupCapabilities["agent-runtime/codex-authorization"]["value"] = "not authorization";
void wrongValue;
