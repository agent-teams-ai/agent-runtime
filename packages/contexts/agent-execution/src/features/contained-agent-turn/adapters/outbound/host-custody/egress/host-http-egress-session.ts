import { createHostHttpAdmissionGuard } from "./host-http-admission-guard.js";
import type { HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HttpEgressBrokerPorts } from "./http-egress-ports.js";
import { createStrictHttpEgressBroker } from "./strict-http-egress-broker.js";
import { issueHostHttpIngressAuthorization } from "./host-http-ingress-authorization.js";
import type { StrictHttpRequest } from "./strict-http-request.js";

export type HostHttpEgressSessionDependencies = Omit<HttpEgressBrokerPorts, "guard">;

/**
 * Fixes one operation/attempt/custody/live-process identity around the single
 * HTTP broker. The guard survives successful calls and permanently closes on
 * every denial, ambiguity, incomplete close, or evidence uncertainty.
 */
const createSession = (dependencies: HostHttpEgressSessionDependencies,
  authenticateIngress?: (request: StrictHttpRequest) => StrictHttpRequest): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
  close(): void;
}> => {
  const guard = createHostHttpAdmissionGuard({operationId: dependencies.identity.operationId,
    attemptId: dependencies.identity.attemptId, custodyId: dependencies.identity.custodyId,
    hostGeneration: dependencies.identity.hostBootId,
    liveProcessSessionIdentity: dependencies.identity.liveProcessSessionIdentity});
  const broker = createStrictHttpEgressBroker(Object.freeze({...dependencies, guard}), authenticateIngress);
  return Object.freeze({execute: broker.execute, close: guard.close});
};

/** Raw private session retained for deterministic transport/authority fixtures.
 * It does not authenticate ingress or qualify a production listener.
 */
export const createHostHttpEgressSession = (dependencies: HostHttpEgressSessionDependencies) =>
  createSession(dependencies);

/** Explicit post-claim allocation for one operation-private listener. The native
 * recipe receives only nativeBearerToken(); the listener uses execute unchanged.
 * No new feature dependency, socket, provider process or route is created here.
 * Returned token strings are sensitive native input and cannot be zeroized by JS.
 */
export const openAuthenticatedHostHttpEgressSession = (dependencies: HostHttpEgressSessionDependencies) => {
  const ingress = issueHostHttpIngressAuthorization();
  let session: ReturnType<typeof createSession>;
  try {session = createSession(dependencies, ingress.authenticate);}
  catch (error) {ingress.close(); throw error;}
  const close = (): void => {session.close(); ingress.close();};
  return Object.freeze({
    nativeBearerToken: ingress.nativeBearerToken,
    async execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt> {
      try {
        const receipt = await session.execute(operation);
        if (receipt.outcome !== "completed") {close();}
        return receipt;
      } catch (error) {close(); throw error;}
    },
    close,
  });
};
