import { types } from "node:util";
import type { HostHttpEgressSessionDependencies } from "@agent-teams/agent-execution/composition";
import { createContainedTurnHttpCredentialMaterialization,
  type ContainedTurnHttpProviderAccessOwner } from "./contained-turn-http-provider-access.js";
import { bindContainedTurnHttpRuntimeSecurity } from "./contained-turn-http-runtime-security.js";

type Materialization = Parameters<typeof createContainedTurnHttpCredentialMaterialization>[0];
type RuntimeSecurityCandidate = Parameters<typeof bindContainedTurnHttpRuntimeSecurity>[0];
const AUTHORITY_KEYS = ["providerAccess", "materializer", "runtimeSecurity", "verifier"] as const;

/** The broker session ports that have a real production owner on this revision:
 * Provider Access authorization and credential materialization, and the Runtime
 * Security Ed25519 authorization and its verifier. Disposal closes only the
 * newly created credential pairing, never PA, RS or the Host reservation. */
export type ContainedTurnHttpEgressAuthorities =
  Pick<HostHttpEgressSessionDependencies, typeof AUTHORITY_KEYS[number]> & Readonly<{dispose(): void}>;

/**
 * Every remaining broker session port, which this composition does not own.
 *
 * `identity`, `clock` and `localAuthorityCut` are replaced by the Host local cut
 * owner when it activates the session, and `journal` by the Host reservation's
 * own consumption journal, so whatever is supplied for them here never reaches
 * the broker. `route`, `providerAccessSnapshot` and `transport` do have owners:
 * `createContainedTurnHttpEgressRoute` projects the first two from a Provider
 * Access endorsement and `createContainedTurnHttpUpstreamTransport` binds the
 * implemented Node TLS adapter, but the trusted root decides when to use them,
 * so they arrive here as ordinary supplied ports. The private Linux deployment
 * assembly supplies `ids`, `resolver` and `evidence` using the Node identity/DNS
 * and PostgreSQL receipt owners, with methods bound into plain broker ports.
 *
 * `routeFirstWrite` is the one optional member: it exists only when an installed
 * exclusive route lease published its first-write authority for this operation.
 * Supplying nothing leaves the broker without a kernel cut of its own, which is
 * an honest absence rather than a silently unenforced turn.
 */
export type ContainedTurnHttpEgressBrokerPorts =
  Omit<HostHttpEgressSessionDependencies, typeof AUTHORITY_KEYS[number]>;

const invalid = (): TypeError => new TypeError("Invalid contained turn HTTP egress session ports");

/**
 * Binds the two already implemented outer ACLs into the four broker session
 * ports they own. It creates no key, listener, route or authority, and adds no
 * feature port; the owners keep their own policy reads, signer and disposal.
 */
export const bindContainedTurnHttpEgressAuthorities = (input: Readonly<{
  providerAccess: Materialization;
  createRequestDigest: ContainedTurnHttpProviderAccessOwner["createRequestDigest"];
  runtimeSecurity: RuntimeSecurityCandidate;
}>): ContainedTurnHttpEgressAuthorities => {
  const credentials = createContainedTurnHttpCredentialMaterialization(input.providerAccess, input.createRequestDigest);
  const security = bindContainedTurnHttpRuntimeSecurity(input.runtimeSecurity);
  return Object.freeze({
    providerAccess: credentials.providerAccess,
    materializer: credentials.materializer,
    runtimeSecurity: security.runtimeSecurity,
    verifier: security.verifier,
    dispose: credentials.dispose,
  });
};

/**
 * Assembles the complete session dependency record the Host reservation binds.
 * The port set is checked for exactness first: a missing or extra member fails
 * closed here instead of reaching the strict broker, and no owned authority can
 * be shadowed by a port the caller supplied under the same name.
 */
export const composeContainedTurnHttpEgressSession = (
  authorities: ContainedTurnHttpEgressAuthorities,
  ports: ContainedTurnHttpEgressBrokerPorts,
): HostHttpEgressSessionDependencies => {
  if (ports === null || typeof ports !== "object" || types.isProxy(ports) ||
      Object.getPrototypeOf(ports) !== Object.prototype) {throw invalid();}
  const supplied = Reflect.ownKeys(ports);
  const expected: readonly string[] = ["identity", "ids", "providerAccessSnapshot", "route",
    "localAuthorityCut", "journal", "resolver", "transport", "clock", "evidence"];
  const optional: readonly string[] = ["routeFirstWrite"];
  if (supplied.length < expected.length || supplied.length > expected.length + optional.length ||
      expected.some(key => !Object.hasOwn(ports, key)) ||
      supplied.some(key => typeof key !== "string" || !expected.includes(key) && !optional.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(ports))
        .some(descriptor => !("value" in descriptor) || !descriptor.enumerable)) {throw invalid();}
  for (const key of AUTHORITY_KEYS) {
    if (typeof authorities[key] !== "object" || authorities[key] === null) {throw invalid();}
  }
  return Object.freeze({...ports, providerAccess: authorities.providerAccess,
    materializer: authorities.materializer, runtimeSecurity: authorities.runtimeSecurity,
    verifier: authorities.verifier});
};
