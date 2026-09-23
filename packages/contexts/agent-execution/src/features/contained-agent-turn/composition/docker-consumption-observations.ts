import {readNodeLinuxRouteNamespace, readNodeLinuxDockerCgroup,
  type DockerHostCustodyLifecycle, type LinuxExclusiveRouteOwner, type LinuxExclusiveRouteEndpoint}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type {DockerHttpConsumptionReferences} from "./node-docker-deployment-recipe.js";

export type DockerConsumptionLaunch = Parameters<DockerHostCustodyLifecycle["observeLaunch"]>[0];
export type DockerConsumptionEngineCall = Parameters<typeof readNodeLinuxDockerCgroup>[2];

/** Docker-private projection of existing owners, with no injectable observations. */
export const DockerConsumptionObservations = {
  async read(lifecycle: DockerHostCustodyLifecycle, launch: DockerConsumptionLaunch,
    route: LinuxExclusiveRouteOwner, endpoint: LinuxExclusiveRouteEndpoint, call: DockerConsumptionEngineCall):
    Promise<Omit<DockerHttpConsumptionReferences, "listenerIdentity">> {
    const observed = lifecycle.observeLaunch(launch);
    const digest = observed.journal.authoritySha256;
    if (digest === null || !/^[a-f0-9]{64}$/u.test(digest)) {throw new TypeError("Docker authority digest unavailable");}
    const networkNamespaceIdentity = readNodeLinuxRouteNamespace(route, observed.authority, endpoint);
    const cgroupIdentity = await readNodeLinuxDockerCgroup(lifecycle, launch, call);
    return Object.freeze({selectedDockerAuthorityDigest: `sha256:${digest}`, networkNamespaceIdentity, cgroupIdentity});
  }
};
