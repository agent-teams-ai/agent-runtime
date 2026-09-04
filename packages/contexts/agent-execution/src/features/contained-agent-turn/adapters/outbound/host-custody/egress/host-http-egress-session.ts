import { createHostHttpAdmissionGuard } from "./host-http-admission-guard.js";
import type { HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HttpEgressBrokerPorts } from "./http-egress-ports.js";
import { createStrictHttpEgressBroker } from "./strict-http-egress-broker.js";

export type HostHttpEgressSessionDependencies = Omit<HttpEgressBrokerPorts, "guard">;

/**
 * Fixes one operation/attempt/custody/live-process identity around the single
 * HTTP broker. The guard survives successful calls and permanently closes on
 * every denial, ambiguity, incomplete close, or evidence uncertainty.
 */
export const createHostHttpEgressSession = (dependencies: HostHttpEgressSessionDependencies): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
  close(): void;
}> => {
  const guard = createHostHttpAdmissionGuard({operationId: dependencies.identity.operationId,
    attemptId: dependencies.identity.attemptId, custodyId: dependencies.identity.custodyId,
    hostGeneration: dependencies.identity.hostBootId,
    liveProcessSessionIdentity: dependencies.identity.liveProcessSessionIdentity});
  const broker = createStrictHttpEgressBroker(Object.freeze({...dependencies, guard}));
  return Object.freeze({execute: broker.execute, close: guard.close});
};
