import {DockerCustodyHttpReservation} from "./docker-custody-http-reservation.js";
import { captureDockerHttpResourceRecord as data, subscribeDockerHttpAbort as addAbortListener } from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import { createV4HostHttpListenerLifecycle } from "./v4-host-http-listener-lifecycle.js";
import type { DockerOperationNetworkAllocation, DockerOperationNetworkOwner } from "./docker-operation-network-owner.js";

type Preparation = NonNullable<ReturnType<typeof DockerCustodyHttpReservation.httpPreparation>>;
type Handoff = Parameters<Preparation["acquire"]>[0];
type Resources = Parameters<Preparation["prepareResources"]>[1];
type Journal = Parameters<typeof createV4HostHttpListenerLifecycle>[0]["v4"];
/** The listener recipe is built from the observed gateway, never from a guess. */
export type DockerHostHttpListenerResources = Omit<Resources, "listener" | "listenerLifecycle"> &
  Readonly<{listenerFor: (host: string) => Resources["listener"]}>;
const {httpPreparation} = DockerCustodyHttpReservation;


/** Private post-claim assembly of the listener and its session slots. Native
 * listener/accepted-connection/TLS/local-cut implementations stay under Host
 * custody; Engine operations stay under Docker. The operation network is NOT
 * allocated here: it is already owned and observed by the network owner, whose
 * name had to reach `NetworkMode` before the container existed. This factory
 * supplies no synthetic listener/route/socket evidence, resolver, receipt
 * supplier, launch finalizer or provider execution permission. */
export const createDockerHostHttpResources = (input: Readonly<{
  host: unknown; network: DockerOperationNetworkOwner; allocated: DockerOperationNetworkAllocation;
  hostLifecycleGenerationSha256: string;
}>) => {
  input = data(input);
  const host = httpPreparation(input.host);
  if (host === undefined) {throw new TypeError("Host HTTP resource preparation unavailable");}
  const expectedGeneration = input.hostLifecycleGenerationSha256;
  if (expectedGeneration !== host.binding.hostLifecycleGenerationSha256) {throw new TypeError("Host generation changed");}
  const network = input.network;
  const subject = network.subject;
  if (subject.imageDigest !== host.binding.imageDigest ||
    (Object.keys(host.binding.attempt) as Array<keyof typeof subject.attempt>)
      .some(key => subject.attempt[key] !== host.binding.attempt[key])) {
    throw new TypeError("Docker HTTP network launch binding conflicts");
  }
  // The gateway is the network owner's observation, not a caller assertion. A
  // structural copy of the allocation cannot redirect the listener address.
  const allocated = data(input.allocated);
  const retained = network.allocation;
  if (retained === undefined || allocated.networkName !== retained.networkName ||
    allocated.gateway !== retained.gateway || retained.networkName !== network.networkName) {
    throw new TypeError("Docker HTTP operation network allocation is unproven");
  }
  let entered = false;
  let listenerReadback: Readonly<{observe: () => unknown}> | undefined;
  let sealListener: (() => void) | undefined;
  let lifetimeAbort: ReturnType<typeof addAbortListener> | undefined;
  const cutListener = () => {
    // This is only admission cutoff. A throwing native cut never becomes a
    // listener/socket closure observation; that remains with the Host owner.
    try {sealListener?.();} catch {}
  };
  const cutoff = () => {
    // Always fence the allocation slot, including a failed native listener cut.
    host.cutoff();
    network.cutoff();
    lifetimeAbort?.[Symbol.dispose](); lifetimeAbort = undefined;
    cutListener();
  };
  addAbortListener(network.signal, () => {
    host.cutoff();
    lifetimeAbort?.[Symbol.dispose](); lifetimeAbort = undefined;
    cutListener();
  });
  return Object.freeze({
    networkName: network.networkName,
    gateway: retained.gateway,
    /** The retained recipe's own point-in-time readback, available only once the
     * listener was actually handed out. It is the listener observation owner's
     * physical source; this composition never reports endpoint facts itself. */
    get listener(): Readonly<{observe: () => unknown}> | undefined {return listenerReadback;},
    observationOwner: network.observationOwner,
    cutoff,
    async prepare(journal: Journal, handoff: Handoff, resources: DockerHostHttpListenerResources) {
      if (entered) {throw new TypeError("Host HTTP resource preparation already entered");}
      entered = true;
      try {
        // Actual Docker HTTP lifetime is acquired before any journal/Engine IO.
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
        // The recipe is produced now, from the observed gateway. No listener
        // address can be chosen before the Engine assigned the bridge address.
        const supplied = resources.listenerFor(retained.gateway);
        const recipe = data(supplied);
        const listener = Object.freeze({open: recipe.open.bind(supplied), close: recipe.close.bind(supplied),
          sealAdmission: recipe.sealAdmission.bind(supplied), observe: recipe.observe.bind(supplied)});
        sealListener = listener.sealAdmission;
        listenerReadback = Object.freeze({observe: listener.observe});
        const consumption = data(resources.consumption);
        const localCut = data(resources.localCut);
        const clock = data(localCut.clock);
        const {listenerFor: _listenerFor, ...rest} = resources;
        const fixedResources = {...rest, listener,
          consumption: Object.freeze({prepare: consumption.prepare.bind(resources.consumption)}),
          // Retain callbacks, never receiver state: time must keep advancing on
          // the borrowed Host clock even when it stores controlTime on `this`.
          localCut: {...localCut, clock: Object.freeze({read: clock.read.bind(localCut.clock),
            within: clock.within.bind(localCut.clock)}), expectedClock: data(localCut.expectedClock)}};
        lifetimeAbort = addAbortListener(lifetime.signal, cutoff);
        if (lifetime.signal.aborted || network.signal.aborted) {throw new TypeError("Host resource admission closed");}
        const result = await host.prepareResources(lifetime, {...fixedResources,
          listenerLifecycle: createV4HostHttpListenerLifecycle({v4: journal, subject})});
        if (result.kind !== "prepared" || result.address.address !== retained.gateway ||
          lifetime.signal.aborted || network.signal.aborted) {
          throw new TypeError("Host listener preparation is unproven");
        }
        return result;
      } catch (error) {cutoff(); throw error;}
    },
    observeContainer: (...args: Parameters<DockerOperationNetworkOwner["observeContainer"]>) => network.observeContainer(...args),
    cleanupResources: (deadlineEpochMs: number) => {cutoff(); return host.cleanup(deadlineEpochMs);},
    cleanupNetwork: () => {cutoff(); return network.cleanupNetwork();},
  });
};
