import {custodyDataRecord} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {sameDockerAuthority} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type {DockerLinuxOperationRouteAdmission, DockerLinuxOperationRouteFirstWrite} from "./docker-linux-post-claim-preparation.js";

type Admission = Parameters<DockerLinuxOperationRouteAdmission["admit"]>[0];
const apply = Reflect.apply;
const rejected = () => new TypeError("Docker native broker installed route unavailable");

/** Retains the endpoint actually handed to the installed route owner. No endpoint
 * supplier or observation body can replace this operation's successful admission.
 * This is a trusted composition join, not an independent kernel proof issuer. */
export const retainDockerNativeBrokerRoute = (input: DockerLinuxOperationRouteAdmission) => {
  const data = custodyDataRecord(input);
  if (typeof data.admit !== "function" || typeof data.releaseAfterContainerRemoval !== "function") {throw rejected();}
  const admitMethod = data.admit;
  const releaseMethod = data.releaseAfterContainerRemoval;
  const admit: DockerLinuxOperationRouteAdmission["admit"] = value => apply(admitMethod, input, [value]);
  const release: DockerLinuxOperationRouteAdmission["releaseAfterContainerRemoval"] = (...args) =>
    apply(releaseMethod, input, args);
  let entered = false;
  let retained: Readonly<{request: Admission; firstWrite: DockerLinuxOperationRouteFirstWrite}> | undefined;
  const routeAdmission: DockerLinuxOperationRouteAdmission = Object.freeze({
    async admit(value: Admission) {
      if (entered) {throw rejected();}
      entered = true;
      const request = custodyDataRecord(value);
      const fixed = Object.freeze({...request, authority: custodyDataRecord(request.authority),
        endpoint: custodyDataRecord(request.endpoint)});
      const result = await admit(fixed);
      if (result.kind === "installed") {retained = Object.freeze({request: fixed, firstWrite: result.firstWrite});}
      return result;
    },
    releaseAfterContainerRemoval: release,
  });
  return Object.freeze({routeAdmission,
    endpoint(authority: Admission["authority"], firstWrite: DockerLinuxOperationRouteFirstWrite, gateway: string): string {
      if (retained === undefined || retained.firstWrite !== firstWrite || retained.request.signal.aborted ||
        !sameDockerAuthority(authority, retained.request.authority) || retained.request.endpoint.address !== gateway) {throw rejected();}
      return `http://${retained.request.endpoint.address}:${retained.request.endpoint.port}/backend-api/codex`;
    },
  });
};
