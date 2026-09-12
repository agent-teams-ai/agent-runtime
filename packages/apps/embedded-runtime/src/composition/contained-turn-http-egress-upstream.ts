import { snapshotRouteSelectionCurrent } from "@agent-teams/provider-access/composition";
import { createNativeHttpEgressRoute, nativeHttpRequestProfile, NodeTlsHttpEgressTransport,
  type HostHttpEgressSessionDependencies, type NodeTlsHttpEgressTransportOptions,
} from "@agent-teams/agent-execution/composition";

type Route = HostHttpEgressSessionDependencies["route"];
type Snapshot = HostHttpEgressSessionDependencies["providerAccessSnapshot"];
type Transport = HostHttpEgressSessionDependencies["transport"];

const invalid = (): TypeError => new TypeError("Invalid contained turn HTTP egress upstream projection");
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index]);

/**
 * Projects one Provider Access route endorsement into the two broker session
 * ports it owns: the upstream route and the detached Provider Access snapshot.
 *
 * Neither is derived here. The wire contract belongs to the Host's own versioned
 * profile catalog, which mints the route from an endorsed profile id, and the
 * snapshot carries Provider Access's own facts verbatim — including its opaque
 * credential binding digest, which the broker compares against the receipt and
 * which this projection must never replace with a normalized value. The
 * endorsement's route authority digest is the route receipt: it changes whenever
 * any endorsed route fact changes, so a stale route cannot be presented as
 * current. Provider Access has already refused an unavailable or revoked binding
 * before it can reach this point, and it validates the digest and generation of
 * the endorsement itself; this composition approves no policy, reads no database
 * and renders no credential.
 *
 * The endorsed descriptor must agree with the catalog exactly, and every header
 * Provider Access endorsed must be one the Host would actually forward: a name
 * outside the catalog is refused here rather than silently dropped on the wire.
 */
export const createContainedTurnHttpEgressRoute = async (input: Readonly<{
  /** The PA route selection owner's current endorsement, exactly as PA returns it. */
  current: unknown;
  /** The provider this operation was accepted for; PA's binding must agree. */
  provider: "claude" | "codex";
}>): Promise<Readonly<{route: Route; providerAccessSnapshot: Snapshot}>> => {
  const endorsement = await snapshotRouteSelectionCurrent(input.current);
  const binding = endorsement.binding; const descriptor = endorsement.descriptor;
  if (binding.provider !== input.provider || descriptor.provider !== input.provider ||
      binding.availability !== "available" || binding.revocation !== "active") {throw invalid();}
  const profile = nativeHttpRequestProfile(descriptor.id);
  if (profile === undefined || profile.provider !== descriptor.provider
    || profile.credentialMode !== descriptor.credentialMode || profile.originHost !== descriptor.originHost
    || profile.originPort !== descriptor.originPort || profile.upstreamMethod !== descriptor.upstreamMethod
    || profile.upstreamPath !== descriptor.upstreamPath
    || !sameNames(profile.credentialFieldNames, descriptor.credentialFieldNames)
    || descriptor.forwardedRequestHeaderNames.some(name =>
      !(profile.forwardedRequestHeaderNames as readonly string[]).includes(name))) {throw invalid();}
  return Object.freeze({
    route: createNativeHttpEgressRoute(descriptor.id, endorsement.routeAuthorityDigest),
    providerAccessSnapshot: Object.freeze({
      tenantId: binding.tenantId, projectId: binding.projectId, scopeDigest: binding.scopeDigest,
      accessRef: binding.accessRef, provider: binding.provider, providerAccountRef: binding.providerAccountRef,
      providerRouteRef: binding.providerRouteRef, credentialBindingRef: binding.credentialBindingRef,
      ownerAuthorityDigest: binding.credentialBindingDigest, revision: binding.bindingRevision,
      credentialGeneration: binding.credentialGeneration, availability: binding.availability,
      revocation: binding.revocation,
    }),
  });
};

/**
 * The broker's upstream transport port, bound to the implemented one-shot Node
 * TLS adapter that had no production constructor. Trust material and the three
 * resource bounds come from trusted deployment composition, exactly like the
 * route owner's tool pins: this factory reads no environment and no canary
 * report. The adapter still has no DNS, retry, redirect, pooling or resumption
 * facility, so the private deployment assembly supplies the separate Node resolver port.
 */
export const createContainedTurnHttpUpstreamTransport = (
  options: NodeTlsHttpEgressTransportOptions,
): Transport => new NodeTlsHttpEgressTransport(options);
