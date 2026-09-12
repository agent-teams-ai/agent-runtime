import {createDockerProviderProcessBridge, type DockerProviderProcessInput} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type {CustodiedProviderProcess, CustodiedProviderProcessRegistry} from "../adapters/outbound/host-custody/custodied-provider-process.js";

/** One operation's existing provider registry, for explicit outer composition.
 * Opening is asynchronous; get never launches, retries, or implies containment. */
export const createDockerCustodiedProviderProcessRegistry = (): Readonly<{
  processes: CustodiedProviderProcessRegistry;
  open(input: DockerProviderProcessInput): Promise<CustodiedProviderProcess>;
}> => {
  const bridge = createDockerProviderProcessBridge();
  const open = bridge.open.bind(bridge);
  let used = false;
  let process: CustodiedProviderProcess | undefined;
  return Object.freeze({
    processes: Object.freeze({get: (custodyRef: string) => process?.custodyRef === custodyRef ? process : undefined}),
    async open(input: DockerProviderProcessInput): Promise<CustodiedProviderProcess> {
      if (used) {throw new TypeError("Docker provider registry is one-use");}
      used = true;
      process = await open(input);
      return process;
    },
  });
};
