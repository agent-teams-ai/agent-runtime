import { captureDockerHttpResourceRecord as data, DockerHttpNetworkResources,
  type DockerHttpNetworkResourceInput } from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";

type Journal = Parameters<DockerHttpNetworkResources["prepare"]>[0];
type Claim = Parameters<DockerHttpNetworkResources["prepare"]>[1];
type Call = Parameters<DockerHttpNetworkResources["prepare"]>[2];
export type DockerOperationNetworkAllocation = Readonly<{networkName: string; gateway: string}>;
export type DockerOperationNetworkOwner = ReturnType<typeof createDockerOperationNetworkOwner>;

/** The operation network owner. Its only preconditions are the committed dispatch
 * proof projection and the fresh V4 ledger: it never consults a Host custody
 * reservation, an issued launch or a running container, because the network name
 * must already be bound into `NetworkMode` before the container is created.
 *
 * This owner allocates, observes membership and releases exactly one Docker
 * operation network. It opens no listener, socket, route or provider session and
 * issues no listener/route/consumption evidence; those stay with their own owners
 * and are joined in outer composition. The V4 ledger remains borrowed. */
export const createDockerOperationNetworkOwner = (input: DockerHttpNetworkResourceInput) => {
  const network = new DockerHttpNetworkResources(data(input));
  let allocation: DockerOperationNetworkAllocation | undefined;
  return Object.freeze({
    get subject() {return network.subject;},
    get networkName() {return network.networkName;},
    get signal(): AbortSignal {return network.signal;},
    /** Retained allocation facts. Absent until the Engine actually observed them;
     * a caller-supplied gateway is never accepted in their place. */
    get allocation(): DockerOperationNetworkAllocation | undefined {return allocation;},
    observationOwner: Object.freeze({readObservation: (token: object) => network.readObservation(token)}),
    readObservation: (token: object) => network.readObservation(token),
    assertClaim: (current: Claim) => {network.assertClaim(current);},
    async allocate(journal: Journal, current: Claim, call: Call): Promise<DockerOperationNetworkAllocation> {
      const prepared = await network.prepare(journal, current, call);
      allocation = Object.freeze({networkName: prepared.networkName, gateway: prepared.gateway});
      return allocation;
    },
    observeContainer: (...args: Parameters<DockerHttpNetworkResources["observeContainer"]>) => network.observeContainer(...args),
    cutoff: () => {network.cutoff();},
    cleanupNetwork: () => network.cleanupNetwork(),
  });
};
