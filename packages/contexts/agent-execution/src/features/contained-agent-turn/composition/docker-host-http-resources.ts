import { captureDockerHttpResourceRecord as data, subscribeDockerHttpAbort as addAbortListener, DockerHttpNetworkResources, type DockerHttpNetworkResourceInput } from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
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
  input = data(input);
  const host = httpPreparation(input.host);
  if (host === undefined) {throw new TypeError("Host HTTP resource preparation unavailable");}
  const network = new DockerHttpNetworkResources(input.network);
  const expectedGeneration = input.hostLifecycleGenerationSha256;
  if (!/^[a-f0-9]{64}$/u.test(expectedGeneration)) {throw new TypeError("Host generation unavailable");}
  const subject = network.subject;
  let entered = false;
  let sealListener: (() => void) | undefined;
  let lifetimeAbort: ReturnType<typeof addAbortListener> | undefined;
  const cutListener = () => {
    // This is only admission cutoff. A throwing native cut never becomes a
    // listener/socket closure observation; that remains with the Host owner.
    try {sealListener?.();} catch {}
  };
  const cutoff = () => {
    // Always fence the allocation slot, including a failed native listener cut.
    network.cutoff();
    lifetimeAbort?.[Symbol.dispose](); lifetimeAbort = undefined;
    cutListener();
  };
  addAbortListener(network.signal, () => {
    lifetimeAbort?.[Symbol.dispose](); lifetimeAbort = undefined;
    cutListener();
  });
  return Object.freeze({
    networkName: network.networkName,
    observationOwner: Object.freeze({readObservation: (token: object) => network.readObservation(token)}),
    cutoff,
    async prepare(journal: Journal, handoff: Handoff, resources: Omit<Resources, "listenerLifecycle">, deadlineEpochMs: number) {
      if (entered) {throw new TypeError("Host HTTP resource preparation already entered");}
      entered = true;
      try {
        // Native Host reservation identity is acquired before any journal/Engine IO.
        const lifetime = host.acquire(handoff);
        if (lifetime.hostLifecycleGenerationSha256 !== expectedGeneration) {cutoff(); throw new TypeError("Host generation changed");}
        const proof = lifetime.committedDispatchProof;
        const current = {tenantId: proof.tenantId, projectId: proof.projectId, operationId: proof.operationId,
          attemptId: proof.attemptId, custodyId: proof.custodyId, hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId,
          effectId: proof.effectId, workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId,
          committedClaimSha256: proof.proofDigest.slice(7), acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)};
        network.assertClaim(current);
        // Snapshot the cut method before the first await; mutating the caller's
        // resource bag must not redirect cutoff away from the retained listener.
        resources = data(resources);
        const recipe = data(resources.listener);
        const listener = Object.freeze({open: recipe.open.bind(resources.listener), close: recipe.close.bind(resources.listener),
          sealAdmission: recipe.sealAdmission.bind(resources.listener)});
        sealListener = listener.sealAdmission;
        const consumption = data(resources.consumption);
        const localCut = data(resources.localCut);
        const clock = data(localCut.clock);
        const fixedResources = {...resources, listener,
          consumption: Object.freeze({prepare: consumption.prepare.bind(resources.consumption)}),
          // Retain callbacks, never receiver state: time must keep advancing on
          // the borrowed Host clock even when it stores controlTime on `this`.
          localCut: {...localCut, clock: Object.freeze({read: clock.read.bind(localCut.clock),
            within: clock.within.bind(localCut.clock)}), expectedClock: data(localCut.expectedClock)}};
        lifetimeAbort = addAbortListener(lifetime.signal, cutoff);
        const prepared = await network.prepare(journal, current, {signal: lifetime.signal, deadlineEpochMs});
        if (lifetime.signal.aborted || network.signal.aborted) {throw new TypeError("Host resource admission closed");}
        const result = await host.prepareResources(lifetime, {...fixedResources,
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
