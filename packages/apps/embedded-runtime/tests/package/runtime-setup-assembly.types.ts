import { assemblyFor, declareModule, defineContract } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { createDefaultAgentRuntimeHost, type AgentRuntimeHost,
// @ts-expect-error Internal attempt injection is not part of the package composition entrypoint.
createRuntimeSetupAttempt } from "../../dist/composition.js";
void createRuntimeSetupAttempt;
import { bindRuntimeSetup, createRuntimeSetupFactories, runtimeSetupDeclarations,
  type RuntimeSetupCapabilities } from "../../dist/composition/runtime-setup-assembly.js";

// Compiled by the registered runtime test; never executed as a bootstrap.
export async function consumerContract(): Promise<AgentRuntimeHost> {
  // @ts-expect-error The public default factory accepts no selection or factory injection.
  void createDefaultAgentRuntimeHost({ factories: createRuntimeSetupFactories(process.platform) });
  const pending: Promise<AgentRuntimeHost> = createDefaultAgentRuntimeHost();
  // @ts-expect-error The private composition entry must be awaited.
  const synchronous: AgentRuntimeHost = pending;
  void synchronous;
  const awaited: AgentRuntimeHost = await pending;
  const bindings = bindRuntimeSetup(assemblyFor<RuntimeSetupCapabilities>(), createRuntimeSetupFactories(process.platform), (host) => {
    const captured: AgentRuntimeHost = host;
    void captured;
  });
  void bindings;
  return awaited;
}

const assembly = assemblyFor<RuntimeSetupCapabilities>();
const security = runtimeSetupDeclarations[0];
const IncompatibleAuthorization = defineContract<unknown>()({ id: "agent-runtime/codex-authorization", revision: 2 });
const UndeclaredCapability = defineContract<unknown>()({ id: "agent-runtime/undeclared-capability", revision: 1 });
const incompatibleToken = declareModule({ moduleId: security.moduleId, implementationId: security.implementationId,
  owner: security.owner, provides: [IncompatibleAuthorization.provide()], slots: [] });
// @ts-expect-error Exact compatibility tokens are part of the consumer contract.
assembly.bindFactory(incompatibleToken, async () => { throw new Error("type-only fixture"); });
const unknownCapability = declareModule({ moduleId: security.moduleId, implementationId: security.implementationId,
  owner: security.owner, provides: [UndeclaredCapability.provide()], slots: [] });
// @ts-expect-error Only declared consumer capability IDs can be bound.
assembly.bindFactory(unknownCapability, async () => { throw new Error("type-only fixture"); });
const IncompatibleSlot = defineContract<unknown>()({ id: "agent-runtime/codex-authorization", revision: 2 });
const incompatibleSlot = declareModule({ moduleId: "agent-runtime/consumer", implementationId: "agent-runtime/consumer/default",
  owner: security.owner, provides: [], slots: [IncompatibleSlot.slot("authorize", required())] });
// @ts-expect-error A slot of another revision cannot bind under the consumer map.
assembly.bindFactory(incompatibleSlot, async () => { throw new Error("type-only fixture"); });
declareModule({ moduleId: "agent-runtime/handwritten", implementationId: "agent-runtime/handwritten/default", owner: security.owner,
  // @ts-expect-error A declaration never spells compatibility by hand.
  provides: [{ capabilityId: "agent-runtime/codex-authorization", compatibility: { family: "exact", familyVersion: 1, token: "agent-runtime/codex-authorization/r1" } }], slots: [] });
// @ts-expect-error A declaration spec never carries a wire discriminator.
declareModule({ kind: "get-modular.module-declaration", moduleId: "agent-runtime/discriminated", implementationId: "agent-runtime/discriminated/default", owner: security.owner, provides: [], slots: [] });
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
