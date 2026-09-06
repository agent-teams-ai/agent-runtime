import { DockerHttpNetworkResources, type DockerHttpNetworkResourceInput } from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import { NodeProviderProcessCustody } from "../adapters/outbound/host-custody/node-provider-process-custody.js";
import { createV4HostHttpListenerLifecycle } from "./v4-host-http-listener-lifecycle.js";

type Preparation = NonNullable<ReturnType<typeof NodeProviderProcessCustody.httpPreparation>>;
type Handoff = Parameters<Preparation["acquire"]>[0];
type Resources = Parameters<Preparation["prepareResources"]>[1];
type Journal = Parameters<DockerHttpNetworkResources["prepare"]>[0];
const {httpPreparation} = NodeProviderProcessCustody;

/** Private post-claim assembly. Native listener/accepted-connection/TLS/local-cut
 * implementations stay under Host custody; Engine operations stay under Docker.
 * The V4 reader can join this opaque network reader with the retained Host
 * projector. This factory supplies no synthetic listener/route/socket evidence,
 * resolver, receipt supplier, launch finalizer or provider execution permission. */
export const createDockerHostHttpResources = (input: Readonly<{
  host: unknown; network: DockerHttpNetworkResourceInput; hostLifecycleGenerationSha256: string;
}>) => {
  const host = httpPreparation(input.host);
  if (host === undefined) {throw new TypeError("Host HTTP resource preparation unavailable");}
  const network = new DockerHttpNetworkResources(input.network);
  const expectedGeneration = input.hostLifecycleGenerationSha256;
  if (!/^[a-f0-9]{64}$/u.test(expectedGeneration)) {throw new TypeError("Host generation unavailable");}
  const subject = input.network.subject;
  let entered = false;
  let listener: Resources["listener"] | undefined;
  const cutoff = () => {listener?.sealAdmission(); network.cutoff();};
  network.signal.addEventListener("abort", () => listener?.sealAdmission(), {once: true});
  return Object.freeze({
    networkName: network.networkName,
    observationOwner: Object.freeze({readObservation: (token: object) => network.readObservation(token)}),
    cutoff,
    async prepare(journal: Journal, handoff: Handoff, resources: Omit<Resources, "listenerLifecycle">, deadlineEpochMs: number) {
      if (entered) {throw new TypeError("Host HTTP resource preparation already entered");}
      entered = true;
      // Native Host reservation identity is acquired before any journal/Engine IO.
      const lifetime = host.acquire(handoff);
      if (lifetime.hostLifecycleGenerationSha256 !== expectedGeneration) {cutoff(); throw new TypeError("Host generation changed");}
      const proof = lifetime.committedDispatchProof;
      const current = {tenantId: proof.tenantId, projectId: proof.projectId, operationId: proof.operationId,
        attemptId: proof.attemptId, custodyId: proof.custodyId, hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId,
        effectId: proof.effectId, workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId,
        committedClaimSha256: proof.proofDigest.slice(7), acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)};
      network.assertClaim(current);
      listener = resources.listener;
      lifetime.signal.addEventListener("abort", cutoff, {once: true});
      try {
        const prepared = await network.prepare(journal, current, {signal: lifetime.signal, deadlineEpochMs});
        if (lifetime.signal.aborted || network.signal.aborted) {throw new TypeError("Host resource admission closed");}
        const result = await host.prepareResources(lifetime, {...resources,
          listenerLifecycle: createV4HostHttpListenerLifecycle({v4: journal, subject})});
        if (result.kind !== "prepared" || result.address.address !== prepared.gateway || lifetime.signal.aborted || network.signal.aborted) {
          throw new TypeError("Host listener preparation is unproven");
        }
        return result;
      } catch (error) {cutoff(); throw error;}
    },
    observeContainer: (...args: Parameters<DockerHttpNetworkResources["observeContainer"]>) => network.observeContainer(...args),
    cleanupNetwork: () => {cutoff(); return network.cleanupNetwork();},
  });
};
