import { types as utilTypes } from "node:util";
import { createHostHttpAdmissionGuard } from "./host-http-admission-guard.js";
import type { HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HttpEgressBrokerPorts } from "./http-egress-ports.js";
import { createStrictHttpEgressBroker } from "./strict-http-egress-broker.js";
import { issueHostHttpIngressAuthorization } from "./host-http-ingress-authorization.js";
import type { StrictHttpRequest } from "./strict-http-request.js";
import { boundedHttpOpaque } from "./http-ingress-validation.js";

export type HostHttpEgressSessionDependencies = Omit<HttpEgressBrokerPorts, "guard">;
export type HostHttpSessionIdentity = HostHttpEgressSessionDependencies["identity"];
export type HostHttpAuthenticatedSession = Readonly<{
  nativeBearerToken(): string;
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
  close(): void;
}>;
export type PreparedHostHttpAuthenticatedSession = Readonly<{
  nativeBearerToken(): string;
  bind(this: PreparedHostHttpAuthenticatedSession, dependencies: HostHttpEgressSessionDependencies): HostHttpAuthenticatedSession;
  close(): void;
}>;

const rejected = (): TypeError => new TypeError("Host HTTP staged session rejected");
// A later replacement of Function.prototype.bind must fail closed before native ingress.
const initialBindDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "bind");

const identityFields = ["operationId", "attemptId", "custodyId", "hostBootId", "liveProcessSessionIdentity"] as const;

// Read only inert own data. In particular, identity validation cannot invoke a
// getter/proxy that closes or reenters the one-use binding while it is checked.
const snapshotData = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {throw rejected();}
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {throw rejected();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.freeze(Object.fromEntries(Reflect.ownKeys(descriptors).map(key => {
    if (typeof key !== "string") {throw rejected();}
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {throw rejected();}
    return [key, descriptor.value];
  })));
};

/** A checked method may shadow Function.prototype.bind with an accessor.
 * Refuse the shadow without reading it; ordinary class/async functions inherit
 * the native bind through their prototype chain. */ 
const hasIntrinsicBind = (value: unknown): boolean => {
  if (typeof value !== "function" || utilTypes.isProxy(value)) {return false;}
  let current: object | null = value;
  while (current !== null && current !== Function.prototype) {
    if (utilTypes.isProxy(current) || Object.getOwnPropertyDescriptor(current, "bind") !== undefined) {return false;}
    const parent: unknown = Object.getPrototypeOf(current);
    if (parent !== null && typeof parent !== "object" && typeof parent !== "function") {return false;}
    current = parent;
  }
  return current === Function.prototype;
};

/** Owner port methods may be defined on class prototypes, but accessors and
 * proxies must not execute during admission. Inspect descriptors, never getters. */
const inertMethod = (owner: unknown, method: string): boolean => {
  if ((typeof owner !== "object" && typeof owner !== "function") || owner === null || utilTypes.isProxy(owner)) {
    return false;
  }
  let current: object | null = owner;
  while (current !== null && current !== Object.prototype && current !== Function.prototype) {
    if (utilTypes.isProxy(current)) {return false;}
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor !== undefined) {return "value" in descriptor && hasIntrinsicBind(descriptor.value);}
    const parent: unknown = Object.getPrototypeOf(current);
    if (parent !== null && typeof parent !== "object" && typeof parent !== "function") {return false;}
    current = parent;
  }
  return false;
};

/** A structural method bag is not a qualified owner. Refuse missing/unsafe
 * ports and pin their callable identities before native ingress. Otherwise a
 * mutable dependency bag could replace a checked method after admission. */
const snapshotBrokerOwners = (dependencies: HostHttpEgressSessionDependencies): Pick<
  HostHttpEgressSessionDependencies, "ids" | "resolver" | "evidence"> => {
  const owners = snapshotData(dependencies);
  if (!inertMethod(owners.ids, "fresh") || !inertMethod(owners.resolver, "resolve")
    || !inertMethod(owners.evidence, "digest") || !inertMethod(owners.evidence, "record")) {throw rejected();}
  // All four methods passed inert descriptor inspection; also reject a global bind replacement.
  // This is fail-closed rather than calling a possibly patched Function.prototype method.
  if (initialBindDescriptor === undefined || typeof initialBindDescriptor.value !== "function"
    || Object.getOwnPropertyDescriptor(Function.prototype, "bind")?.value !== initialBindDescriptor.value) {
    throw rejected();
  }
  const {ids, resolver, evidence} = dependencies;
  return Object.freeze({
    ids: Object.freeze({fresh: ids.fresh.bind(ids)}),
    resolver: Object.freeze({resolve: resolver.resolve.bind(resolver)}),
    evidence: Object.freeze({digest: evidence.digest.bind(evidence), record: evidence.record.bind(evidence)}),
  });
};

const snapshotIdentity = (value: unknown): HostHttpSessionIdentity => {
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
  return Object.freeze({...value, identity: snapshotIdentity(data.identity)});
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
  const fixed = snapshotDependencies(dependencies);
  const owners = snapshotBrokerOwners(fixed);
  const guard = createHostHttpAdmissionGuard({operationId: fixed.identity.operationId,
    attemptId: fixed.identity.attemptId, custodyId: fixed.identity.custodyId,
    hostGeneration: fixed.identity.hostBootId,
    liveProcessSessionIdentity: fixed.identity.liveProcessSessionIdentity});
  try {
    const broker = createStrictHttpEgressBroker(Object.freeze({...fixed, ...owners, guard}), authenticateIngress);
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
export const prepareAuthenticatedHostHttpEgressSession = (input: HostHttpSessionIdentity): PreparedHostHttpAuthenticatedSession => {
  const identity = snapshotIdentity(input);
  const ingress = issueHostHttpIngressAuthorization();
  let used = false; let closed = false;
  let session: ReturnType<typeof createSession> | undefined;
  const close = (): void => {
    closed = true;
    try {session?.close();} finally {ingress.close();}
  };
  const isClosed = (): boolean => closed;
  const prepared: PreparedHostHttpAuthenticatedSession = Object.freeze({
    nativeBearerToken: ingress.nativeBearerToken,
    bind(this: PreparedHostHttpAuthenticatedSession, dependencies: HostHttpEgressSessionDependencies): HostHttpAuthenticatedSession {
      if (this !== prepared || used || closed) {close(); throw rejected();}
      used = true;
      try {
        const fixed = snapshotDependencies(dependencies);
        if (identityFields.some(field => fixed.identity[field] !== identity[field])) {throw rejected();}
        const bound = createSession(Object.freeze({...fixed, identity}), ingress.authenticate);
        session = bound;
        if (isClosed()) {throw rejected();}
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
