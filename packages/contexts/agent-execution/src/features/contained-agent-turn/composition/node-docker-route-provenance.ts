import {custodyDataRecord} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {createNodeDockerRouteProvenance} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";

// One private provenance registry for both recipe issuance and selection.
export const {nodeDockerRoutePolicy, retainNodeDockerRoute, selectNodeDockerRoute} =
  createNodeDockerRouteProvenance(custodyDataRecord);
export type {NodeDockerRouteSubject} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
