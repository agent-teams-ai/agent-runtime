import { types as utilTypes } from "node:util";
import { createHostHttpAdmissionGuard } from "./host-http-admission-guard.js";
import type { HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HttpEgressBrokerPorts } from "./http-egress-ports.js";
import { createStrictHttpEgressBroker } from "./strict-http-egress-broker.js";
import { issueHostHttpIngressAuthorization } from "./host-http-ingress-authorization.js";
import type { StrictHttpRequest } from "./strict-http-request.js";
import { boundedHttpOpaque } from "./http-ingress-validation.js";

export type HostHttpEgressSessionDependencies = Omit<HttpEgressBrokerPorts, "guard">;
type SessionIdentity = HostHttpEgressSessionDependencies["identity"];
type AuthenticatedSession = Readonly<{
  nativeBearerToken(): string;
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
  close(): void;
}>;
type PreparedAuthenticatedSession = Readonly<{
  nativeBearerToken(): string;
  bind(this: PreparedAuthenticatedSession, dependencies: HostHttpEgressSessionDependencies): AuthenticatedSession;
  close(): void;
}>;

const rejected = (): TypeError => new TypeError("Host HTTP staged session rejected");
const identityFields = ["operationId", "attemptId", "custodyId", "hostBootId", "liveProcessSessionIdentity"] as const;

// Read only inert own data. In particular, identity validation cannot invoke a
// getter/proxy that closes or reenters the one-use binding while it is checked.
const snapshotData = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {throw rejected();}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {throw rejected();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.freeze(Object.fromEntries(Reflect.ownKeys(descriptors).map(key => {
    if (typeof key !== "string") {throw rejected();}
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {throw rejected();}
    return [key, descriptor.value];
  })));
};

const snapshotIdentity = (value: unknown): SessionIdentity => {
  const data = snapshotData(value);
  if (Object.keys(data).length !== identityFields.length
    || !boundedHttpOpaque(data.operationId) || !boundedHttpOpaque(data.attemptId)
    || !boundedHttpOpaque(data.custodyId) || !boundedHttpOpaque(data.hostBootId)
    || typeof data.liveProcessSessionIdentity !== "object" || data.liveProcessSessionIdentity === null) {throw rejected();}
  // This is an opaque owner object. Never inspect, freeze or clone it.
  return Object.freeze({operationId: data.operationId, attemptId: data.attemptId,
    custodyId: data.custodyId, hostBootId: data.hostBootId,
    liveProcessSessionIdentity: data.liveProcessSessionIdentity});
};

const snapshotDependencies = (value: HostHttpEgressSessionDependencies): HostHttpEgressSessionDependencies => {
  const data = snapshotData(value);
  return Object.freeze({...data, identity: snapshotIdentity(data.identity)}) as HostHttpEgressSessionDependencies;
};

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
  try {
    const broker = createStrictHttpEgressBroker(Object.freeze({...dependencies, guard}), authenticateIngress);
    return Object.freeze({execute: broker.execute, close: guard.close});
  } catch (error) {guard.close(); throw error;}
};

/** Raw private session retained for deterministic transport/authority fixtures.
 * It does not authenticate ingress or qualify a production listener.
 */
export const createHostHttpEgressSession = (dependencies: HostHttpEgressSessionDependencies) =>
  createSession(dependencies);

/** Private explicit post-claim allocation, after preparation/listener custody.
 * Issue before rendering the native plan/fingerprint; bind the SAME ingress once
 * journal/container dependencies are ready. Issuance opens no HTTP admission.
 * The available operation/attempt/custody/Host/opaque session identity is fixed
 * now; this handle is never a product factory dependency or a caller capability.
 * Returned token strings are sensitive native input and cannot be zeroized by JS.
 */
export const prepareAuthenticatedHostHttpEgressSession = (input: SessionIdentity): PreparedAuthenticatedSession => {
  const identity = snapshotIdentity(input);
  const ingress = issueHostHttpIngressAuthorization();
  let used = false; let closed = false;
  let session: ReturnType<typeof createSession> | undefined;
  const close = (): void => {
    closed = true;
    try {session?.close();} finally {ingress.close();}
  };
  const prepared: PreparedAuthenticatedSession = Object.freeze({
    nativeBearerToken: ingress.nativeBearerToken,
    bind(this: PreparedAuthenticatedSession, dependencies: HostHttpEgressSessionDependencies): AuthenticatedSession {
      if (this !== prepared || used || closed) {close(); throw rejected();}
      used = true;
      try {
        const fixed = snapshotDependencies(dependencies);
        if (identityFields.some(field => fixed.identity[field] !== identity[field])) {throw rejected();}
        const bound = createSession(Object.freeze({...fixed, identity}), ingress.authenticate);
        session = bound;
        if (closed) {throw rejected();}
        return Object.freeze({
          nativeBearerToken: ingress.nativeBearerToken,
          async execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt> {
            try {
              const receipt = await bound.execute(operation);
              if (receipt.outcome !== "completed") {close();}
              return receipt;
            } catch (error) {close(); throw error;}
          },
          close,
        });
      } catch {close(); throw rejected();}
    },
    close,
  });
  return prepared;
};

/** Ordinary post-claim open retains its token/execute/close API and delegates to
 * the same one-use binding. No socket, provider process or route is created here.
 */
export const openAuthenticatedHostHttpEgressSession = (dependencies: HostHttpEgressSessionDependencies) => {
  const fixed = snapshotDependencies(dependencies);
  return prepareAuthenticatedHostHttpEgressSession(fixed.identity).bind(fixed);
};
